/**
 * 对话记忆索引器（RAG 场景 B）
 *
 * 将消息切片 → 向量化 → 写入 ConversationMemory 表。
 * - 幂等：已索引过的 messageId 直接跳过
 * - 异步非阻塞：由调用方 fire-and-forget
 * - 自包含：内置 embedding + 切片逻辑，不依赖外部服务模块
 */

import { prisma } from '@/server/db/client'

const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3'
const EMBEDDING_TIMEOUT = 15_000

export interface IndexMemoryParams {
  userId: string
  conversationId: string
  messageId?: string
  role: 'user' | 'assistant'
  content: string
  apiKey?: string
}

/** 简单递归切片：段落 → 换行 → 固定长度 */
function splitText(text: string, maxChars = 600, overlap = 80): string[] {
  const src = (text ?? '').trim()
  if (!src) return []
  if (src.length <= maxChars) return [src]

  const chunks: string[] = []
  const paragraphs = src.split(/\n\n+/)

  let current = ''
  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // 段落本身超长：硬切
      if (current) {
        chunks.push(current)
        current = current.slice(-overlap)
      }
      let start = 0
      while (start < para.length) {
        const end = Math.min(start + maxChars, para.length)
        const piece = para.slice(start, end)
        if (current) {
          chunks.push(current + piece)
          current = piece.slice(-overlap)
        } else {
          chunks.push(piece)
        }
        start = end
      }
      continue
    }
    const candidate = current ? current + '\n\n' + para : para
    if (candidate.length <= maxChars) {
      current = candidate
    } else {
      if (current) chunks.push(current)
      current = overlap > 0 ? current.slice(-overlap) + '\n\n' + para : para
    }
  }
  if (current) chunks.push(current)
  return chunks.filter((c) => c.trim().length > 0)
}

/** 调 SiliconFlow /embeddings 批量向量化 */
async function createEmbeddings(
  texts: string[],
  apiKey: string
): Promise<number[][]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT)

  try {
    const response = await fetch(EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.RAG_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
        input: texts,
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Embedding API error: ${response.status}`)
    }
    const data = (await response.json()) as {
      data?: Array<{ embedding?: unknown }>
    }
    const result: number[][] = []
    for (const item of data.data ?? []) {
      if (Array.isArray(item.embedding) && item.embedding.every((v) => typeof v === 'number')) {
        result.push(item.embedding as number[])
      }
    }
    return result
  } finally {
    clearTimeout(timeout)
  }
}

/** 简单启发式重要性打分 0~1 */
function estimateImportance(role: 'user' | 'assistant', text: string): number {
  let score = 0.4
  if (text.length > 200) score += 0.2
  if (text.length > 800) score += 0.15
  if (role === 'user') score += 0.05
  if (/(我叫|我是|我的(名字|电话|邮箱|公司|住址|生日))/.test(text)) score += 0.15
  if (/(v\d+|Python|Node\.js|Java|TypeScript|C\+\+|Rust)/i.test(text)) score += 0.08
  if (/(出差|旅行|旅游|去了|住在)/.test(text)) score += 0.08
  return Math.min(1, score)
}

/**
 * 索引一条消息（fire-and-forget，不抛异常到调用方主流程）
 */
export async function indexMemory(params: IndexMemoryParams): Promise<void> {
  const { userId, conversationId, messageId, role, content, apiKey } = params
  const text = (content ?? '').trim()
  if (text.length < 6) return

  // 幂等：已索引过的消息跳过
  if (messageId) {
    const exists = await prisma.conversationMemory
      .count({ where: { messageId } })
      .catch(() => 0)
    if (exists > 0) return
  }

  const key = apiKey || process.env.SILICONFLOW_API_KEY
  if (!key) {
    console.warn('[MemoryIndexer] No API key, skipping indexing')
    return
  }

  const chunks = splitText(text)
  if (chunks.length === 0) return

  const embeddings = await createEmbeddings(chunks, key).catch((err) => {
    console.error('[MemoryIndexer] Embedding failed:', err.message)
    return [] as number[][]
  })
  if (embeddings.length !== chunks.length) return

  const importance = estimateImportance(role, text)
  const rows = chunks.map((c, i) => ({
    userId,
    conversationId,
    messageId: messageId ?? null,
    role,
    chunkIndex: i,
    content: c,
    embedding: embeddings[i] as unknown as import('@prisma/client').Prisma.InputJsonValue,
    tokenCount: Math.ceil(c.length / 2),
    importance,
  }))

  await prisma.conversationMemory
    .createMany({ data: rows })
    .catch((err) => console.error('[MemoryIndexer] DB insert failed:', err.message))
}
