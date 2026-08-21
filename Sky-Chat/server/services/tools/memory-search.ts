/**
 * memory_search 工具 —— 跨会话对话记忆检索（RAG 场景 B）
 *
 * 历史对话（user + assistant）自动索引到 ConversationMemory 表并向量化，
 * 当用户引用过去的内容时，AI 调用本工具检索最相关的历史记忆片段。
 *
 * 评分公式：score = cosine × (importance + 0.5) × 0.98^daysAgo
 */

import { prisma } from '@/server/db/client'
import { Prisma } from '@prisma/client'
import type { Tool } from './types'

const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3'
const SEARCH_TIMEOUT = 15_000

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

export function createMemorySearchTool(
  userId: string,
  apiKey: string,
  currentConversationId?: string
): Tool {
  return {
    name: 'memory_search',
    description:
      '检索当前用户所有历史对话中与问题最相关的记忆片段（跨会话长期记忆）。当用户提到「我之前说过…/之前那个…/你还记得吗」或任何涉及过去偏好、历史背景的问题时优先调用。参数 query 必须是完整的自然语言问题。',
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

      try {
        const qVec = await createEmbedding(query.trim(), apiKey)

        // 查询该用户所有记忆（排除当前会话）
        // Prisma 6 的 Json 字段非空过滤要用专门的 DbNull 引用，
        // 写 { not: null } 会被推到 JsonNullableFilter 上下文触发 TS 类型错误。
        // 最稳妥写法：用 Prisma.DbNull 显式标记 JSON 类型的 null 值。
        const allMemories = await prisma.conversationMemory.findMany({
          where: {
            userId,
            NOT: { embedding: Prisma.DbNull },
          },
          orderBy: { createdAt: 'desc' },
          take: 500,
        })

        // 应用层打分：cosine × (importance + 0.5) × timeDecay
        const now = Date.now()
        const scored = allMemories
          .filter((m) => m.conversationId !== currentConversationId)
          .map((m) => {
            const vec = m.embedding as unknown as number[]
            const cos = cosineSimilarity(qVec, vec)
            const daysAgo = Math.max(0, (now - m.createdAt.getTime()) / 86_400_000)
            const timeDecay = Math.pow(0.98, daysAgo)
            const score = cos * (0.5 + m.importance) * timeDecay
            return { m, score }
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)

        const topK = Math.min(args.top_k ?? 5, 20)
        const hits = scored.slice(0, topK)

        if (hits.length === 0) {
          return JSON.stringify({
            content: '未在用户历史对话中检索到相关记忆。',
            sources: [],
            resultCount: 0,
          })
        }

        const sources = hits.map((s) => ({
          score: Number(s.score.toFixed(4)),
          role: s.m.role,
          content: s.m.content,
          importance: Number(s.m.importance.toFixed(2)),
          daysAgo: Number((s.score > 0 ? (now - s.m.createdAt.getTime()) / 86_400_000 : 0).toFixed(1)),
        }))

        const content = hits
          .map(
            (s, i) =>
              `[${i + 1}] ${s.m.role === 'user' ? '用户' : 'AI'}：${s.m.content}`
          )
          .join('\n\n')

        return JSON.stringify({ content, sources, resultCount: hits.length })
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
