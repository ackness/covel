# 架构决策记录（ADR）

本文件以 ADR 风格记录统一后端数据层工作中的关键决策、被拒绝的备选方案、以及决策依据。

---

## ADR-001 · 彻底移除浏览器侧数据存储路径

**决策日期**：2026-04-15

**背景**：旧版 `apps/web/` 引入了 `LocalDataService`（IndexedDB）与 `RemoteDataService`（API）双路径，运行期可切换。web-v2 已经事实上只走 API。

**决策**：新版不再支持浏览器侧存储。所有客户端都通过 `@covel/api-client` 调用后端 HTTP/SSE。

**备选方案**：
- (A) 保留 IDB 作为离线模式 → **拒绝**，同步语义复杂，双写容易出 bug，V1 的 `syncToServer` 就是痛点源头
- (B) 彻底切换到服务端 → **采纳**

**影响**：
- `packages/store/src/indexeddb/idb-store.ts` 标记 `@deprecated`，源码暂时保留但不在 V2 依赖图中
- 个人用户/离线场景由 SQLite 档位覆盖——依然零运维，只是数据落在本机文件而非浏览器

---

## ADR-002 · pgvector 在 PG 档位强制启用

**决策日期**：2026-04-15

**背景**：NPC Graph RAG 已经是默认插件，向量能力是刚需。PostgreSQL 后端之前的 `pg-vector.ts` 是空骨架。

**决策**：`STORE_BACKEND=pg` 时服务器启动自动执行 `CREATE EXTENSION IF NOT EXISTS vector`，失败 fail fast。docker-compose 锚定 `pgvector/pgvector:pg17` 镜像。

**备选方案**：
- (A) 运行时检测，缺失则降级到无向量模式 → **拒绝**，档位语义模糊，用户会遇到"怎么 RAG 时好时坏"的诡异问题
- (B) 启动强制 + 镜像锚定 → **采纳**，符合"docker compose up 开箱即用"的用户心智

**影响**：
- `docker-compose.yml` 必须使用 `pgvector/pgvector:*` 系列镜像
- 自建 PostgreSQL 的用户需要手动装扩展（文档记录）

---

## ADR-003 · sqlite-vec 默认启用 + 启动期预热

**决策日期**：2026-04-15

**背景**：当前 `sqlite-vec` 是懒加载，RAG 插件首次调用时才初始化。RAG 是默认插件后，懒加载的好处消失。

**决策**：服务器 boot 时 eager load `sqlite-vec`，加载失败 fail fast。单元测试路径保留 lazy fallback。

**备选方案**：
- (A) 保持懒加载 → **拒绝**，用户可能在第一次触发 RAG 插件时才发现 native 缺失
- (B) 启动预热 → **采纳**

**影响**：
- Windows / 某些 ARM 平台若 prebuilt 缺失，服务器直接起不来
- CI 需要覆盖所有目标平台的 smoke test
- 好处：错误暴露在 boot 阶段，用户心智简单

---

## ADR-004 · 向量表按 Embedding 模型隔离存储

**决策日期**：2026-04-15

**背景**：最初设计是按维度建表（`vec_memory_f{dim}`），但两个不同模型可能共享同一维度，向量空间不兼容却会挤在一张表里。

**决策**：每个 embedding 模型拥有独立物理表，通过 `vector_models` 注册表统一管理，物理表名为 `vec_mem_m{id}`。

**备选方案**：
- (A) 按维度分表 → **拒绝**，维度只是属性不是身份
- (B) 按 `provider + model_name + dim` 三元组分表 → **采纳**
- (C) 所有模型挤一张表，加 `model_id` 列 → **拒绝**，HNSW 索引无法按模型分片，检索性能差

**影响**：
- 需要 `vector_models` 注册表
- 切换模型变成换表，旧表原地保留，切回继承
- Session 启动后必须锁定 embedding 模型（见 ADR-005）

---

## ADR-005 · Session 启动后 Embedding 模型锁定

**决策日期**：2026-04-15

**背景**：如果一个 session 执行期间 embedding 模型变化，已经写入的向量和新向量分属不同空间，检索结果污染。

**决策**：`sessions` 表新增 `embedding_model_id` + `embedding_locked_at` 两列。`createSession()` 时一次性写入，之后任何代码路径不允许 UPDATE。`beginTurn()` 发现当前配置与锁定值不一致时，**静默以锁定值为准**并输出 info 级 trace。

**备选方案**：
- (A) 不锁定，让用户自由切换 → **拒绝**，会出现脏数据
- (B) 锁定但允许通过 API 显式解锁 → **拒绝**，引入一个几乎没人用的危险操作
- (C) 锁定 + 发散时使用锁定值 → **采纳**

**影响**：
- 用户感知为零——切 embedding 模型只影响新 session
- 如果锁定的 model 被从注册表删除（人为操作），resume 时 fail fast 给出明确指引

---

## ADR-006 · Embedding Model 身份 = `provider + model_name + dim`

**决策日期**：2026-04-15

**背景**：如何判定两个 embedding 配置是"同一个模型"？

**决策**：组合键 = `provider + model_name + dim`，**不**包含 baseUrl / apiVersion。`model_id` 规范化为 `"${provider}/${model_name}"`。

**备选方案**：
- (A) 只用 `model_name` → **拒绝**，不同 provider 可能有同名模型
- (B) 加上 baseUrl 指纹 → **拒绝**，用户切换代理地址会误判为新模型，导致数据"丢失"
- (C) `provider + model_name + dim` → **采纳**，dim 作为安全校验防止 provider 偷偷改维度

**影响**：
- Azure 代理和 OpenAI 官方 API 视为同一模型，共享存储
- provider 若在未来某天静默改变维度，`UNIQUE (model_id, dim)` 约束会触发错误提示

---

## ADR-007 · 一个 Session 一把 Embedding 锁

**决策日期**：2026-04-15

**背景**：是否允许同一 session 内不同插件使用不同 embedding 模型（例如 NPC Graph 用 OpenAI、Lorebook 用本地 Ollama）？

**决策**：**不允许**。一个 session 只绑定一个 embedding 模型，所有 RAG 插件共享。

**备选方案**：
- (A) 支持多锁，按 `(sessionId, usage)` 绑定 → **拒绝**，复杂度与收益不成正比
- (B) 一 session 一锁 → **采纳**，KISS 原则

**影响**：
- 想要"代码向量 + 叙事向量"混用的进阶场景暂不支持
- Schema 不排斥未来扩展：新增一张 `session_embedding_locks (session_id, purpose, model_id)` 即可

---

## ADR-008 · 抽取 `@covel/api-client` 独立包

**决策日期**：2026-04-15

**背景**：未来要做 Electron 桌面端，需要大量代码复用；CLI 工具和脚本也需要稳定的 API 客户端。

**决策**：新建 `packages/api-client/`，零 React 依赖，纯 TypeScript。通过 `Transport` 接口抽象传输层，默认实现 `HttpTransport`，未来可扩展 `IpcTransport`。

**备选方案**：
- (A) 放在 `apps/web-v2/src/services/` 本地文件 → **拒绝**，Electron / CLI 无法复用
- (B) 独立包 `@covel/api-client` → **采纳**

**影响**：
- 新增一个 package，轻微增加 monorepo 复杂度
- 明确为 Electron 阶段预留扩展点
- V1 的 DataService 接口设计被"部分保留"——保留类型化 client 门面，抛弃双后端分叉

---

## ADR-009 · 类型从 `@covel/shared` Zod Schema 派生

**决策日期**：2026-04-15

**背景**：`@covel/api-client` 的请求/响应类型如何与服务端保持同步？

**决策**：所有类型用 `z.infer` 从 `@covel/shared` 已有的 Zod schema 派生，零手写 interface。服务端路由已经在用同一批 schema 做验证，天然一致。

**备选方案**：
- (A) 手写 interface → **拒绝**，维护双份定义
- (B) 代码生成（如 OpenAPI） → **拒绝**，引入工具链
- (C) `z.infer` 直接复用 → **采纳**

**影响**：
- `@covel/shared` 需要补齐缺失的公开导出（Phase 2 第一步）
- 类型永远与服务端路由的验证 schema 一致

---

## ADR-010 · 向量表清理工具暂不实现

**决策日期**：2026-04-15

**背景**：用户长期切换 embedding 模型后，`vector_models` 表会留下一批无 session 引用的物理表。

**决策**：暂不实现清理工具。等真正占用可见空间或用户反馈时再做。

**备选方案**：
- (A) 立即实现 `scripts/prune-vector-tables.ts` → **拒绝**，过度设计
- (B) 延后到实际需要 → **采纳**

**影响**：
- 磁盘占用在多模型切换场景会缓慢增长
- 未来加清理脚本的成本不高（一个遍历 + DROP）

---

## ADR-011 · 数据库迁移工具默认跳过向量表

**决策日期**：2026-04-15

**背景**：SQLite → PG 的迁移脚本是否要同时迁移向量数据？

**决策**：默认跳过向量表，让目标 backend 懒重建。脚本输出明确 warning 告知用户。

**备选方案**：
- (A) 完整迁移向量数据 → **拒绝**，两边 HNSW 参数/存储格式不同，需要重建索引，且没有 embedding 源文本时无法重算
- (B) 跳过 + 警告 → **采纳**，让用户在新 backend 上重新触发 RAG 插件即可重建

**影响**：
- 迁移后首次调用 RAG 时会有一个"冷启动"期
- 元数据（sessions / messages / state / plugin_data）保证完整迁移

---

## ADR-012 · 新增 `embedding` slot 到 `llm.toml`

**决策日期**：2026-04-15

**背景**：当前 `llm.toml` 只有对话相关的 slot（`default` / `fast` / `balance` / `image`），没有专门的 embedding slot。

**决策**：新增 `embedding` slot 专用于向量化配置。未设置时 RAG 静默禁用，`sessions.embedding_model_id = NULL`。

**备选方案**：
- (A) 复用 `default` slot 的 provider 解析 embedding 模型 → **拒绝**，对话模型和 embedding 模型通常不是同一个
- (B) 新增 `embedding` slot → **采纳**

**影响**：
- `llm.toml.example` 补充示例
- `@covel/ai-provider` 的 slot resolver 增加一条分支
- 文档 `docs/reference/` 更新 slot 清单
