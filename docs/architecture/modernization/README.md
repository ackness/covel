# `covel` 现代化架构设计蓝图

这组文档的目标不是再写一份泛泛而谈的“愿景文档”，而是把 `covel` 下一阶段应采用的现代化方案拆成可执行的架构蓝图。

重点覆盖：

- GraphRAG / Hybrid Retrieval
- 世界状态与长期状态管理
- PostgreSQL / pgvector / 事件表 / 同步层
- Agent Memory
- Durable Workflow / Suspend-Resume
- 多面板工作台前端
- 观测、评测、回放与调试

这套文档同时吸收三类来源：

1. 当前仓库已有设计
2. 旧项目 `../ai-gamestudio-dev` 的成熟经验
3. 较新的开源仓库与方案

## 适合先读哪几篇

- 如果你想先看全局：`docs/architecture/modernization/01-target-platform.md`
- 如果你最关心 GraphRAG / Memory：`docs/architecture/modernization/02-graphrag-memory.md`
- 如果你最关心世界状态：`docs/architecture/modernization/03-world-state-and-data-model.md`
- 如果你最关心数据库：`docs/architecture/modernization/04-database-storage-sync.md`
- 如果你最关心 agent / workflow：`docs/architecture/modernization/05-agent-runtime-and-workflows.md`
- 如果你最关心前端工作台：`docs/architecture/modernization/06-client-workbench-modernization.md`
- 如果你最关心落地路线：`docs/architecture/modernization/07-observability-evals-and-roadmap.md`
- 如果你最关心“哪些现在就该并入当前框架”：`docs/architecture/modernization/08-current-framework-adoption.md`
- 如果你最关心“结合外部官方方案后，哪些技术真的该继续做”：`docs/architecture/modernization/09-external-tech-re-evaluation.md`

## 这套蓝图的核心判断

`covel` 不应该回到“一个复杂聊天页 + 一堆插件”的旧路，也不应该停留在“底座很漂亮但产品面很薄”的当前状态。

更合理的方向是：

- 后端变成 `runtime kernel + context graph + workflow + memory + package runtime`
- 前端变成 `host runtime + multi-panel workbench + artifact-native UI`
- 数据层变成 `Postgres-first + pgvector + entity edges + event log + local cache`
- 交互层变成 `message / block / artifact / state patch / workflow event` 五类协议并行

## 现代仓库参考

这次设计没有只参考传统经典仓库，而是重点借鉴更贴近现在产品形态的项目：

- `langchain-ai/langgraph`
- `langchain-ai/langmem`
- `mem0ai/mem0`
- `microsoft/graphrag`
- `run-llama/llama_index`
- `mastra-ai/mastra`
- `vercel/ai`
- `temporalio/sdk-typescript`
- `electric-sql/electric`
- `liveblocks/liveblocks`

这些仓库给出的启发不是“直接照抄框架”，而是：

- memory 分层应该怎么做
- GraphRAG 怎么从轻量模式渐进演化
- durable workflow 怎么接 block resume
- multi-panel streaming UI 怎么建模
- local-first / optimistic / offline / sync 怎么分层

## 和当前框架的收敛文档

为了避免 modernization 文档变成另一套平行架构，请同时参考：

- `docs/architecture/modernization/08-current-framework-adoption.md`

它负责回答：

- 哪些 modernization 想法现在就该采纳
- 哪些应作为下一阶段目标
- 哪些暂时不要硬塞进当前框架

## 当前仓库内的相关文档

- `docs/plans/next/00-architecture-whitepaper.md`
- `docs/plans/next/04-context-prompt-and-flow-engine.md`
- `docs/plans/next/05-client-host-and-multidevice-architecture.md`
- `docs/architecture/specs/03-memory-rag-archive-observability-spec.md`
- `docs/architecture/legacy-vs-current-gap-analysis.md`

## 建议阅读顺序

1. 先看总图和平台切分
2. 再看 GraphRAG 与 Memory
3. 再看世界状态和数据库模型
4. 再看 agent/workflow
5. 最后看前端工作台、观测和路线图
