/**
 * 消息持久化模块
 *
 * 负责将消息内容保存到数据库
 * RAG 场景 B：AI 回答落库后自动写入长期记忆索引（fire-and-forget）
 */

import { MessageRepository } from '@/server/repositories/message.repository'
import { ConversationRepository } from '@/server/repositories/conversation.repository'
import type { ToolCall } from '@/server/services/tools'
import { indexMemory } from '@/server/services/memory/indexer'

/** createMessages 返回 */
export interface CreateMessagesResult {
  userMessageId: string
  aiMessageId: string
}

/**
 * 创建一轮对话的两条消息：用户消息 + 空的 AI 消息（流式回填）
 * @returns { userMessageId, aiMessageId }
 */
export async function createMessages(
  conversationId: string,
  userContent: string,
  userMessageIdIn: string | undefined,
  aiMessageIdIn: string | undefined,
  attachments?: Array<{ name: string; content: string; type: string; size: number }>
): Promise<CreateMessagesResult> {
  const userMessage = await MessageRepository.create({
    id: userMessageIdIn || undefined,
    conversationId,
    role: 'user',
    content: userContent,
    attachments:
      attachments && attachments.length
        ? (JSON.parse(JSON.stringify(attachments)) as unknown as import('@prisma/client').Prisma.InputJsonValue)
        : undefined,
  })
  const aiMessage = await MessageRepository.create({
    id: aiMessageIdIn || undefined,
    conversationId,
    role: 'assistant',
    content: '',
  })
  return { userMessageId: userMessage.id, aiMessageId: aiMessage.id }
}

/** 工具结果数据 */
export interface ToolResultData {
  toolCallId: string
  name: string
  result: Record<string, unknown>
}

/** 消息内容 */
export interface MessageContent {
  thinkingContent: string
  answerContent: string
  toolCallsData: ToolCall[] | null
  toolResultsData?: ToolResultData[] | null
}

/**
 * 保存消息内容到数据库
 * 副作用：AI 回答落库后异步写入长期记忆（RAG 场景 B）
 */
export async function persistMessage(
  messageId: string,
  conversationId: string,
  userId: string,
  content: MessageContent,
  /** 可选：向量化用的 API Key */
  embeddingApiKey?: string
): Promise<void> {
  try {
    await MessageRepository.update(messageId, {
      content: content.answerContent,
      thinking: content.thinkingContent || undefined,
      toolCalls: content.toolCallsData
        ? (JSON.parse(JSON.stringify(content.toolCallsData)) as object)
        : undefined,
      toolResults: content.toolResultsData
        ? (JSON.parse(JSON.stringify(content.toolResultsData)) as object)
        : undefined,
    })

    await ConversationRepository.touch(conversationId, userId)

    // RAG 场景 B：AI 回答写入长期记忆（fire-and-forget）
    if (content.answerContent && content.answerContent.trim().length >= 6) {
      void indexMemory({
        userId,
        conversationId,
        messageId,
        role: 'assistant',
        content: content.answerContent,
        apiKey: embeddingApiKey,
      }).catch((err) => {
        console.error('[MessagePersister] AI 回答记忆索引失败：', err.message)
      })
    }
  } catch (error) {
    console.error('[MessagePersister] Failed to save message:', error)
  }
}

/**
 * 处理图片结果，插入到内容中
 * 
 * @param answerContent - 原始回答内容
 * @param allToolCalls - 所有工具调用
 * @param allToolResults - 所有工具结果
 * @returns 处理后的内容
 */
export function processImageResults(
  answerContent: string,
  allToolCalls: ToolCall[],
  allToolResults: Array<{ toolCallId: string; name: string; result: Record<string, unknown> }>
): string {
  // 收集真实的图片 URL
  const realImageUrls = new Set<string>()
  for (const resultData of allToolResults) {
    const imageUrl = resultData.result?.imageUrl as string | undefined
    if (resultData.name === 'generate_image' && imageUrl) {
      realImageUrls.add(imageUrl)
    }
  }

  // 移除所有 AI 自己输出的 image block（不管 URL 是什么格式）
  // 因为 AI 会模仿真实 URL 格式编造假的
  let contentWithImages = answerContent.replace(
    /```image\n[\s\S]*?```\n?/g,
    ''
  )

  // 移除 AI 编造的假图片链接
  // 匹配：[任何包含图片/查看/下载的文字](任何链接)
  contentWithImages = contentWithImages.replace(
    /\[[^\]]*?(图片|查看|下载|生成)[^\]]*?\]\([^)]*\)/gi,
    ''
  )

  // 移除 AI 输出的 Markdown 图片语法 ![...](...)
  contentWithImages = contentWithImages.replace(
    /!\[[^\]]*\]\([^)]+\)/g,
    ''
  )

  // 移除"点击查看生成图片"等纯文本占位符
  contentWithImages = contentWithImages.replace(
    /点击查看.*?图片/gi,
    ''
  )

  // 清理多余的空行
  contentWithImages = contentWithImages.replace(/\n{3,}/g, '\n\n').trim()

  // 追加真实的图片
  for (const resultData of allToolResults) {
    const imageUrl = resultData.result?.imageUrl as string | undefined
    const width = resultData.result?.width as number | undefined
    const height = resultData.result?.height as number | undefined

    if (resultData.name === 'generate_image' && imageUrl) {
      const toolCall = allToolCalls.find(
        (tc) => tc.id === resultData.toolCallId
      )
      let prompt = '生成的图片'
      if (toolCall) {
        try {
          const args = JSON.parse(toolCall.function.arguments)
          prompt = args.prompt || prompt
        } catch {
          // 忽略解析错误
        }
      }
      const imageData = JSON.stringify({
        url: imageUrl,
        alt: prompt,
        width: width || 512,
        height: height || 512,
      })
      contentWithImages += `\n\`\`\`image\n${imageData}\n\`\`\`\n`
    }
  }

  return contentWithImages
}
