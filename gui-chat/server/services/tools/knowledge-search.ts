/**
 * Private knowledge-base search tool.
 *
 * Chunks are stored with pgvector embeddings.  The tool always constrains its
 * query to the requesting user, so the model can never retrieve another
 * user's documents.
 */

import { Prisma } from '@prisma/client'
import { prisma } from '@/server/db/client'
import type { Tool } from './types'

const EMBEDDINGS_URL = 'https://api.siliconflow.cn/v1/embeddings'
const DEFAULT_EMBEDDING_MODEL = 'BAAI/bge-m3'
const SEARCH_LIMIT = 6
const SEARCH_TIMEOUT = 15_000

type KnowledgeSearchRow = {
  content: string
  documentName: string
  source: string | null
  score: number
}

async function createEmbedding(
  query: string,
  apiKey: string
): Promise<number[]> {
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
    if (
      !Array.isArray(embedding) ||
      !embedding.every((value) => typeof value === 'number')
    ) {
      throw new Error('Embedding API returned an invalid vector')
    }
    return embedding
  } finally {
    clearTimeout(timeout)
  }
}

function vectorLiteral(embedding: number[]): string {
  // Values originate from the embedding API and are additionally validated,
  // then passed as a bound SQL parameter rather than interpolated SQL.
  return `[${embedding.join(',')}]`
}

export function createKnowledgeSearchTool(
  userId: string,
  apiKey: string
): Tool {
  return {
    name: 'knowledge_search',
    description:
      '搜索当前用户的私有知识库。当问题可能需要已上传的文档、笔记、公司资料或项目资料时，先调用此工具；仅根据返回的内容回答，不要编造知识库内容。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '用于在知识库中检索的简洁、具体的问题或关键词',
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
        const embedding = await createEmbedding(query.trim(), apiKey)
        const rows = await prisma.$queryRaw<KnowledgeSearchRow[]>(Prisma.sql`
          SELECT c."content", d."name" AS "documentName", d."source",
                 1 - (c."embedding" <=> ${vectorLiteral(embedding)}::vector) AS "score"
          FROM "KnowledgeChunk" c
          INNER JOIN "KnowledgeDocument" d ON d."id" = c."documentId"
          WHERE d."userId" = ${userId}
          ORDER BY c."embedding" <=> ${vectorLiteral(embedding)}::vector
          LIMIT ${SEARCH_LIMIT}
        `)

        const sources = rows.map((row) => ({
          name: row.documentName,
          source: row.source,
          score: Number(row.score.toFixed(4)),
        }))
        const content = rows.length
          ? rows
              .map(
                (row, index) =>
                  `[${index + 1}] ${row.documentName}\n${row.content}`
              )
              .join('\n\n')
          : '知识库中未找到相关内容。'
        return JSON.stringify({ content, sources, resultCount: rows.length })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '知识库检索失败'
        console.error('[KnowledgeSearch] Search error:', message)
        return JSON.stringify({ error: message, sources: [], resultCount: 0 })
      }
    },
  }
}
