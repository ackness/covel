# 统一后端数据层 · 设计文档

本目录记录 web-v2 前端迁移阶段对后端数据层的收口与扩展计划。核心目标：**所有客户端（web-v2、未来的 Electron、CLI）都通过统一的 HTTP/SSE 接口访问同一个后端，后端支持 SQLite（本地零运维）与 PostgreSQL + pgvector（多用户/RAG 增强）两档可切换，向量按 embedding 模型隔离存储。**

## 背景

- 旧版 `apps/web/` 引入了 `LocalDataService`（IDB）与 `RemoteDataService`（API）双路径，导致前端需要同时维护两套 CRUD、`syncToServer` 半同步语义容易出 bug。
- 新版 `apps/web-v2/` 已经无状态化，直接打 `/api/*`；本次工作延续这个方向，**彻底不再走浏览器 IDB**。
- `packages/store/` 的 `DataStore` 接口和 `store-contract` 测试套件已统一，SQLite / PG / Memory 三个后端行为一致，`STORE_BACKEND` 环境变量已经支持切换。
- `sqlite-vec` 已经可工作；`pgvector` 只有骨架（`pg-vector.ts` 抛 `SKELETON_NOT_IMPLEMENTED`）。
- NPC Graph RAG 插件已经进入默认插件列表，向量能力是刚需。

## 核心决策（已对齐）

| # | 决策 | 选项 |
|---|---|---|
| 1 | pgvector 是否强制 | **强制**：`STORE_BACKEND=pg` 档位启动时自动 `CREATE EXTENSION IF NOT EXISTS vector`，失败 fail fast，不降级 |
| 2 | sqlite-vec 是否默认启用 | **默认启用**：服务器 boot 时预热，RAG 是默认插件 |
| 3 | IdbStore 去留 | **冻结但保留**：`@deprecated` 标记 + CI lint 禁止 web-v2 import，源代码暂时不删 |
| 4 | PgStore 向量接口 | **与 sqlite-vec 对称**：实现 `VectorStoreCapability`，runtime 层自动切换，插件零感知 |
| 5 | ApiClient 归属 | **独立包 `@covel/api-client`**：零 React/DOM 依赖，为未来 Electron / CLI 复用；类型从 `@covel/shared` Zod schema 推导 |
| 6 | 向量表隔离策略 | **按 embedding 模型建独立物理表**：切换模型 = 换表，切回继承历史数据，session 启动后锁定，用户无感 |
| 7 | Model 身份规范 | `provider + model_name + dim` 组合键；**不**区分 baseUrl（代理视为同一模型） |
| 8 | 单 session 的 embedding 模型 | **一把锁**：一个 session 一个 embedding 模型，不支持 NPC Graph / Lorebook 使用不同模型 |
| 9 | 旧向量表清理 | 暂不实现，等真正占空间再加 `scripts/prune-vector-tables.ts` |
| 10 | Embedding slot 位置 | `llm.toml` 新增 `embedding` slot，与对话 slot 解耦；未配置则 RAG 静默禁用 |

## 文档索引

- **[architecture.md](./architecture.md)** — 统一后端数据层的整体架构、模块关系、两档部署形态
- **[vector-storage-per-model.md](./vector-storage-per-model.md)** — Embedding 模型隔离的向量表设计细节
- **[api-client-package.md](./api-client-package.md)** — `@covel/api-client` 独立包的结构、传输层抽象、Electron 复用路径
- **[migration-plan.md](./migration-plan.md)** — 分阶段落地计划、并行度、估时、风险
- **[decisions.md](./decisions.md)** — ADR 风格的决策记录，含被拒绝的备选方案和理由

## 非目标

本次工作**不**涉及：

- 会话分支 / 快照 UI（V1 也未完整实现，后端语义待补）
- Langfuse / 外部 tracing 集成
- 全文检索统一（SQLite FTS5 vs PG tsvector）
- 浏览器离线模式（IdbStore 彻底冻结）
- 向量维度漂移的自动回填（跨模型切换天然无漂移问题）
