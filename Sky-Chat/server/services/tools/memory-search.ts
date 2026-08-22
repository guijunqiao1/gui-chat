/**
 * memory_search 工具 —— 跨会话对话记忆检索（RAG 场景 B）
 *
 * 历史对话（user + assistant）自动索引到 ConversationMemory 表并向量化，
 * 当用户引用过去的内容时，AI 调用本工具检索最相关的历史记忆片段。
 *
 * 评分公式：score = cosine × (importance + 0.5) × 0.98^daysAgo
 *
 * 多轮检索策略（LLM 驱动）：
 *   A. 查不到换查询（Query Rewriting）—— LLM 改写原 query
 *   B. 分解子问题（Sub-question Decomposition）—— LLM 拆分为 0-3 个子问题
 *   C. 交叉验证（Cross-validation）—— 多子问题命中聚合 + 单 query 重打分去噪
 * 触发条件：首轮 resultCount=0 或 top1.score < SCORE_THRESHOLD
 * 失败降级：LLM 调用失败时直接返回第 1 轮结果，不抛错
 */

import { prisma } from '@/server/db/client'
import { Prisma } from '@prisma/client'
import type { Tool } from './types'

// ============ 常量 ============
const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'
const CHAT_COMPLETIONS_URL = 'https://api.siliconflow.cn/v1/chat/completions'
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3'
const DEFAULT_QUERY_REWRITE_MODEL = 'deepseek-ai/DeepSeek-V3.2'
const SEARCH_TIMEOUT = 15_000
const LLM_TIMEOUT = 20_000
const SCORE_THRESHOLD = 0.35 // top1 score 低于此值或结果为空时触发重试
const MAX_RETRIES = 2 // 最多重试 2 次（总 3 轮检索）
const CROSS_VALIDATE_MIN_COS = 0.25 // 第 2 轮交叉验证的 cos 命中阈值
const CROSS_VALIDATE_MIN_COS_LOOSE = 0.2 // 第 3 轮放宽阈值
const RESCORE_DROP_THRESHOLD = 0.3 // 单 query 重打分时 cos 下降超过此比例视为噪声

// ============ 类型（文件内私有） ============
interface ScoredMemory {
  m: {
    id: string
    conversationId: string
    role: string
    content: string
    importance: number
    createdAt: Date
    embedding: unknown
  }
  score: number
  cos: number
}

interface RewriteResult {
  rewrittenQuery: string
  subQuestions: string[]
}

interface RetrievalMeta {
  rounds: number
  strategy: string
  rewrittenQuery?: string
}

// ============ 基础工具函数 ============
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function createEmbedding(query: string, apiKey: string): Promise<number[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SEARCH_TIMEOUT)

  try {
    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.RAG_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
        input: query,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Embedding API error: ${response.status}`)

    const data = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>
    }
    const embedding = data.data?.[0]?.embedding
    if (!Array.isArray(embedding) || !embedding.every((v) => typeof v === 'number')) {
      throw new Error('Embedding API returned an invalid vector')
    }
    return embedding as number[]
  } finally {
    clearTimeout(timeout)
  }
}

// ============ 多轮检索策略辅助函数 ============

/**
 * 从 LLM 输出中提取 JSON 对象，容错处理 ```json fence 和模型前后多余文本
 */
function extractJSON(content: string): Record<string, unknown> {
  let s = content.trim()
  // 剥 ```json ... ``` 或 ``` ... ```
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  // 截取首个 { 到末尾 }，容错模型前后多余文本
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) {
    s = s.slice(start, end + 1)
  }
  return JSON.parse(s)
}

/**
 * 一次性 LLM 调用，返回解析后的 JSON 对象
 * 沿用 createEmbedding 的 fetch + AbortController 模式，零新依赖
 */
async function callLLMJSON(
  systemPrompt: string,
  userPrompt: string,
  apiKey: string
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT)

  try {
    const res = await fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.RAG_QUERY_REWRITE_MODEL || DEFAULT_QUERY_REWRITE_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 512,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`LLM API error: ${res.status}`)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('LLM returned empty content')
    return extractJSON(content)
  } finally {
    clearTimeout(timeout)
  }
}

const REWRITE_SYSTEM_PROMPT = `You are a retrieval query optimizer for a personal long-term memory store.
Given a user's natural-language query that failed to retrieve relevant memories, your job is to:
1. Rewrite the query into a clearer, more search-friendly form (preserve key entities, dates, names).
2. Decompose it into 0-3 atomic sub-questions, each independently retrievable.
Return STRICT JSON only, no markdown, no explanation.
Schema: {"rewrittenQuery": string, "subQuestions": string[]}
Rules:
- rewrittenQuery MUST be in the SAME language as the input.
- subQuestions must each be self-contained (no "it"/"that" pronouns).
- If the query is already simple, return empty subQuestions array.
- Output ONLY the JSON object.`

/**
 * 一次 LLM 调用同时完成 query 改写 + 子问题分解
 */
async function rewriteQuery(
  originalQuery: string,
  apiKey: string
): Promise<RewriteResult> {
  const userPrompt = `Original query: ${originalQuery}\n\nReturn JSON now.`
  const obj = await callLLMJSON(REWRITE_SYSTEM_PROMPT, userPrompt, apiKey)

  const rewritten = obj.rewrittenQuery
  const subsRaw = obj.subQuestions

  const rewrittenQuery =
    typeof rewritten === 'string' && rewritten.trim() ? rewritten.trim() : originalQuery

  let subQuestions: string[] = []
  if (Array.isArray(subsRaw)) {
    subQuestions = subsRaw
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, 3)
  }

  return { rewrittenQuery, subQuestions }
}

/**
 * 单轮检索：query → embedding → 打分 → 排序 → 切片
 * 从原 execute 抽出，便于多轮复用同一份 memories
 */
async function searchOnce(
  query: string,
  apiKey: string,
  memories: ScoredMemory['m'][],
  now: number,
  topK: number
): Promise<ScoredMemory[]> {
  const qVec = await createEmbedding(query, apiKey)
  const scored: ScoredMemory[] = memories
    .map((m) => {
      const vec = m.embedding as unknown as number[]
      const cos = cosineSimilarity(qVec, vec)
      const daysAgo = Math.max(0, (now - m.createdAt.getTime()) / 86_400_000)
      const timeDecay = Math.pow(0.98, daysAgo)
      const score = cos * (0.5 + m.importance) * timeDecay
      return { m, score, cos }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  return scored.slice(0, topK)
}

/**
 * 交叉验证：多子问题命中聚合
 * 保留被 >= minHitQueries 个子问题命中的记忆，按累计 score 降序
 */
function crossValidate(
  byQuery: ScoredMemory[][],
  opts: { minHitQueries: number; minCosThreshold: number }
): ScoredMemory[] {
  const { minHitQueries, minCosThreshold } = opts
  const map = new Map<
    string,
    {
      m: ScoredMemory['m']
      sumScore: number
      hitCount: number
      bestCos: number
    }
  >()

  for (const hits of byQuery) {
    for (const h of hits) {
      const entry = map.get(h.m.id) ?? {
        m: h.m,
        sumScore: 0,
        hitCount: 0,
        bestCos: 0,
      }
      entry.sumScore += h.score
      entry.bestCos = Math.max(entry.bestCos, h.cos)
      if (h.cos >= minCosThreshold) entry.hitCount += 1
      map.set(h.m.id, entry)
    }
  }

  return [...map.values()]
    .filter((e) => e.hitCount >= minHitQueries)
    .sort((a, b) => b.sumScore - a.sumScore)
    .map((e) => ({ m: e.m, score: e.sumScore, cos: e.bestCos }))
}

/**
 * 单 query 重打分去噪：用改写后 query 对原 hits 重新算 cos
 * 若 newCos < oldCos * (1 - dropThreshold) 视为噪声剔除
 */
async function reScoreWithQuery(
  hits: ScoredMemory[],
  probeQuery: string,
  apiKey: string,
  dropThreshold: number
): Promise<ScoredMemory[]> {
  if (hits.length === 0) return []
  const qVec = await createEmbedding(probeQuery, apiKey)

  return hits
    .map((h) => {
      const vec = h.m.embedding as unknown as number[]
      const newCos = cosineSimilarity(qVec, vec)
      const daysAgo = Math.max(0, (Date.now() - h.m.createdAt.getTime()) / 86_400_000)
      const timeDecay = Math.pow(0.98, daysAgo)
      const newScore = newCos * (0.5 + h.m.importance) * timeDecay
      return { m: h.m, score: newScore, cos: newCos, oldCos: h.cos }
    })
    .filter((s) => s.cos >= s.oldCos * (1 - dropThreshold))
    .sort((a, b) => b.score - a.score)
    .map(({ m, score, cos }) => ({ m, score, cos }))
}

/**
 * 格式化最终输出 JSON
 * meta 仅在触发重试时出现，前端不读，向后兼容
 */
function formatResult(
  hits: ScoredMemory[],
  now: number,
  meta?: RetrievalMeta
): string {
  const base = meta ? { meta } : {}
  if (hits.length === 0) {
    return JSON.stringify({
      content: '未在用户历史对话中检索到相关记忆。',
      sources: [],
      resultCount: 0,
      ...base,
    })
  }

  const sources = hits.map((s) => ({
    score: Number(s.score.toFixed(4)),
    role: s.m.role,
    content: s.m.content,
    importance: Number(s.m.importance.toFixed(2)),
    daysAgo: Number(
      Math.max(0, (now - s.m.createdAt.getTime()) / 86_400_000).toFixed(1)
    ),
  }))

  const content = hits
    .map(
      (s, i) =>
        `[${i + 1}] ${s.m.role === 'user' ? '用户' : 'AI'}：${s.m.content}`
    )
    .join('\n\n')

  return JSON.stringify({ content, sources, resultCount: hits.length, ...base })
}

// ============ 工具定义 ============
export function createMemorySearchTool(
  userId: string,
  apiKey: string,
  currentConversationId?: string
): Tool {
  return {
    name: 'memory_search',
    description:
      '检索当前用户所有历史对话中与问题最相关的记忆片段（跨会话长期记忆）。当用户提到「我之前说过…/之前那个…/你还记得吗」或任何涉及过去偏好、历史背景的问题时优先调用。参数 query 必须是完整的自然语言问题。本工具支持多轮检索：首轮未命中时会自动改写并拆解子问题重试。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要在历史记忆中检索的自然语言问题',
        },
        top_k: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: '返回前 N 条记忆，默认 5',
        },
      },
      required: ['query'],
    },
    execute: async (args): Promise<string> => {
      const query = args.query
      if (typeof query !== 'string' || !query.trim()) {
        return JSON.stringify({
          error: '检索关键词不能为空',
          sources: [],
          resultCount: 0,
        })
      }

      // args 是 Record<string, unknown>，top_k 类型为 unknown，
      // 直接 ?? 5 会得到 {} 类型而非 number，Math.min 会拒绝。
      // 用 typeof 守卫做类型收窄，与上面 query 的处理方式保持一致。
      const rawTopK = args.top_k
      const topK = Math.min(typeof rawTopK === 'number' ? rawTopK : 5, 20)

      try {
        // 一次性 DB 取数，所有重试轮次复用同一份 memories
        // Prisma 6 的 Json 字段非空过滤要用专门的 DbNull 引用。
        // 注意：JsonNullableFilter 上下文下不能直接写 { embedding: Prisma.DbNull }，
        // 必须用 { equals: Prisma.DbNull } 显式包裹，否则 TS 报 DbNull 不可赋值。
        const rawMemories = await prisma.conversationMemory.findMany({
          where: {
            userId,
            NOT: { embedding: { equals: Prisma.DbNull } },
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })

        const now = Date.now()
        // 应用层过滤当前会话（移到入口，避免每轮重复过滤）
        const memories = rawMemories.filter(
          (m) => m.conversationId !== currentConversationId
        )

        // ===== 第 1 轮：原 query 检索 =====
        const hits1 = await searchOnce(query.trim(), apiKey, memories, now, topK)
        const needRetry =
          hits1.length === 0 || hits1[0].score < SCORE_THRESHOLD

        // 首轮直接命中：零额外开销，行为与改造前一致
        if (!needRetry) {
          return formatResult(hits1, now)
        }

        // ===== 重试编排：LLM 改写 + 子问题并行检索 + 交叉验证 =====
        let bestHits = hits1
        let meta: RetrievalMeta | undefined

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            const rewrite = await rewriteQuery(query.trim(), apiKey)
            const queries = [
              rewrite.rewrittenQuery,
              ...rewrite.subQuestions,
            ].filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
            if (queries.length === 0) break

            // 并行检索，每路扩大候选到 topK*2 便于交叉验证
            const byQuery = await Promise.all(
              queries.map((q) => searchOnce(q, apiKey, memories, now, topK * 2))
            )

            let hits: ScoredMemory[]
            if (rewrite.subQuestions.length >= 2) {
              // 多子问题路径：交叉验证
              const minHit = attempt === 1 ? 2 : 1
              const minCos =
                attempt === 1 ? CROSS_VALIDATE_MIN_COS : CROSS_VALIDATE_MIN_COS_LOOSE
              hits = crossValidate(byQuery, {
                minHitQueries: minHit,
                minCosThreshold: minCos,
              })
            } else {
              // 单 query 退化路径：用改写后 query 重打分去噪
              hits = await reScoreWithQuery(
                byQuery[0] ?? bestHits,
                rewrite.rewrittenQuery,
                apiKey,
                RESCORE_DROP_THRESHOLD
              )
            }

            meta = {
              rounds: attempt + 1,
              strategy:
                rewrite.subQuestions.length >= 2
                  ? 'rewrite+subquery+crossvalidate'
                  : 'rewrite+rescore',
              rewrittenQuery: rewrite.rewrittenQuery,
            }

            // 永不比第 1 轮更差：仅在更优时替换
            if (
              hits.length > 0 &&
              (bestHits.length === 0 || hits[0].score > bestHits[0].score)
            ) {
              bestHits = hits
            }

            // 已达标可提前结束
            if (
              bestHits.length > 0 &&
              bestHits[0].score >= SCORE_THRESHOLD
            ) {
              break
            }
          } catch (err) {
            // LLM 调用或解析失败：降级返回当前 bestHits
            console.error(
              '[MemorySearch] rewrite attempt',
              attempt,
              'failed:',
              err instanceof Error ? err.message : err
            )
            break
          }
        }

        return formatResult(bestHits, now, meta)
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '记忆检索失败'
        console.error('[MemorySearch] Search error:', message)
        return JSON.stringify({
          error: message,
          sources: [],
          resultCount: 0,
        })
      }
    },
  }
}
