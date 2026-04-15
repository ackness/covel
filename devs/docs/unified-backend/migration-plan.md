# 迁移与落地计划

## 阶段概览

```
Phase 0 · 基础对齐        ┐
                          ├──→  Phase 1 · PgStore 向量 Phase 2  ┐
                          └──→  Phase 2 · @covel/api-client      ├──→ Phase 3 · web-v2 接入 ──→ Phase 4 · 迁移工具 & 观测
                                                                  ┘
                                                                                       (Phase 5 · Electron Transport，未来)
```

- **Phase 1 与 Phase 2 零耦合，可并行**
- Phase 3 依赖 Phase 2 完成
- Phase 4 等 Phase 1 与 Phase 3 都收尾后再做

## 估时汇总

| Phase | 乐观 | 悲观 | 可并行 |
|---|---|---|---|
| 0 · 基础对齐 | 0.5 天 | 1 天 | 否 |
| 1 · PgStore 向量 | 1 天 | 2 天 | 与 Phase 2 并行 |
| 2 · api-client 包 | 2 天 | 3 天 | 与 Phase 1 并行 |
| 3 · web-v2 接入 | 1 天 | 2 天 | 否 |
| 4 · 迁移工具 & 观测 | 1 天 | 1.5 天 | 否 |
| **合计** | **5 天** | **8.5 天** | — |

## Phase 0 · 基础对齐

**目标**：为后续 Phase 清理环境，建立向量隔离的 schema 基础。

### 任务清单

- [ ] `docker-compose.yml` 主数据库镜像切换到 `pgvector/pgvector:pg17`（或最新稳定版）
- [ ] `apps/server/src/routes/api/bootstrap.ts` 启动期增加：
  - PG 档位：`CREATE EXTENSION IF NOT EXISTS vector`
  - SQLite 档位：预热 `sqlite-vec`（eager load，失败 fail fast）
- [ ] `packages/store/src/sqlite/schema.ts` 新增 `vector_models` 表
- [ ] `packages/store/src/postgres/schema.ts` 新增 `vector_models` 表
- [ ] `sessions` 表两边都加 `embedding_model_id` / `embedding_locked_at` 列
- [ ] 清理旧 `vec_memory_f{dim}` 表（一次性 `DROP TABLE IF EXISTS`）
- [ ] `packages/store/src/indexeddb/idb-store.ts` 类头加 `@deprecated` 注释
- [ ] 新增 `scripts/check-web-v2-imports.ts`（或 lint rule），禁止 `apps/web-v2/` 引用 `@covel/store/indexeddb`
- [ ] `apps/server/src/routes/api/misc-api.ts`（或 health 路由）扩展返回 backend + vector 状态摘要

### 验收

- `pnpm dev:pg` 能起来，日志输出 pgvector 版本
- `pnpm dev:server`（SQLite）能起来，日志输出 sqlite-vec 版本
- `/api/health` 返回 `vector.capable: true`
- `packages/store` 现有 contract 测试全绿（含向量测试 skip 或 pending 标记）

## Phase 1 · PgStore 向量 Phase 2

**目标**：让 PostgreSQL 后端的向量能力与 SQLite 完全对称。

### 任务清单

- [ ] 重写 `packages/store/src/sqlite/sqlite-vector.ts`：
  - 拆成"模型路由器" + "物理表 CRUD" 两层
  - 新增 `resolveVectorTarget(sessionId)` 内部辅助，带 in-memory cache
  - `upsertVector` / `searchVectors` / `deleteVectors` 走路由
  - 写入加维度校验
- [ ] 实现 `packages/store/src/postgres/pg-vector.ts`：
  - 与 sqlite-vector 同构的两层结构
  - 物理表 schema 按 `vector-storage-per-model.md` 落地
  - HNSW 索引创建参数：`m=16, ef_construction=64`
  - 查询默认 `ORDER BY embedding <-> $1 LIMIT k`
- [ ] `VectorStoreCapability` 接口若有小修改同步到 `packages/store/src/vector-store.ts`
- [ ] `packages/store/src/memory/memory-store.ts` 如果依赖旧向量接口也更新
- [ ] 扩展 `vector-store-contract.ts`：
  - 新增 `create session → auto lock model → upsert → search → session isolation` 全链路用例
  - 新增 `model switch → old table retained → switch back reuses` 用例
  - 新增 `dim mismatch → throws` 用例
- [ ] 跑 `vector-store-contract.ts` 两遍（SQLite + PG），全绿

### 验收

- `packages/store/tests/vector-store-per-model.test.ts` 新用例全绿
- `STORE_BACKEND=pg` 时手动创建两个 session，一个用 OpenAI embedding，一个用 Ollama embedding，检查 `vector_models` 表有两行，两张物理表都存在
- 切换回 OpenAI 新建第三个 session，确认复用第一张物理表

## Phase 2 · `@covel/api-client` 包

**目标**：从零构建类型化、零 React 依赖的 API 门面。

### 任务清单

- [ ] 新建 `packages/api-client/` 目录，`package.json`、`tsconfig.json`
- [ ] 添加到 `pnpm-workspace.yaml` 和 `turbo.json` 的 pipeline
- [ ] 实现 `transport/`：接口 + `HttpTransport` 默认实现
- [ ] 实现 `sse/parse-sse.ts` 和 `sse/event-stream.ts`
- [ ] 从 `@covel/shared` 补齐缺失的 Zod schema 导出（如果有）
- [ ] 依次实现 resources：
  - `health`, `worlds`, `sessions`, `messages`
  - `state`, `characters`, `plugin-data`
  - `traces`, `actions`, `events`
  - `llm-config`, `model-db`, `ui-specs`
- [ ] 实现 `ApiClient` 门面类
- [ ] 单元测试：每个 resource 至少一个正路径 + 一个错误路径
- [ ] 契约测试：启动 in-process `bootstrapApi()` 跑真实请求

### 验收

- `pnpm --filter @covel/api-client test` 全绿
- `pnpm --filter @covel/api-client build` 产出干净的 d.ts（或保持 src exports 直出）
- `ApiClient` 能通过 in-process server 完整跑通一次 session 创建 + 执行回合 + 读快照

## Phase 3 · web-v2 接入 ApiClient

**目标**：消除 web-v2 内部的零散 fetch 调用，统一走 `@covel/api-client`。

### 任务清单

- [ ] `apps/web-v2/package.json` 添加依赖 `"@covel/api-client": "workspace:*"`
- [ ] `apps/web-v2/src/services/api.ts` 改为 thin wrapper（持有 `ApiClient` 单例）
- [ ] `apps/web-v2/src/stores/session-store.ts` 内所有 fetch 调用替换为 `apiClient.*`
- [ ] 清理 `services/` 下不再使用的零散工具函数
- [ ] 如果有 `fetchEventSource` 或手写 SSE 解析，替换为 `apiClient.actions.run()` / `apiClient.events.stream()`
- [ ] 类型贯通：原手写 interface 若和 `@covel/shared` 类型等价就删掉
- [ ] E2E smoke test：开新 session、执行一个回合、resume 旧 session

### 验收

- `pnpm dev` 起来后，web-v2 前端完整跑通一个世界的 session
- `grep -r 'fetch(' apps/web-v2/src` 只剩 transport 层或静态资源下载
- 类型检查 `pnpm --filter @covel/web-v2 exec tsc --noEmit` 全绿

## Phase 4 · 迁移工具 & 可观测

**目标**：提供 SQLite ↔ PG 的单向导出导入工具，完善启动期与 runtime 观测。

### 任务清单

- [ ] `scripts/migrate-store.ts`：
  - 命令行参数：`--from sqlite --to pg` 或反向
  - 走 `DataStore` 接口遍历所有实体
  - 向量表默认**跳过**（输出 warning：目标 backend 懒重建）
  - 进度条 / 日志
  - 成功后自动运行 contract 测试 sanity check
- [ ] `/api/health` 最终形态（见 `architecture.md`）
- [ ] `/api/sessions/:id` 返回 `embedding: {...}` 字段
- [ ] 服务器启动日志输出 backend + vector 能力摘要
- [ ] 文档 `docs/reference/` 对应更新：
  - `architecture-flow.md` 补充向量模型锁定流程
  - `api.md` 记录新字段
  - `CLAUDE.md` Workspace Layout 加 `@covel/api-client`

### 验收

- 从 SQLite 迁一个真实 session 到 PG，二次打开能正常继续游戏
- `/api/health` 字段完整
- 文档同步

## Phase 5（未来）· Electron Transport

**触发条件**：启动 Electron 端项目

### 任务预览

- 实现 `IpcTransport`
- Electron 主进程内嵌 `@covel/server` 运行
- 渲染进程用 `new ApiClient({ transport: new IpcTransport(bridge) })`
- 打包产物：SQLite 模式默认 + 预埋 `.db` 模板

## 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| `sqlite-vec` 在 Windows/ARM Linux 缺 prebuilt | SQLite 档位启动失败 | CI 加所有 target smoke test，README 写明已知平台 |
| `pgvector/pgvector:pg17` 镜像版本与扩展 API 不兼容 | PG 档位启动失败 | 锚定镜像 tag（如 `pg17-v0.8.0`），不用 `latest` |
| Zod schema 在 `@covel/shared` 里没完全导出 | api-client 类型不准 | Phase 2 第一步先补全导出，再实现 resources |
| HNSW 索引构建对大表阻塞 | 首次导入慢 | 迁移脚本默认跳过向量数据，懒重建 |
| 现有 `session-store.ts` 内部 state 结构和 ApiClient 返回不完全一致 | Phase 3 改动面变大 | Phase 3 前先跑一遍 diff，识别不兼容字段提前在 Phase 2 补充 |
| web-v2 与 api-client 的 React Strict Mode double effect | SSE 订阅重复 | ApiClient 内部不做缓存，订阅幂等由 React 侧保证 |

## 回滚策略

- 每个 Phase 独立 commit / PR，失败时 revert 不影响其他 Phase
- Phase 0 和 Phase 1 的 schema 变更是**增量**的（新增列 / 新增表），不破坏旧 backend 行为
- Phase 3 改动在单一 PR 内，失败直接 revert web-v2
- Phase 4 迁移脚本只读不写源库（始终新建目标库），迁移失败不影响源数据
