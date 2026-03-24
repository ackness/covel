# 03. 记忆、RAG、存档与可观测性规范

## 1. 目标

v1 必须具备完整的记忆、检索、存档、日志和追踪基础设施。

本文件决定：

- memory / archive / retrieval / trace 的核心对象
- RAG 的标准管线
- M1 默认参数
- ingestion 触发点
- 失败降级策略
- archive restore / reindex 规则
- app log / audit log / trace record 的边界
- 本地调试能力与 OTEL 钩子

本文件不决定：

- package authoring 规则
- host UI 的一般设计系统
- provider registry 的具体实现方式

但实现遵循奥卡姆剃刀原则：

- 只使用一套主数据库
- 不引入独立向量库
- 不引入独立图数据库
- 不引入独立日志平台

v1 用 `PostgreSQL + pgvector + full text search + entity_edges` 完成最小闭环。

## 2. 核心对象

本规范固定以下对象：

- `MemorySource`
- `MemoryDocument`
- `MemoryChunk`
- `ArchiveVersion`
- `RetrievalRun`
- `TraceRecord`

### 2.1 MemorySource

表示记忆的来源。

来源至少包括：

- world doc
- worldbook entries
- character card
- persona
- recent messages
- archive summary
- package-generated knowledge

### 2.2 MemoryDocument

表示一份可索引、可重建的记忆文档。

至少包含：

- `id`
- `sourceType`
- `scope`
- `title`
- `content`
- `metadata`
- `provenance`

### 2.3 MemoryChunk

表示文档切分后的最小检索单元。

至少包含：

- `id`
- `documentId`
- `text`
- `tokenCount`
- `embedding`
- `tsvector`
- `metadata`

### 2.4 ArchiveVersion

表示一个会话存档版本。

至少包含：

- `id`
- `sessionId`
- `turnCutoff`
- `stateSnapshot`
- `workingSummary`
- `archiveSummary`
- `createdAt`

### 2.5 RetrievalRun

表示一次检索执行的完整记录。

至少包含：

- `id`
- `sessionId`
- `query`
- `rewrittenQueries`
- `selectedSources`
- `candidates`
- `selectedChunks`
- `critique`
- `latencyMs`

### 2.6 TraceRecord

表示一段执行链路中的一个可追踪节点。

至少包含：

- `traceId`
- `spanId`
- `sessionId`
- `turnId`
- `component`
- `eventType`
- `payload`
- `createdAt`

## 3. RAG 总体架构

v1 采用完整 RAG 管线，但每一步保持最小可实现设计。

标准管线固定为：

1. `query normalization`
2. `source routing`
3. `query rewrite`
4. `hybrid retrieval`
5. `graph neighbor expansion`
6. `rerank`
7. `budget packing`
8. `provenance tagging`
9. `retrieval critique`

这条管线统一用于：

- 会话推进
- slash command 检索
- 调试页检索分析
- 存档恢复时的上下文重建辅助

## 4. 各阶段职责

### 4.1 Query Normalization

负责：

- 去掉噪声词
- 识别当前语言
- 提取主要实体
- 统一 query 元格式

### 4.2 Source Routing

负责根据 query 决定优先查哪些来源：

- world
- persona
- recent turns
- archives
- package memory

v1 只做规则驱动 routing，不做复杂学习型 routing。

### 4.3 Query Rewrite

负责把用户查询改写为更适合检索的 query 集合。

v1 支持：

- 主 query
- 补充 query
- 实体 query

### 4.4 Hybrid Retrieval

v1 固定为：

- PostgreSQL full text search
- pgvector semantic retrieval

结果融合方式可以先用简单分数融合，不做过度复杂算法。

### 4.5 Graph Neighbor Expansion

v1 只做轻量图扩展。

实现方式：

- `entity_edges` 表
- 基于已命中的实体做一跳邻接扩展

不引入图数据库。

### 4.6 Rerank

v1 支持 rerank，但要遵循最小实现原则。

优先顺序：

1. 轻量模型 rerank
2. 规则分数重排
3. 若 rerank 不可用，则退化到 hybrid retrieval 结果

### 4.7 Budget Packing

负责按 prompt budget 组装可消费的 chunk 集。

每个候选 chunk 至少要有：

- priority
- token cost
- source scope
- provenance

### 4.8 Provenance Tagging

最终进入上下文的所有记忆片段必须保留来源：

- source type
- document id
- chunk id
- package / archive / world scope

### 4.9 Retrieval Critique

这一层借鉴现代 RAG 工作中的反思思想，但 v1 只做最小实现。

负责判断：

- 当前检索是否足够
- 是否缺少关键证据
- 是否需要降级或回退

不做训练型复杂自反射系统。

## 4.10 M1 默认参数

为了让实现者不需要自行补关键默认值，M1 默认参数固定如下：

- markdown / world / persona / worldbook chunking
  - heading-aware chunking
  - target size: `400` tokens
  - hard max: `600` tokens
  - overlap: `80` tokens
- conversation / archive transcript chunking
  - sliding window
  - target size: `300` tokens
  - hard max: `450` tokens
  - overlap: `0`
- hybrid retrieval top-k
  - lexical: `20`
  - vector: `20`
  - fused candidates: `24`
- graph neighbor expansion
  - max neighbors: `8`
- rerank input size
  - top candidates: `12`
- final context packing
  - 按剩余 prompt budget 截断

这些值是 v1 的默认起点，不代表长期最优解。

## 4.11 Ingestion 触发点

M1 记忆写入与重建触发点固定为：

- world 保存后
- worldbook / character card / persona 更新后
- assistant turn 完成后
- archive 创建后
- package 启用或禁用后
- 显式执行 `/memory reindex` 后

规则：

- 同步主链路只负责登记 ingestion job
- 实际切分、embedding、索引写入可由进程内后台任务完成
- 同一 source 重复写入必须幂等

## 4.12 Embedding 默认策略

M1 embedding 只通过 runtime 的 `embed-default` profile 生成。

规则：

- retrieval 与 ingestion 共用同一个 embedding profile
- package 不直接指定 embedding provider
- embedding 维度和模型名称只由 runtime 配置控制

## 4.13 失败降级策略

为了保证系统稳定，RAG 各阶段失败时必须按下面规则退化：

- query normalization 失败
  - 直接使用原始 query
- query rewrite 失败
  - 只使用原始 query
- vector retrieval 失败
  - 回退到 FTS-only
- FTS 失败
  - 回退到 vector-only
- graph expansion 失败
  - 跳过图扩展
- rerank 失败
  - 使用 hybrid retrieval 的 fused 结果
- critique 失败
  - 不阻塞主流程，继续使用当前检索结果
- embedding / ingestion 失败
  - 标记 source 为 `stale`
  - 不阻塞主会话推进

## 5. 现代 RAG 参考方向

v1 的设计可参考这些方向，但只吸收必要思想：

- `Self-RAG`
  - 强调检索与生成之间的反思闭环
- `CRAG`
  - 强调检索质量判断与纠错
- `GraphRAG`
  - 强调实体与关系结构化检索

v1 的原则是：

- 吸收方法思想
- 不照搬复杂系统工程
- 先做可运行、可调试、可观测的最小版

## 6. 记忆分层

运行时记忆固定为四层：

- `Recent Window`
- `Working Summary`
- `Long-term Facts`
- `Archive Summary`

用途：

- `Recent Window`
  - 保留局部对话连续性
- `Working Summary`
  - 保留当前会话推进重点
- `Long-term Facts`
  - 保留稳定事实
- `Archive Summary`
  - 保留已压缩历史片段

这四层共同进入 `ContextGraph`，由 `PromptGraph` 按预算选择。

## 7. 存档系统

Archive 不是附件，也不是纯文本导出。

它是 session 的可恢复版本对象。

### 7.1 支持能力

v1 必须支持：

- snapshot
- summary
- restore
- fork restore

### 7.2 Snapshot 内容

每次存档至少包含：

- message cutoff
- state snapshot
- working summary
- archive summary
- involved artifacts metadata

### 7.3 Restore 规则

恢复分两种：

- `restore-in-place`
- `restore-as-fork`

恢复后要保持：

- session 状态一致
- memory 层可重建
- trace 与 archive lineage 可追溯

### 7.4 Reindex 规则

restore 完成后，系统必须：

1. 写入新的 archive lineage
2. 标记相关记忆 source 为待重建
3. 触发对应 scope 的 reindex

v1 不要求 restore 时同步完成全部 reindex，但必须保证状态一致且最终可收敛。

## 8. 日志系统

v1 必须有完整日志系统，至少分三层。

### 8.1 App Log

面向运行与故障排查。

建议：

- `pino`
- JSON structured logging

至少记录：

- request lifecycle
- command execution
- provider calls
- retrieval runs
- archive writes
- package activation errors

### 8.2 Audit Log

面向审计与行为追踪。

至少记录：

- package enable / disable
- dangerous command
- archive restore
- settings change
- admin-like debug action

### 8.3 Trace Record

面向执行链观察。

必须能追到：

- command
- retrieval
- model call
- block emission
- archive operation
- package contribution

## 9. 本地调试能力

v1 必须自带可视化调试能力，而不是只看终端日志。

至少包含：

- trace list
- trace detail
- prompt/context preview
- retrieval debug view
- package/session/turn filter
- archive lineage view

这部分是 v1 的正式功能，不是“以后再补”的调试面板。

## 10. OpenTelemetry 与未来 Langfuse

v1 不强绑定外部 tracing 平台，但必须预留：

- `OpenTelemetry` span/export hook
- provider tracing hook
- retrieval tracing hook
- trace redaction policy

后续接 Langfuse 时，应只新增 adapter，不改领域协议与本地 trace 语义。

依赖策略：

- observability 相关依赖优先选最新稳定版
- `OpenTelemetry` 相关包保持同一兼容批次
- 若采用 `Vercel AI SDK` telemetry 能力，应保持与其最新稳定版兼容

## 11. 实现约束

为了防止过度设计，v1 明确约束如下：

- 只用 PostgreSQL
- `pgvector + full text search + entity_edges`
- 不引入独立向量库
- 不引入图数据库
- 不引入独立日志平台
- 不引入复杂多级异步编排系统

先把：

- ingestion
- retrieval
- archive
- log
- trace

这五条链路做成一个最小闭环。
