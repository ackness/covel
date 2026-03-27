# 09. 外部技术重新评估：GraphRAG、Memory、Workflow、Storage

这篇文档基于当前仓库方向，以及外部官方资料，对几个关键技术做重新评估：

- GraphRAG
- agent memory
- durable workflow
- PostgreSQL / pgvector / local cache
- typed stream parts / host runtime

目标不是“追新技术”，而是判断：

- 它是否真的解决 `covel` 现在的问题
- 它应在什么阶段进入
- 它进入后该挂在哪一层

## 1. GraphRAG 到底有没有必要

### 1.1 结论

有必要，但不是现在就上“重型 full GraphRAG”。

对 `covel` 真正有价值的是：

- `Hybrid RAG`
- `Entity-aware retrieval`
- `Lightweight GraphRAG`

而不是一开始就把所有世界和所有会话都压成完整社区图。

### 1.2 为什么它有用

如果目标是帮助模型理解：

- 剧情关系
- 人物关系
- 世界状态
- 长会话中前因后果

单纯 vector top-k 确实不够。

Microsoft GraphRAG 官方文档把场景分得很清楚：

- `Local Search`
  适合围绕具体实体的问题
- `Global Search`
  适合跨语料整体问题
- `DRIFT Search`
  适合在局部问题上引入社区级信息来扩大事实覆盖

参考：

- GraphRAG Query Overview  
  <https://microsoft.github.io/graphrag/query/overview/>

官方原话的关键信息是：

- local search 把知识图和原始文本 chunk 结合起来
- global search 依赖社区报告，适合整体性问题，但资源开销更大
- DRIFT search 会把社区信息引入局部问题，扩展事实覆盖面

这对 `covel` 的意义是：

- 角色关系、阵营关系、任务链，是局部图问题
- 世界整体趋势、章节总结、长会话大势，是全局图问题
- “这个 NPC 为什么会这样做”这种问题，往往是局部图 + 最近事件的混合问题

### 1.3 为什么现在不该上 full GraphRAG

同样来自官方和类似项目的经验：

- 图构建和社区报告会明显增加成本
- 数据量不大时，收益未必高于 `hybrid + entity edges`
- narrative runtime 里最先缺的通常不是“图算法”，而是：
  - 正确分层的 memory
  - 可检索的实体关系
  - provenance
  - retrieval trace

Mem0 官方的 Graph Memory 也给了一个很重要的现实判断：

- graph relations 是作为额外上下文返回
- 不会自动重排 vector 命中

参考：

- Mem0 Graph Memory  
  <https://docs.mem0.ai/platform/features/graph-memory>

这其实说明：

- 图信息最适合先做“增强层”
- 不适合直接替代现有检索骨架

### 1.4 对 `covel` 的具体判断

现在应采纳：

1. `memory_documents + memory_chunks + retrieval_runs`
2. `entities + entity_edges`
3. `hybrid retrieval`
4. retrieval 后一跳关系扩展
5. context/provenance 可视化

以后再采纳：

1. community summaries
2. global search
3. drift search
4. selective full GraphRAG for large knowledge packages

所以结论不是“GraphRAG 没必要”，而是：

- GraphRAG 对 `covel` 有必要
- 但应该以 `entity-aware retrieval` 的形态先进入，而不是 full stack 先进入

## 2. Agent Memory 值不值得继续

### 2.1 结论

非常值得继续，而且应该是当前骨架的一部分。

但 agent memory 在 `covel` 里不该变成“一个黑盒记忆服务”，而应该拆成：

- short-term / turn memory
- session memory
- semantic memory
- episodic memory
- archive memory
- retrieval memory

### 2.2 为什么

LangGraph/LangMem 的官方资料给出的模式很明确：

- LangGraph 把 state、thread、checkpoint 当成一等对象
- LangMem 把 memory management、semantic memory、episodic memory、profile memory 做成可组合工具

参考：

- LangGraph persistence  
  <https://docs.langchain.com/oss/javascript/langgraph/persistence>
- LangGraph memory  
  <https://docs.langchain.com/oss/python/langgraph/add-memory>
- LangMem reference  
  <https://langchain-ai.github.io/langmem/reference/>
- LangMem conceptual guide  
  <https://langchain-ai.github.io/langmem/concepts/conceptual_guide/>

这些官方资料强调的不是“把所有对话都存起来”，而是：

- 线程级状态要能 checkpoint / history / resume
- 语义记忆要能独立检索
- 记忆管理应可后台处理

这和 `covel` 的目标高度一致：

- 长会话
- 世界持续演化
- block suspend/resume
- retrieval 驱动叙事

### 2.3 Mem0 给出的现实启发

Mem0 官方对 memory scope 的设计很值得借：

- user
- agent
- app
- run

参考：

- Mem0 Entity-Scoped Memory  
  <https://docs.mem0.ai/platform/features/entity-scoped-memory>

对 `covel` 的映射很自然：

- `world`
- `session`
- `package`
- `workflow run`

所以这里应该继续，而不是放弃。

### 2.4 对 `covel` 的具体落点

现在应采纳：

- 把 memory 明确分层
- 让 package context provider 读取不同 scope 的记忆
- 让 retrieval run 成为可回放记录

以后采纳：

- 后台 memory reflection / extraction
- 自动 profile memory / episodic summarization
- 多 agent 独立 scope memory

## 3. 世界状态管理和状态演化值不值得继续

### 3.1 结论

这是必须继续的，而且比 GraphRAG 更优先。

因为很多“模型理解人物关系 / 世界状态”的问题，本质上不是检索问题，而是：

- 你没有结构化状态
- 状态变化没有事件记录
- 前端没有状态视图

### 3.2 为什么

如果：

- 任务阶段
- 阵营态度
- 角色关系
- scene 参与者
- flags / resources

都只存在于消息文本里，那么即便上了 GraphRAG，模型也还是会忘。

所以 modernization 里的 `State Patch First` 是对的，而且应该继续。

`covel` 应该先做到：

- flow/package 输出结构化 `state_patch`
- runtime 统一 apply
- event log 记录状态演化
- read models 给前端 panel/inspector 用

这件事的重要性高于 full GraphRAG。

## 4. 数据库 / 存储层值不值得继续

### 4.1 结论

非常值得继续，而且现在就应该作为主方向。

### 4.2 为什么

pgvector 官方给出的几个现实点非常适合 `covel`：

- 默认 exact nearest neighbor 可先保证准确性
- 需要时再上 HNSW / IVFFlat
- 支持和普通 Postgres 过滤条件一起用
- “按 Postgres 的方式扩展 pgvector”

参考：

- pgvector GitHub README  
  <https://github.com/pgvector/pgvector>

这和 `covel` 很匹配，因为你需要的不只是向量搜索，而是：

- 向量 + 全文 + scope filter
- 向量 + 世界/会话/实体关系 join
- provenance + audit + event log

这正适合单一 Postgres 做第一阶段主库。

### 4.3 继续做什么

现在应采纳：

- Postgres-first
- `pgvector + FTS + JSONB`
- event-aware schema
- read models

继续保留：

- in-memory path for tests / demo / CI

以后采纳：

- IndexedDB cache
- selective local-first
- workflow snapshots / richer projections

现在不采纳：

- 一开始就拆独立图库 / 独立向量库 / 独立状态库

## 5. Durable Workflow 值不值得继续

### 5.1 结论

值得继续，但作为第二阶段。

### 5.2 为什么

Temporal 官方文档给出的核心价值很明确：

- crash-proof execution
- guaranteed resume
- long-running processes can continue after failure

参考：

- Temporal docs  
  <https://docs.temporal.io/>

LangGraph 官方对 checkpoint/thread/super-step 的说明也说明：

- checkpoint 是自然的 resume 边界
- thread history 可用于回放、time travel、debug

参考：

- LangGraph persistence  
  <https://docs.langchain.com/oss/javascript/langgraph/persistence>

对 `covel` 来说，这些思想很适合：

- block 等待用户输入
- archive / summary / indexing 后台执行
- 图片生成 / 音频生成
- 人类审批

但当前阶段更合理的是：

- 先把现在的 `flow-engine` 做成更强的可恢复执行
- 再抽出 `workflow run / workflow snapshot / step model`

而不是现在直接把 Temporal / LangGraph 套进业务层。

## 6. Typed Stream Parts 值不值得继续

### 6.1 结论

值得，但放在 context/state 跑稳之后。

### 6.2 为什么

Vercel AI SDK 官方的 stream protocol 很值得借：

- text parts
- reasoning parts
- source parts
- file parts
- custom data parts
- tool input/output parts
- step start/finish parts

参考：

- AI SDK UI Stream Protocol  
  <https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol>

这说明现代前端确实不应该只吃 `message.delta`。

但对 `covel`，现在更现实的做法是：

- 先把现有 `SSE envelope` 稳住
- 让 `message / block / artifact / trace / state` 真正各归其位
- 再演进成 typed stream parts

所以它是对的，但不是第一优先级。

## 7. 如何把这些技术串成统一骨架

最合理的统一骨架不是“换成某个外部框架”，而是：

```text
User Action
  -> Flow Engine
  -> Context Assembly
       worldbook/persona/character-card/memory
       + retrieval
       + state summaries
  -> Prompt Graph
  -> Model Gateway
  -> Package Capabilities / Hooks
  -> Outputs
       message
       block
       artifact
       state_patch
       workflow_event
  -> Persistence
       postgres
       pgvector
       event log
       trace records
       package state
  -> Host Runtime
       timeline
       block surface
       artifact surface
       panels
       inspectors
```

### 7.1 现在最值得推进的骨架顺序

1. `context-graph -> retrieval -> prompt-graph -> flow-engine`
2. `state_patch + reducer + read models`
3. `host-bundled registry-based UI`
4. `workflow snapshots / typed stream parts`
5. `selective GraphRAG`

### 7.2 当前正式建议

现在采纳：

- Hybrid RAG
- Entity-aware retrieval
- layered memory
- state patch runtime
- Postgres-first dual-path storage
- stronger trace model
- host runtime frontend

以后采纳：

- durable workflow runtime
- typed stream parts
- panel/inspector registries as first-class extensibility
- lightweight GraphRAG summaries

暂时避免：

- full GraphRAG first
- all-local-first first
- direct adoption of external orchestration frameworks into business logic

## 8. 最终判断

所以对你前一个问题的直接回答是：

- GraphRAG 不是“没必要”
- 它对理解人物关系、剧情链、世界状态是有用的
- 但最合理的进入方式不是 full GraphRAG，而是 `Hybrid RAG -> entity-aware retrieval -> lightweight graph expansion`

同时：

- 世界状态管理非常值得继续，而且优先级更高
- 数据库 / 存储层方案非常值得继续，而且现在就应该做主方向
- agent memory 非常值得继续，而且应该成为当前 runtime 的正式骨架
- durable workflow 也值得继续，但应排在 context/retrieval/state 之后
