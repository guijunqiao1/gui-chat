# 为 memory_search 增加多轮检索策略

## Context

当前项目的 [memory-search.ts](file:///c:/Users/Administrator/Desktop/gui-chat/Sky-Chat/server/services/tools/memory-search.ts) 是「一次查询一次返回」的单轮向量检索：query → embedding → cosine 打分 → topK 切片。当用户问题模糊、指代不清（如"那个我之前提的东西"）或复杂（涉及多个子话题）时，往往首轮就返回空或低质量结果，AI 没有兜底机制，导致记忆检索能力偏弱。

[stream.handler.ts](file:///c:/Users/Administrator/Desktop/gui-chat/Sky-Chat/server/services/chat/stream.handler.ts#L78-L155) 虽有 5 轮工具调用 loop，但完全依赖 AI 自主决定是否再次调用 memory_search，没有主动的检索策略层（查不到换查询 / 子问题分解 / 交叉验证）。

本次改造目标：在 **memory-search.ts 内部**（不抽公共模块，不动 knowledge_search）实现 LLM 驱动的三大策略，让 memory_search 在首轮检索失败时自动改写查询、拆分子问题、交叉验证。

## 改造范围

| 文件 | 改动 |
|---|---|
| `server/services/tools/memory-search.ts` | 核心改造（新增约 150-200 行 + execute 重组） |
| `server/services/chat/prompt.builder.ts` | 第 7 段末尾加 1 行提示文案（让 AI 知道工具会自重试，避免死循环调用） |
| `knowledge-search.ts` / `types.ts` / `handler.ts` / `sse-writer.ts` / `package.json` / `prisma/schema.prisma` | **不动** |

## 设计要点

### 1. 关键约束
- `Tool.execute` 签名不变：`(args: Record<string, unknown>) => Promise<string>`
- 返回 JSON 保持 `{ content, sources, resultCount }` 字段不变（前端 [sse-writer.ts](file:///c:/Users/Administrator/Desktop/gui-chat/Sky-Chat/server/services/chat/sse-writer.ts) 第 87-90 行 / [handler.ts](file:///c:/Users/Administrator/Desktop/gui-chat/Sky-Chat/server/services/tools/handler.ts) 第 46-53 行只读这三个字段）
- 第 1 轮直接命中时不触发任何额外开销，行为与改造前一致
- DB 取数 `prisma.conversationMemory.findMany` 一次性完成，所有重试轮次复用同一份 memories，仅 embedding 调用按 query 重复
- LLM 调用失败时降级返回第 1 轮结果，不抛错

### 2. 触发条件与重试上限
```
SCORE_THRESHOLD = 0.35   // top1 score 低于此值或 resultCount=0 触发重试
MAX_RETRIES = 2          // 最多重试 2 次（总 3 轮检索）
```

### 3. 三大策略实现

**(A) 查不到换查询（LLM 驱动）** — `rewriteQuery(originalQuery, apiKey)`：
- 调 SiliconFlow `/v1/chat/completions`（`stream:false`，`temperature:0.2`，沿用 `fetch + AbortController` 模式，与 `createEmbedding` 一致）
- model 默认 `deepseek-ai/DeepSeek-V3.2`，可用 env `RAG_QUERY_REWRITE_MODEL` 覆盖（可切到 `Qwen/Qwen2.5-7B-Instruct` 等小模型省成本）
- 一次 LLM 调用同时完成改写 + 子问题分解（节省调用次数）
- prompt 要求返回严格 JSON：`{ "rewrittenQuery": "...", "subQuestions": ["...", "..."] }`（子问题 0-3 个）
- 解析容错：`extractJSON` 剥离 ```json fence + 截取首尾 `{}`；失败 throw 由调用方 catch 降级

**(B) 分解子问题** — 主流程编排：
- 第 1 轮：`searchOnce(query)` 检索
- 触发重试 → `rewriteQuery` 拿到 `rewrittenQuery` + `subQuestions`
- 第 2 轮：`[rewrittenQuery, ...subQuestions]` 并行 `searchOnce`（每路 topK*2 扩大候选），`Promise.all`
- 第 3 轮（如仍不达标）：基于原 query + 上轮改写再调一次 `rewriteQuery`，交叉验证阈值放宽

**(C) 交叉验证** — `crossValidate(byQuery, opts)`：
- 多子问题路径（`subQuestions.length >= 2`）：按 `memory.id` 聚合各子问题命中，统计 `hitCount`（cos ≥ `minCosThreshold` 算命中），保留 `hitCount >= minHitQueries` 的记忆，按 `sumScore` 降序
  - 第 2 轮：`minHitQueries=2, minCosThreshold=0.25`
  - 第 3 轮：`minHitQueries=1, minCosThreshold=0.20`（放宽）
- 单 query 退化路径（`subQuestions.length < 2`）：`reScoreWithQuery(hits, rewrittenQuery, apiKey, 0.3)` 用改写后 query 重打分，剔除 cos 下降超过 30% 的噪声

### 4. 编排逻辑（execute 内）

```
1. 参数校验（保留原逻辑）
2. 一次性 DB 取数 + 过滤 currentConversationId（移到入口）
3. hits1 = await searchOnce(query)              // 第 1 轮
4. needRetry = hits1.length===0 || hits1[0].score < 0.35
5. if (!needRetry) return formatResult(hits1)    // 零额外开销
6. for (attempt=1..MAX_RETRIES):
     rewrite = await rewriteQuery(...)            // catch 失败 → break 降级
     byQuery = await Promise.all(queries.map(searchOnce))
     hits = subQuestions.length>=2 ? crossValidate(byQuery,...) : reScoreWithQuery(...)
     if (hits[0].score > bestHits[0].score) bestHits = hits  // 永不比第 1 轮更差
     if (bestHits[0].score >= 0.35) break         // 已达标提前结束
7. return formatResult(bestHits, meta?)
```

`meta` 字段（仅在触发重试时出现，前端不读，向后兼容）：
```json
{ "rounds": 2, "strategy": "rewrite+subquery+crossvalidate", "rewrittenQuery": "..." }
```

### 5. 顶部新增辅助函数清单

```ts
// 常量
CHAT_COMPLETIONS_URL = 'https://api.siliconflow.cn/v1/chat/completions'
DEFAULT_QUERY_REWRITE_MODEL = 'deepseek-ai/DeepSeek-V3.2'
LLM_TIMEOUT = 20_000
SCORE_THRESHOLD = 0.35
MAX_RETRIES = 2
CROSS_VALIDATE_MIN_COS = 0.25
RESCORE_DROP_THRESHOLD = 0.3

// 类型（文件内私有）
interface ScoredMemory { m: {...}; score: number; cos: number }
interface RewriteResult { rewrittenQuery: string; subQuestions: string[] }

// 函数
extractJSON(content): Record<string, unknown>
callLLMJSON(systemPrompt, userPrompt, apiKey): Promise<Record<string, unknown>>
rewriteQuery(originalQuery, apiKey): Promise<RewriteResult>
searchOnce(query, apiKey, memories, now, topK): Promise<ScoredMemory[]>   // 从原 execute 抽出
crossValidate(byQuery, { minHitQueries, minCosThreshold }): ScoredMemory[]
reScoreWithQuery(hits, probeQuery, apiKey, dropThreshold): Promise<ScoredMemory[]>
formatResult(hits, now, meta?): string                                      // 从原 execute 末尾抽出
```

### 6. prompt.builder.ts 微调

在第 7 段「跨会话记忆检索 RAG」末尾追加一行：
```
- memory_search 现已支持多轮检索：当首轮未命中相关记忆时会自动改写并拆解子问题重试，请按完整问题调用一次即可，不要因首次返回空就重复调用
```

## 风险与对策

| 风险 | 对策 |
|---|---|
| LLM 调用拖慢首字延迟 | memory_search 本就是工具调用阶段异步执行；MAX_RETRIES=2 上限 + 失败立即降级；env 可切小模型 |
| LLM 返回非 JSON 幻觉 | `extractJSON` 多层容错；解析失败 throw → catch → 返回第 1 轮 hits |
| N+1 embedding 调用 | subQuestions 限制最多 3 个；`Promise.all` 并行；memories 复用同一份 DB 取数 |
| 改写后反而变差 | `bestHits` 比较保留最高 score 的一轮，绝不返回比第 1 轮更差的结果 |
| AI 看到空结果死循环重复调用 memory_search | prompt.builder.ts 提示文案兜底 |

## 验证步骤

### 1. 编译验证
```bash
cd c:\Users\Administrator\Desktop\gui-chat\Sky-Chat
pnpm build
```
重点检查：`memory-search.ts` 的类型签名仍兼容 `Tool` 接口。

### 2. 启动服务
```bash
pnpm dev
```

### 3. 用例验证（在已登录且有历史对话的用户下）

| 用例 | Query | 期望 |
|---|---|---|
| 第 1 轮直接命中 | `我之前说过的城市是哪个？` | resultCount>0，返回 JSON 不带 `meta` |
| 触发 Query Rewriting | `那个我以前提的东西`（指代模糊） | `meta.strategy="rewrite+rescore"`，`meta.rounds=2` |
| 触发子问题分解+交叉验证 | `我之前提到的项目用什么技术栈，部署在哪里？` | `meta.strategy="rewrite+subquery+crossvalidate"`，subQuestions≥2 |
| 触发 2 次重试 | `asdfqwer完全无关的字符串` | 返回 `未检索到相关记忆`，`meta.rounds=3` |
| LLM 故障降级 | 临时改 `RAG_QUERY_REWRITE_MODEL` 为不存在的 ID，重试用例 2 | 返回第 1 轮结果，无 500 错误 |

### 4. 前端兼容性
浏览器 DevTools 看 SSE 事件：`tool_call` / `tool_result` 事件的 `resultCount`、`sources` 字段正常显示；多出的 `meta` 字段前端不读，无副作用。

## 关键文件

- c:\Users\Administrator\Desktop\gui-chat\Sky-Chat\server\services\tools\memory-search.ts（核心改造）
- c:\Users\Administrator\Desktop\gui-chat\Sky-Chat\server\services\chat\prompt.builder.ts（1 行提示文案）
- c:\Users\Administrator\Desktop\gui-chat\Sky-Chat\server\services\tools\types.ts（只读参考，不改）
- c:\Users\Administrator\Desktop\gui-chat\Sky-Chat\server\services\tools\handler.ts（只读参考，不改）
- c:\Users\Administrator\Desktop\gui-chat\Sky-Chat\server\services\chat\sse-writer.ts（只读参考，不改）
