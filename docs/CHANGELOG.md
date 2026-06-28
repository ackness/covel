# Changelog

All notable changes to this project will be documented in this file. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.9] - 2026-06-28

A playability-loop pass — function runtimes become visible in the trace timeline, stale suspensions expire, and player-input narrative localizes by session locale — plus a follow-up engineering batch: multi-node S3 media metadata on Postgres, plugin-utils provider-call tracing, a `/debug` cost panel, and community plugin uninstall/revoke. The default world and bundled plugins are behavior-unchanged.

### Added

- **Function-runtime trace coverage (A2-P1-5).** Function runtimes were near-invisible in `/debug` — nothing between `runtime.started`/`completed`, and zero rows for `ctx.gateway` provider calls. They now emit `function.executing` / `function.completed` (handler boundary) and, via a `withGatewayTrace` wrapper applied at execution time, `gateway.calling` / `gateway.responded` / `gateway.failed` for `generateText`/`generateObject` — all persisted to `trace_events` and broadcast, so a function runtime's LLM usage is as visible as an agent runtime's. The five events join the single-source `CovelEvent` union (compile-time exhaustive over `COVEL_EVENT_META` + the frontend switch). A missing handler now emits a terminal `runtime.failed` instead of leaving a hanging `runtime.started`.
- **Plugin-utils provider-call trace.** Closes the A2-P1-5 follow-up: image plugins (and any plugin owning its wire) call providers via `ctx.utils.fetchWithRetry`, which a `withUtilsTrace` wrapper now traces as `utils.fetch.calling` / `responded` / `failed` (trace-only, `forwardToActionStream:false`) at both the function-runtime and agent-guard injection sites. PII-safe — payloads carry only host / method / status / durationMs, never the full URL, query, or API key.
- **Multi-node S3 media metadata on Postgres.** `createPgS3MetadataAdapter` (+ `…FromClient`) implements the `S3MediaMetadataAdapter` interface over the shared `media_assets` / `media_refs` PG tables, so S3-backed media survives restarts and is shared across nodes — the SQLite adapter only covered a single node. Mirrors the SQLite adapter 1:1 and passes the same media-store contract suite against a real Postgres.
- **`/debug` token cost panel.** A new Cost view aggregates `usage` from `llm.responded` / `gateway.responded` trace events by runtime, by turn, and session-total (zero-dependency CSS bars), aggregating generically by event type + runtime id. _USD cost is a pending follow-up — `llm.responded` payloads don't yet carry the model id needed for `usage × pricing`._
- **Community plugin uninstall + approval revoke.** `DELETE /api/plugins/:id` removes a third-party plugin from the user plugins dir (rejects builtin ids, returns `restartRequired:true`); `DELETE /api/sessions/:id/approvals[?pluginId=]` revokes cached approval grants via the new `gate.revoke`. The Settings → Packages pane lists installed third-party plugins with an uninstall button. Closes the only missing stage of the community discover→approve→import→active lifecycle (the import stage was already live; docs were stale).

### Changed

- **`submit-form` is now locale-aware.** The `confirmation` `{{confirmed}}` value (确认/取消) and the fallback-narrative prefixes (`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`) were hardcoded Chinese; they now resolve by **session locale** (threaded in via a new `RpcHandlerContext.locale`, sourced from `session.locale` in the plugin-rpc dispatch — no executor change). `en-US` yields `Confirm`/`Cancel` + `[Player input]`/…; unknown locales fall back to zh-CN, byte-for-byte identical to the previous output. `submit-form`'s `Submission.type` now references the single-source `InteractionType` union.
- **Dependencies bumped to latest stable.** All workspace dependencies updated to their latest stable under the existing `minimumReleaseAge: 10080` (1-week) gate — including the major bumps `@hono/node-server` 1→2, `electron` 41→42, `@types/node` 25→26, `@json-render/*` 0.18→0.19, and `zod` 4.3→4.4. One breaking change handled: zod 4.4 treats a bare `z.unknown()` inside a `.strict()` object as a required key, so the plugin user-setting `default` field gained an explicit `.optional()`. Verified across the full workspace lint + test (incl. real Postgres), server boot, API e2e, and the desktop (electron 42) typecheck.
- **Dependency-hygiene gate + scaffold alignment.** Added `knip` as a CI `deps:check` gate (catches unused/missing workspace deps; understands JSDoc type imports + test files, so type-only/test-only deps aren't false-flagged), cleaned 12 stale plugin devDeps, and aligned the `@covel/create` scaffold to emit correctly-layered minimal deps per template. The authoring guide gains a dependency-layering + extraction-threshold section.

### Fixed

- Function runtimes no longer leave a hanging `runtime.started` when the handler is missing or throws — a terminal `runtime.failed` (and `function.completed{status:failed}`) is emitted on every exit path.
- **`/api/ui-specs` no longer 500s when one plugin's runtime fails to load.** A single bad runtime (corrupt UI spec, missing handler dep) used to take down the whole response on every world open; it is now logged and skipped while healthy plugins still resolve. `app.onError` additionally logs request context (method + full URL) for every 500.
- **Desktop packaging now stages plugin-only workspace deps.** 5 bundled function plugins depend on `@covel/plugin-handlers-utils` (used by plugins, never by `@covel/server`), which `pnpm deploy --filter @covel/server` left out — so every packaged build shipped them broken with `ERR_MODULE_NOT_FOUND`. The desktop build now scans each plugin's `@covel/*` runtime deps and stages any the server deploy missed; the post-staging smoke test fails on plugin-load errors instead of swallowing them.

<details>
<summary>中文（备份翻译）</summary>

一次可玩性闭环整理（function runtime 在 trace 时间线可见、陈旧挂起项过期、玩家输入叙事按会话 locale 本地化），外加一批工程收尾：Postgres 上的多节点 S3 媒体元数据、plugin-utils provider 调用 trace、`/debug` 成本面板、社区插件卸载/撤销。默认世界与内置插件行为不变。

**Added**

- **Function-runtime trace 覆盖（A2-P1-5）**：function runtime 此前在 `/debug` 几乎不可见——`runtime.started`/`completed` 之间空白，`ctx.gateway` provider 调用零记录。现在发射 `function.executing` / `function.completed`（handler 边界），并经执行期 `withGatewayTrace` 包裹对 `generateText`/`generateObject` 发 `gateway.calling` / `gateway.responded` / `gateway.failed`——全部持久化到 `trace_events` 并广播，使 function runtime 的 LLM 用量与 agent runtime 同等可见。五个事件纳入单一真相 `CovelEvent` union（对 `COVEL_EVENT_META` 与前端 switch 编译期穷尽）。缺失 handler 现在发终结 `runtime.failed`，不再留悬空 `runtime.started`。
- **Plugin-utils provider 调用 trace**：收尾 A2-P1-5 follow-up。图像插件（及任何自带 wire 的插件）经 `ctx.utils.fetchWithRetry` 调 provider，现由 `withUtilsTrace` 包裹器在 function-runtime 与 agent-guard 注入处 trace 为 `utils.fetch.calling` / `responded` / `failed`（trace-only，`forwardToActionStream:false`）。PII 安全——负载仅含 host / method / status / durationMs，绝不含完整 URL、query、api key。
- **Postgres 上的多节点 S3 媒体元数据**：`createPgS3MetadataAdapter`（+ `…FromClient`）在共享 `media_assets` / `media_refs` PG 表上实现 `S3MediaMetadataAdapter` 接口，使 S3 媒体跨重启存活、跨节点共享——此前 SQLite 适配器只覆盖单节点。1:1 镜像 SQLite 版，并对真实 Postgres 通过同一 media-store 契约套件。
- **`/debug` token 成本面板**：新增 Cost 视图，按 runtime / turn / 会话总计聚合 `llm.responded` / `gateway.responded` 的 `usage`（零依赖 CSS 条形），按事件类型 + runtime id 通用聚合。_美元成本为待办 follow-up——`llm.responded` 负载尚未携带 `usage × pricing` 所需的 model id。_
- **社区插件卸载 + 审批撤销**：`DELETE /api/plugins/:id` 从用户插件目录删除第三方插件（拒绝内置 id，返回 `restartRequired:true`）；`DELETE /api/sessions/:id/approvals[?pluginId=]` 经新增 `gate.revoke` 撤销缓存授权。Settings → Packages 面板列出已安装第三方插件并提供卸载按钮。收尾社区 discover→approve→import→active 生命周期唯一缺失的阶段（import 阶段早已实现，文档此前陈旧）。

**Changed**

- **`submit-form` 现按 locale 本地化**：`confirmation` 的 `{{confirmed}}` 取值（确认/取消）与回退叙事前缀（`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`）此前写死中文；现按**会话 locale** 解析（经新增的 `RpcHandlerContext.locale` 注入，来源是 plugin-rpc dispatch 的 `session.locale`，无需改 executor）。`en-US` 产出 `Confirm`/`Cancel` + `[Player input]`/…；未知 locale 回落 zh-CN，与改前输出逐字一致。`submit-form` 的 `Submission.type` 现引用单一真相 `InteractionType` union。
- **依赖升级到最新 stable**：全部 workspace 依赖在既有 `minimumReleaseAge: 10080`（1 周）门控下升到最新 stable——含跨 major 的 `@hono/node-server` 1→2、`electron` 41→42、`@types/node` 25→26、`@json-render/*` 0.18→0.19、`zod` 4.3→4.4。处理了一处 breaking：zod 4.4 把 `.strict()` object 内裸 `z.unknown()` 当作必填 key,故插件 user-setting 的 `default` 字段显式加 `.optional()`。已通过全 workspace lint + test（含真实 Postgres）、server 启动、API e2e 与 desktop（electron 42）typecheck 验证。
- **依赖卫生 gate + 脚手架对齐**：新增 `knip` 作为 CI `deps:check` 关卡（拦截 unused/missing workspace 依赖；识别 JSDoc 类型引用与测试文件，不误杀 type-only/test-only 依赖），清理 12 个 stale 插件 devDep，并让 `@covel/create` 脚手架按 template 生成正确分层的最小依赖。插件指南新增"依赖分层与复用规范"章节。

**Fixed**

- function runtime 在 handler 缺失或抛错时不再留悬空 `runtime.started`——每条退出路径都发终结 `runtime.failed`（及 `function.completed{status:failed}`）。
- **`/api/ui-specs` 不再因单个插件 runtime 加载失败而 500**：一个坏 runtime（损坏的 UI spec、缺失的 handler 依赖）此前会在每次打开世界时拖垮整个响应；现在记录并跳过,健康插件照常返回。`app.onError` 还会为每个 500 记录请求上下文（method + 完整 URL）。
- **桌面打包现在 stage 插件专属的 workspace 依赖**：5 个内置 function 插件依赖 `@covel/plugin-handlers-utils`（只被插件用、不被 `@covel/server` 用），`pnpm deploy --filter @covel/server` 把它漏掉了——导致每个打包版本都带着 `ERR_MODULE_NOT_FOUND` 的坏插件。桌面构建现在扫描每个插件的 `@covel/*` 运行时依赖并补 stage server deploy 漏掉的；打包后的 smoke test 现在会因插件加载失败而失败,不再静默吞掉。

</details>

## [0.0.8] - 2026-06-28

Eighth public release. Finishes the v0.0.7 architecture pass — clears the remaining audit debt, makes the schema and transaction layers single-source-of-truth, and ships **semantic (vector) memory recall**, all verified end-to-end against a real pgvector Postgres. New game genres can declare their own memory blocks, and a session can switch storage backends without any behaviour change. The default world and bundled plugins are behavior-unchanged.

### Added

- **Semantic (vector) memory recall.** The memory tier now embeds turn messages (recall) and lorebook + character records (archival) on write — a post-turn, best-effort sweep that never blocks the turn — and serves KNN recall over them, falling back to keyword search per-session when no embedding model is locked. Embed-on-write ingestion is incremental (a persisted cursor + content hashes) and self-heals deleted records; backfill of existing sessions runs in the same path. Wired through a single injected `embed` seam so `@covel/memory` still depends only on `shared` + `store`. Verified end-to-end on real pgvector Postgres.
- A real-pgvector `vector-store` contract branch (PgStore) — the production vector path (`upsertVector` / `searchVectors` / `deleteVectors` via the `vector` type + pgvector operators) now has automated coverage it previously lacked, plus a memory-vector × PgStore integration test.
- `@covel/settings` package — the unified `SettingsStore` + its platform backends (browser localStorage, Electron-IPC json-file) split out of `@covel/shared`, so pure-types consumers no longer pull in browser/Electron code.

### Changed

- **Store schema is now single-source-of-truth.** The boot DDL is derived at module load from the Drizzle schema (`buildCreateTablesSql`), so a column or index is declared once and the executed DDL can never drift from it; only the bits Drizzle can't model (triggers, idempotent column migrations) stay hand-written. Identifiers are quoted uniformly.
- **Transactions are scoped to a single commit.** Production turn-commit / session-create / world-data-sync / snapshot-fork callers moved from the global imperative `beginTx`/`commitTx` shim to `withTransaction(fn)` (real pooled-Postgres transactions; nested calls on serial backends are rejected, not deadlocked), removing the all-database serialization window.
- `runtime/src`'s 56 flat files are organized into 13 sub-domain directories (trigger / schedule / agent-loop / commit / session / trace / snapshot / rpc / resume / llm / retry / function-runtime); the public barrel is byte-identical.
- Cleared remaining v0.0.7 audit debt: priority-band literals collapse to `isPreGamePriority()` / `NARRATOR_PRIORITY`; the two frontend SSE channels share one event reducer; `CompactorLLMAdapter` + `MemoryLLMAdapter` converge into a shared `SimpleCompletionAdapter`; the Anthropic cache-breakpoint cap is one shared constant.
- **Removed the duplicate turn entrypoint.** `POST /api/sessions/:id/turn` was a mounted-but-frontend-unreachable second turn pipeline; `/api/actions` is now the single turn-execution route. Its tests migrated to `/api/actions`.
- Bumped all monorepo package versions `0.0.7` → `0.0.8`.

### Fixed

- **Cross-backend vector parity.** A real-PG vector contract immediately surfaced two PgStore-only bugs the Memory/SQLite backends hid: a `freshSchema` store kept stale rows because the dynamic `vec_mem_*` tables were not dropped, and the upsert/delete paths were untested. A fresh store now starts empty on every backend — the same data, the same API, switch backend freely.
- **memory recall data-loss / staleness.** The recall cursor no longer advances past a message that got an empty embedding (which would drop it from recall forever); short vector results during backfill are topped up with keyword hits so the most recent messages aren't missed; deleted lorebook/character vectors are purged instead of returned as stale hits.
- **Snapshot-fork orphaned media refs.** `mediaStore.addRef` (a cross-store write the DataStore transaction can't roll back) moved to run after the fork commits, so a rolled-back fork (e.g. the cursor-missing 409 path) can no longer leave an orphan ref.
- Postgres contract suite no longer races the system catalog under parallel runs (per-file database isolation + single-connection `freshSchema` DDL).

<details>
<summary>中文（备份翻译）</summary>

第八个公开版本。收尾 v0.0.7 的架构整理——清掉剩余审计债，让 schema 与事务层成为单一真相源，并交付**向量语义记忆召回**，全部用真实 pgvector Postgres 端到端验证。新游戏类型可声明自己的记忆块；一个会话可在不改变任何行为的前提下切换存储后端。默认世界与内置插件行为不变。

**Added**

- **向量语义记忆召回**：记忆层在写入时把 turn 消息（recall）与 lorebook + 角色记录（archival）embedding（回合后 best-effort sweep，绝不阻塞回合），并对其做 KNN 召回；未锁定 embedding 模型时按会话回退关键词检索。写入时 ingestion 增量（持久游标 + 内容哈希）、自愈已删记录、历史会话回填走同一路径。经单一注入的 `embed` seam 接入，`@covel/memory` 仍只依赖 `shared` + `store`。真实 pgvector Postgres 端到端验证。
- `vector-store` 契约新增 PgStore（真 pgvector）分支——生产向量路径此前零自动化覆盖，现已补上，外加 memory 向量 × PgStore 集成测试。
- `@covel/settings` 包——统一 `SettingsStore` 及平台后端（浏览器 localStorage、Electron-IPC json-file）从 `@covel/shared` 拆出，纯类型消费方不再被迫拖入浏览器/Electron 代码。

**Changed**

- **存储 schema 单一真相源**：boot DDL 在模块加载时由 Drizzle schema 派生（`buildCreateTablesSql`），列/索引只声明一次、执行的 DDL 不可能漂移；只有 Drizzle 无法建模的部分（触发器、幂等列迁移）保留手写。标识符统一加引号。
- **事务作用域绑定到单次提交**：生产的回合提交/建会话/world-data 同步/快照 fork 调用方从全局命令式 `beginTx`/`commitTx` 垫片迁到 `withTransaction(fn)`（真实 Postgres 池化事务；串行后端的嵌套被拒绝而非死锁），消除全库串行化窗口。
- `runtime/src` 的 56 个扁平文件整理进 13 个子领域目录；公开 barrel 逐字节不变。
- 清掉剩余 v0.0.7 审计债：priority band 字面量收成 `isPreGamePriority()`/`NARRATOR_PRIORITY`；前端两条 SSE 通道共用一个事件 reducer；`CompactorLLMAdapter` + `MemoryLLMAdapter` 合并为共享 `SimpleCompletionAdapter`；Anthropic 缓存断点上限收成单一常量。
- **移除重复的回合入口**：`POST /api/sessions/:id/turn` 是已挂载但前端不可达的第二条回合管线；`/api/actions` 现为唯一回合执行路由，其测试已迁移。
- 所有 monorepo 包版本 `0.0.7` → `0.0.8`。

**Fixed**

- **跨后端向量一致性**：真 PG 向量契约立刻暴露两个 Memory/SQLite 后端掩盖的 PgStore 专属 bug——`freshSchema` 的 store 因动态 `vec_mem_*` 表未被 drop 而残留旧数据，且 upsert/delete 路径未测。现在 fresh store 在每个后端都从空开始——同样的数据、同样的 API、自由切换后端。
- **memory 召回数据丢失/陈旧**：召回游标不再越过 embedding 为空的消息（否则永久丢失）；回填期向量结果不足时用关键词补足，不漏最近消息；已删 lorebook/角色向量被清除而非作为陈旧命中返回。
- **快照 fork 孤儿 media ref**：`mediaStore.addRef`（DataStore 事务回滚不了的跨 store 写）挪到 fork 提交后执行，回滚的 fork（如 cursor-missing 409）不再留下孤儿 ref。
- Postgres 契约套件在并行下不再竞争系统目录（每文件独立库 + 单连接 `freshSchema` DDL）。

</details>

## [0.0.7] - 2026-06-27

Seventh public release. An architecture-optimization pass over the kernel and store: duplicated contracts collapse to single, compile-time-enforced sources of truth; the SQLite and Postgres store query layers unify behind one shared adapter with cross-backend parity verified against a real Postgres; and a batch of latent correctness bugs are fixed. The default world and bundled plugins are behavior-unchanged.

### Added

- `memoryBlocks` manifest field + `MemoryBlockSchema`: core memory blocks are now declared as data by a plugin or world package (the default four — story state / relationships / scene / player profile — ship on the builtin `memory` plugin and are aggregated at bootstrap by trust tier). A new game genre can define its own blocks (`clues` / `suspects` / …) without forking the framework core
- cost-gate per-session token budget via `userSettings`, read in-hook through `HookContext.getOwnSettings()`, with a `COST_GATE_SOFT/HARD_TOKENS` env fallback for env-only deployments
- `/api/ui-specs` now validates each panel spec against a Zod schema with a `specVersion`, returns per-spec diagnostics instead of a generic error, and caches discovery by content signature instead of re-scanning + rewriting on every request
- A real-Postgres-verified store contract run (713 cases) plus new parity / drift-guard tests: proposal-type ↔ commit-handler ↔ discovery alignment, the SSE event union, hook events, DDL ↔ Drizzle index consistency, table-registry coverage, cross-backend null / `compactedAtTurnId` round-trip, and the prompt cache-breakpoint limit

### Changed

- **Single sources of truth (compile-time exhaustive).** Proposal types (payload map + discriminated union, handlers `satisfies Record<ProposalType, …>`), SSE events (one `CovelEvent` union driving the forward whitelist + an exhaustive frontend switch), hook events (`HOOK_EVENTS`), framework capabilities (typed registry), and provider protocols (`ProtocolRegistry`) each now live in one place — adding one is a single edit and a missing handler/case is a compile error
- **Store query layer unified.** The mirrored SQLite/Postgres record modules collapse behind one async `SqlRunner` (better-sqlite3's sync driver wrapped awaitable, postgres-js already async); SQLite snapshots / suspensions converted from hand-written SQL to drizzle, so the SQLite backend now has zero hand-written record SQL. Cascade-delete / drop-list / memory-snapshot table sets derive from a single table-registry, and `withTransaction(fn)` scopes a transaction to one commit (real pooled Postgres transaction; nesting on serial backends is rejected, not deadlocked)
- `DataStore`'s 82-method god-interface split into 21 domain sub-interfaces composed back into `DataStore` (shape unchanged); `gateway.ts`'s 7 operations collapse into one `runOperation`; `parsePluginMd`'s repeated lenient-field blocks become a data-driven table
- `LLMAdapter` / `LLMResponse` moved to `@covel/shared`, removing the only wrong-layer edge in the dependency graph (`create → runtime`)
- Trigger modes `conditional` / `error-retry` are explicitly marked **reserved** (they never fire in production); in-turn event fan-out reuses the single `shouldTrigger` authority
- Deleted the never-implemented `SessionTransport` interface and unused command-protocol types; pruned unwired prompt-assembler stubs; hoisted the Anthropic cache-breakpoint cap to a single shared `MAX_CACHE_BREAKPOINTS`
- memory recall / archival are now honestly documented as keyword-based — the vector primitives exist but the embed-on-write ingestion path does not, so a vector searcher would query empty tables; the swap seam is reserved and documented
- Bumped all monorepo package versions `0.0.6` → `0.0.7`; refreshed the README bundled-plugin table (16 → 19, adding `cost-gate` / `director` / `story-guard`)

### Fixed

- **Resume lost runtime resilience.** A suspended-then-resumed agent runtime bypassed retry / loop-detection / streaming (it called the LLM directly); resume now folds into the shared tool loop and goes through the same retry policy as a normal turn
- **Cross-backend data loss.** SQLite `appendTurnMessage` dropped `compactedAtTurnId` on insert while Postgres / memory / IDB persisted it; all backends now agree (pinned by a parity contract test). `createSession` / `updateSession` also serialize optional fields uniformly across backends
- Production Postgres now creates the `trace_events` `trace_id` / `turn_id` indexes (declared in Drizzle but absent from the runtime DDL); a DDL ↔ Drizzle consistency test guards the drift
- `openai-responses` streaming now accumulates function-call deltas — agent runtimes on that protocol previously lost every tool call silently
- `/api/discovery` no longer advertises proposal types with no commit handler (`record.upsert` / `narrative.template`, removed); the `working_memory.changed` SSE event is in the shared union and is no longer dropped by the frontend
- The reserved builtin plugin-id list is derived from the bundled plugins instead of a hand-kept list that had drifted to 8/19 (it guards third-party name-squatting)
- cost-gate's env-var budget fallback is reachable again — a declared `userSettings` default silently shadowed it, so a custom env value was ignored
- The Postgres contract suite no longer races the system catalog under parallel runs (per-file database isolation + single-connection `freshSchema` DDL)

<details>
<summary>中文（备份翻译）</summary>

第七个公开版本。对内核与存储层的一次架构优化：把重复的契约收口为单一、编译期强制的真相源；将 SQLite 与 Postgres 的存储查询层统一到一个共享适配器之后，并用真实 Postgres 验证跨后端行为一致；并修复一批潜在的正确性 bug。默认世界与内置插件行为不变。

**Added**

- `memoryBlocks` manifest 字段 + `MemoryBlockSchema`：核心记忆块现由插件/世界包以数据形式声明（默认四块——剧情状态/关系/场景/玩家档案——随内置 `memory` 插件提供，启动时按信任层级聚合）。新游戏类型可定义自己的记忆块（`clues`/`suspects`…）而无需 fork 框架
- cost-gate 每会话 token 预算改用 `userSettings`，hook 内经 `HookContext.getOwnSettings()` 读取，并保留 `COST_GATE_SOFT/HARD_TOKENS` 环境变量兜底
- `/api/ui-specs` 现按 Zod schema（含 `specVersion`）校验每个面板 spec、返回逐 spec 诊断、并按内容签名缓存发现结果（不再每次请求扫盘重写）
- 一次真实 Postgres 验证的 store 契约（713 用例），以及新增的 parity / 防漂移测试：proposal 类型↔commit handler↔discovery 对齐、SSE 事件 union、hook 事件、DDL↔Drizzle 索引一致性、表注册表覆盖、跨后端 null / `compactedAtTurnId` 往返、prompt 缓存断点上限

**Changed**

- **单一真相源（编译期穷尽）**：Proposal 类型、SSE 事件（单一 `CovelEvent` union）、hook 事件（`HOOK_EVENTS`）、框架 capability（typed registry）、provider 协议（`ProtocolRegistry`）各自收口到一处——新增一个只改一处，漏一个 handler/case 即编译失败
- **存储查询层统一**：镜像的 SQLite/Postgres record 模块收敛到一个异步 `SqlRunner` 之后；SQLite snapshots/suspensions 从裸 SQL 转为 drizzle，SQLite 后端现已零手写 record SQL。级联删除/落表清单/记忆快照的表集由单一表注册表派生；`withTransaction(fn)` 将事务作用域绑定到单次提交（真实 Postgres 池化事务；串行后端的嵌套会被拒绝而非死锁）
- `DataStore` 的 82 方法上帝接口拆成 21 个领域子接口再组合（形状不变）；`gateway.ts` 的 7 个操作收敛为一个 `runOperation`；`parsePluginMd` 的重复 lenient 块改为数据驱动的表
- `LLMAdapter`/`LLMResponse` 移到 `@covel/shared`，消除依赖图里唯一的错位边（`create → runtime`）
- 触发模式 `conditional`/`error-retry` 明确标注为 **reserved**（生产从不触发）；回合内事件 fan-out 复用单一 `shouldTrigger`
- 删除从未实现的 `SessionTransport` 接口与未用的命令协议类型；清理未接线的 prompt-assembler 残桩；把 Anthropic 缓存断点上限提成单一共享的 `MAX_CACHE_BREAKPOINTS`
- memory recall/archival 现诚实记录为关键词检索——向量原语存在但缺少写入时 embedding 的 ingestion，向量检索会查空表；扩展点已预留并文档化
- 所有 monorepo 包版本 `0.0.6` → `0.0.7`；刷新 README 内置插件表（16 → 19，补 `cost-gate`/`director`/`story-guard`）

**Fixed**

- **Resume 丢失运行时韧性**：挂起后恢复的 agent runtime 绕过了重试/循环检测/流式（它直接调 LLM）；resume 现在并入共享工具循环，走与正常回合相同的重试策略
- **跨后端数据丢失**：SQLite `appendTurnMessage` 在 insert 时丢掉 `compactedAtTurnId`，而 Postgres/memory/IDB 保留；现所有后端一致（由 parity 契约测试钉住）。`createSession`/`updateSession` 的可选字段序列化也跨后端统一
- 生产 Postgres 现会创建 `trace_events` 的 `trace_id`/`turn_id` 索引（Drizzle 声明了但运行时 DDL 缺失）；DDL↔Drizzle 一致性测试守护漂移
- `openai-responses` 流式现累积 function-call 增量——此前该协议下的 agent runtime 会静默丢掉每一次工具调用
- `/api/discovery` 不再广告没有 commit handler 的 proposal 类型（已删除 `record.upsert`/`narrative.template`）；`working_memory.changed` SSE 事件已纳入共享 union，前端不再丢弃
- 保留的内置 plugin-id 名单改为从内置插件派生，取代漂移到 8/19 的手维护列表（它用于防第三方占名）
- cost-gate 的环境变量预算兜底重新可达——一个声明的 `userSettings` 默认值曾静默压过它，导致自定义 env 值被忽略
- Postgres 契约套件在并行运行下不再竞争系统目录（每文件独立库隔离 + 单连接 `freshSchema` DDL）

</details>

## [0.0.6] - 2026-06-26

Sixth public release. Expands the runtime hook system from 8 to 16 lifecycle events, ships the first plugins that consume them, and lands a batch of runtime-architecture refactors and static-audit fixes. The default world and bundled plugins are behavior-unchanged — the new hooks are dormant infrastructure and the three new plugins are opt-in.

### Added

- Hook lifecycle expanded 8 → 16 events: `PreLLMCall` / `PostLLMResponse` (non-destructively rewrite a per-call request / patch the response before tool dispatch), `PostContextAssembly` (turn-level system-prompt / history shaping), `PreSchedule` (narrow which runtimes run this turn), `PreCompaction` / `PostCompaction` (veto / observe history compaction), `SessionStart` / `SessionEnd` (session lifecycle), and `PostToolUse.terminate` (end the tool loop after recording a result)
- Session-scoped hook pipeline: the global pipeline now filters hooks by the session's active plugins via `AsyncLocalStorage`, so a plugin's hooks only fire for sessions where it is active
- `HookContext.getOwnSettings()`: a hook can read its own plugin's per-session `userSettings` (turn-level, read-only, deep-frozen snapshot)
- Three new opt-in plugins — the first hook consumers: `cost-gate` (per-session token budget; included by default in the front-end **Low Cost** pack), `director` (`PostContextAssembly` — one consistent narration preamble across all story runtimes), and `story-guard` (`PostLLMResponse` content sanitisation + `PreToolUse` high-risk-tool deny-list)
- `EventBus.flush()` durability barrier for the best-effort audit-event stream
- `PostContextAssembly` payload carries a read-only `outputKind` so handlers can target specific runtime kinds without hardcoding plugin ids

### Changed

- Bumped all monorepo package versions `0.0.5` → `0.0.6`
- `TurnStart` / `PostRuntime` / `PostToolUse` hooks are now `sequential`, so their abort / replace paths actually take effect (previously dead code under `parallel`)
- Runtime refactors (behavior-preserving): `AgentLoopDeps` narrow seam isolating the core agent loop from orchestration deps; `RuntimeInvocation` options object replacing `executeOneRuntime`'s 19 positional args; a single `resolveTurnCapabilityPluginIds` source for capability-discovered plugin ids
- Registered all new hook events in the three plugin-loader whitelists (a plugin declaring them was previously dropped at parse time)

### Fixed

- Session-scoped every server commit / hook entry point (turn, actions, plugin-rpc, the commit processor, resume, characters, and session routes) so a plugin's hooks never fire for sessions where it is inactive
- `PreSchedule` can no longer drop Pre-Game runtimes while Pre-Game is pending — a hook can shape main-loop scheduling but not break session initialization
- Resume path now fires `PreLLMCall` / `PostLLMResponse` and scopes the resumed plugin's own hooks (both were silently skipped for a suspended-then-resumed runtime)
- `SessionStart` / `SessionEnd` hardened with local try/catch so a handler failure can never turn a committed create / end / delete into a 500
- Plugin loader: an object i18n `description` is preserved when a plugin also declares `hooks` (the combination previously failed frontmatter validation)
- Added unit coverage for `computeSessionTurnCount` (the turn-count module had none) and clarified that an empty main-loop turn counts as a player turn

<details>
<summary>中文（备份翻译）</summary>

第六个公开版本。将运行时 hook 生命周期从 8 个扩展到 16 个事件，交付首批消费这些 hook 的插件，并落地一批运行时架构重构与静态审计修复。默认世界与内置插件行为不变——新 hook 是休眠基础设施，三个新插件均为可选启用。

**Added**

- hook 生命周期 8 → 16：`PreLLMCall`/`PostLLMResponse`（按调用非破坏性改写请求 / 在工具分发前改写响应）、`PostContextAssembly`（回合级系统提示/历史塑形）、`PreSchedule`（收窄本回合运行的 runtime 集）、`PreCompaction`/`PostCompaction`（否决/观察历史压缩）、`SessionStart`/`SessionEnd`（会话生命周期）、`PostToolUse.terminate`（记录结果后结束工具循环）
- 会话作用域 hook 管线：全局管线经 `AsyncLocalStorage` 按会话激活插件过滤，插件 hook 只对其激活的会话触发
- `HookContext.getOwnSettings()`：hook 可读本插件本会话的只读 `userSettings`（回合级、只读、深冻结快照）
- 三个新的可选插件（首批 hook 消费者）：`cost-gate`（每会话 token 预算，默认进前端 **Low Cost** 组合包）、`director`（`PostContextAssembly` 给全部 story runtime 注入统一导演前言）、`story-guard`（`PostLLMResponse` 内容净化 + `PreToolUse` 高危工具拦截）
- `EventBus.flush()` 持久化屏障；`PostContextAssembly` payload 增加只读 `outputKind`

**Changed**

- 所有 monorepo 包版本 `0.0.5` → `0.0.6`
- `TurnStart`/`PostRuntime`/`PostToolUse` 改为 `sequential`，其 abort/replace 分支才真正生效（此前在 `parallel` 下是死代码）
- 运行时重构（行为保持）：`AgentLoopDeps` 窄接缝隔离核心 agent 循环、`RuntimeInvocation` 选项对象替代 19 个位置参数、`resolveTurnCapabilityPluginIds` 单一来源
- 三个 loader 白名单注册全部新 hook 事件

**Fixed**

- 会话作用域覆盖所有 server commit/hook 入口（turn/actions/plugin-rpc/提交处理器/resume/characters/session 路由）
- `PreSchedule` 在 Pre-Game pending 时不能丢弃 Pre-Game runtime
- resume 路径接入 `PreLLMCall`/`PostLLMResponse` 并修正 resume 时被恢复插件自身 hook 的作用域
- `SessionStart`/`SessionEnd` 本地 try/catch 固化 observe-only
- 插件加载器：i18n 对象 `description` 与 `hooks` 并存不再校验失败
- 补 `computeSessionTurnCount` 单测，并澄清空主循环回合计为玩家回合

</details>

## [0.0.5] - 2026-06-16

Fifth public release. An internal, code-quality-focused refactor: systematic de-duplication across storage backends and the plugin layer, decomposition of oversized files, unified conventions, and isolation/data-flow fixes. No user-facing behavior change (except an intentionally unified API error-response envelope).

### Added

- New `@covel/plugin-handlers-utils` package providing shared pure-function helpers for plugin function-runtime handlers (eliminates verbatim-duplicated helpers and proposal construction across 5 plugins)
- New `FrameworkCapability` constant and type in `packages/shared`, consolidating framework-consumed capability tags so bare-string typos can no longer silently disable features
- Unified API error-response envelope `ApiErrorResponse` with an `errorBody` factory

### Changed

- Bumped all monorepo package versions `0.0.4` → `0.0.5`
- **Store**: extracted shared cross-backend mappers/insert-values, removing PG/SQLite duplication (~1145 lines); split `types.ts` and `common/mappers` by domain
- **Runtime/Context**: extracted commit validators and LLM telemetry; split turn-agent-tool-loop / llm-retry / turn-agent-runtime / prompt-assembler
- **AI-Provider**: de-duplicated adapter parameter extraction / metadata sanitizing; externalized model-capability data from inline TS (950 lines) to JSON; de-duplicated gateway fallback; split env registry and plugin schema by domain
- **Server**: unified error envelope, replaced 37+ session-404 checks with a `resolveSessionParam` middleware, split the bootstrap/install/worlds mega-routes
- **Web**: removed dead code, decomposed several oversized components by responsibility, unified silent error-swallowing into a visible `ignoreError`

### Fixed

- Fixed `characters.ts` hardcoding a framework plugin ID in violation of the framework↔plugin isolation rule (now uses `frameworkProposalSource`)
- Fixed a PG `value`-field NULL-semantics regression introduced by cross-backend de-duplication (restored returning `null`, unified across both backends)
- Fixed character-panel staleness on the char-creator write path (restored and improved the post-turn snapshot resync)
- Fixed a React anti-pattern where the confirmation dialog ran side effects inside a setState updater

<details>
<summary>中文（备份翻译）</summary>

第五个公开版本。一次以代码质量为核心的内部重构：消除跨后端与插件层重复、拆分巨型文件、统一约定、修复隔离与数据流问题。对外行为保持不变（除有意统一的 API 错误响应信封）。

**Added**

- 新增 `@covel/plugin-handlers-utils` 包，为插件 function-runtime handler 提供共享纯函数工具（消除 5 个插件中逐字重复的 helper 与 proposal 构造）
- `packages/shared` 新增 `FrameworkCapability` 常量与类型，收敛框架消费的 capability 标签，避免裸字符串拼写漂移导致功能静默关闭
- 统一 API 错误响应信封 `ApiErrorResponse` 与 `errorBody` 工厂

**Changed**

- monorepo 全量版本号 `0.0.4` → `0.0.5`
- **Store**：抽取跨后端共享 mapper/insert-values，消除 PG/SQLite 重复（约 1145 行）；`types.ts` 与 `common/mappers` 按域拆分
- **Runtime/Context**：抽取 commit 验证器与 LLM 遥测，拆分 turn-agent-tool-loop / llm-retry / turn-agent-runtime / prompt-assembler 等大文件
- **AI-Provider**：适配器参数提取/元数据清理去重；模型能力数据由内联 TS（950 行）外置为 JSON；gateway fallback 去重；env registry 与 plugin schema 按域拆分
- **Server**：错误信封统一、`resolveSessionParam` 中间件替换 37+ 处会话 404 检查、bootstrap/install/worlds 大路由拆分
- **Web**：清理死代码、按职责拆分多个巨型组件、统一静默吞错为可见的 `ignoreError`

**Fixed**

- 修复 `characters.ts` 硬编码框架插件 ID 违反框架↔插件隔离规则（改用 `frameworkProposalSource`）
- 修复跨后端去重引入的 PG `value` 字段 NULL 语义回归（恢复返回 `null`，两后端统一）
- 修复角色面板在 char-creator 写入路径下的同步问题（恢复并改进 turn 完成后的快照重同步）
- 修复确认对话框在 setState updater 内执行副作用的 React 反模式

</details>

## [0.0.4] - 2026-05-28

第四个公开版本。重点收敛回合流稳定性、插件/会话解析、框架可见文本本地化、插件模板质量与发布文档。

### Added

- 新增静态回合审计 skill，用于检查 turn flow、插件边界与运行时输出相关风险
- 插件模板新增 runtime cases 与可运行 note/analyst 示例，create-plugin / create-world skills 补齐验证指引
- 桌面主进程错误与启动文案补齐中英文 i18n 支持

### Changed

- monorepo 全量版本号 `0.0.3` → `0.0.4`
- 加固 turn flow、插件解析、会话插件 API、snapshot / trace / working-memory 等运行时边界
- 简化 prompt context feature gates，整理 context builder、prompt assembler 与 serialization 相关实现
- 刷新 production Docker image、release docs、README 与贡献文档；移除过期本地开发草稿和废弃模板脚手架

### Fixed

- 修复框架 UI 中残留的硬编码可见文本，补齐对应中英文 locale
- 修复插件 metadata、runtime loading、form submission、suspend/resume 与 post-turn memory 相关测试覆盖
- 修复 desktop asset import、IPC handler、splash/startup error 路径与 release staging 相关边界

## [0.0.3] - 2026-05-11

第三个公开版本。重点收敛世界数据导入、生成世界持久化、插件目录元数据、存储后端边界、桌面发布链路与长期维护性重构。

### Added

- 世界数据导入管线：支持世界包声明式 `worldData` 数据源、会话创建时导入、同步 API、导入 ledger、角色蓝图与媒体引用同步
- AI 生成世界新增保存目标：`server-file` / `server-store` / `return-only`，前端依据 `/api/health.storage.data.frontendMode` 选择合适持久化路径
- 插件目录元数据新增 tags、relations 与世界级 `pluginPolicy`，会话准备页支持按世界策略推荐、筛选与选择插件
- 生成世界质量门、世界数据 schema 校验、插件 README 检查与 Playwright e2e 稳定性验证脚本

### Changed

- monorepo 全量版本号 `0.0.2` → `0.0.3`
- 桌面发布链路收敛到 Electron，移除已废弃的 Tauri shell，更新 release workflow 与 staging smoke 验证
- 存储架构统一为 DataStore / MediaStore / VectorStore 边界，浏览器本地模式使用 IndexedDB，远端模式继续走服务端持久化
- 重构长期维护文件：拆分 bootstrap、plugin RPC、turn pipeline、store 后端、desktop IPC/logging、web session prep/debug route 等大模块
- README、首页 demo 与视觉层级更新，刷新 demo GIF 资源与玩家视角说明

### Fixed

- 加固插件执行安全边界、world data schema/media sync、生成世界包输出、gateway slot fallback 与 provider 参数覆盖测试
- 修复重复动态/静态导入、桌面 sidecar/staging 构建路径、plugin RPC/SSE 边界、存储后端空值与媒体生命周期相关边界

### Documentation

- 重组开发文档，补齐 storage architecture、world data、plugin authoring、desktop state、refactor follow-up 与插件 README

## [0.0.2] - 2026-04-29

第二个公开版本。围绕 2026-04-29 代码库审计发现的 7 个问题做收敛——CI 红灯、桌面安全、插件生态闭环、首屏体积。

### Added

- 桌面 sidecar 启动时生成一次性 bearer token（`COVEL_DESKTOP_REST_TOKEN`），所有 `PUT /api/config/{keys,settings,data-root}` 与 `POST /api/config/open-folder` 必须带 `Authorization: Bearer <token>`。读接口保持开放；token 未注入时（pure web / dev / Demo Host）自动 no-op，行为兼容
- `/api/config/info` 新增 `requiresAuth` 字段，前端据此决定是否附加 Authorization 头
- 社区插件 `tools.local` 激活生命周期：`activatePluginLocalTools(pluginId)` 在 RPC 审批通过后 just-in-time 注册到 `toolMap`，并在 approvals decision=allow 后预激活；幂等
- Electron 外链 allowlist：`https:` 直接放行 + 写审计日志；非 loopback `http:` 弹用户确认 dialog；其他协议（`javascript:`/`file:`/自定义）拦截
- 桌面 sidecar awaitable shutdown：新 `stopServer()` 等待子进程 `exit` 事件后再启动新 sidecar，5s 超时 SIGKILL，重启路径告别端口/SQLite 锁竞态

### Changed

- monorepo 全量版本号 `0.0.1` → `0.0.2`
- web 首屏 bundle 拆分：vite manualChunks 抽出 react/router/i18n/markdown/graph/motion 6 个 vendor chunk；主 chunk **490 kB → 365 kB gzip（-25%）**
- README + web 首页 demo 资源换为最新 dev3 视频（3× 速、无音轨、960×568 GIF + 1280×756 MP4）
- `PluginRpcResponse.failedJobs` 字段标记 deprecated；`expectsBackgroundFollower` 路径统一返回 202 `accepted` + jobId，失败状态落在 `_jobs/<jobId>` 的 `reason: "expected-background-follower-missing"`
- i18n 扫描器白名单覆盖 settings/theme 的 bilingual config 目录（`{ "zh-CN", "en-US" }` 自带翻译的对象不再误报）；database-panel raw 字符串迁移到 locale；删除冗余 `t(key, "中文")` 默认值
- CORS 收窄：从「任意 loopback origin」改为「dev origin（5173）+ sidecar own origin（serverPort）+ `CORS_ORIGIN` 显式配置」

### Fixed

- `pnpm test` 之前因 `tests/api/plugin-rpc.test.ts` 期望 200 实得 202 红灯——契约已确定为 202 异步 job 模式，测试同步更新到轮询 `_jobs` 失败状态
- 重复静/动态 import 警告：`reload-overlay`、`settings/store` 不再同时被静态和动态引入，Vite 不再警告 ineffective dynamic import
- `pnpm check:i18n` 35 处 raw CJK literal 全部清理，回到绿灯

### Documentation

- `docs/reference/api.md`：202 示例补 `phase` 字段；`_jobs` schema 补 `reason` 字段
- `docs/guide/desktop-config.md`：新增「桌面 REST 写接口的 token 门」章节
- `docs/guide/plugin-authoring-advanced.md`：澄清社区插件 `tools.local` 在审批通过后的延迟激活语义

## [0.0.1] - 2026-04-25

首个公开稳定版本。在 `0.0.1-beta` 基础上做了一轮可发布性收敛。

### Added

- 框架定位为 **agentic role-playing game framework**（README 中英文重写以体现这一定位）
- GitHub Actions release workflow 支持 `git push v*` tag 自动 build 并发布 GitHub Release
- Electron 打包产出收敛到「DMG + ZIP」两个文件，新增 `apps/desktop/scripts/cleanup-artifacts.mjs` 在 `afterAllArtifactBuild` 钩子里清理 blockmap、`latest-*.yml` 等 auto-update 元数据和解包目录
- create-plugin / create-world skill 增加测试与验证指引（`references/plugin-testing.md`、`references/world-validation.md`），含 vitest + MockLLM + harness 模板和 schema/引用一致性/lore 覆盖度脚本

### Changed

- monorepo 全量版本号 `0.0.1-beta` → `0.0.1`（root + 4 apps + 12 packages + 7 plugins + 2 templates + Tauri 3 处）
- `electron-builder.yml` 增加 `publish: null` 抑制 update manifest
- `docs/guide/plugin-authoring.md` 附录 B 插件清单按 `plugins/**/PLUGIN.md` 真实 frontmatter 重列（priority、runtime 类型与仓库实际一致）
- `docs/reference/plugins.md` 多 runtime 目录示例改为中性占位，避免与真实 `world-init/schema-gen` 单 runtime 现状混淆
- README/web 首页 demo 资源刷新为最新 dev 视频（3× 速、去音轨、800px GIF + 1280p MP4）

### Fixed

- `.claude/skills/create-plugin/references/example-plugins.md` 修正过时的 `model: ds`(实际 slot 为 `story` / `plugin`) 和与真实插件不符的 priority 数字

## [0.0.1-beta] - 2026-04-19

首个公开 beta 版本。

### Added

- 插件驱动的回合执行管线（Trigger Router → Priority Scheduler → Context Assembly → Runtime Runner → Commit Chain）
- 多 Provider LLM 抽象：DeepSeek / Qwen (DashScope) / OpenAI / Anthropic
- 2597 模型能力数据库（LiteLLM 同步），自动识别多模态 / function-calling / reasoning
- 存储后端：Memory / SQLite / IndexedDB / PostgreSQL（Drizzle ORM）
- 核心插件集：`pregame`、`world-init`、`char-creator`、`narrator`、`guide`、`npc-graph`、`codex`
- 声明式 UI：`json-render` + plugin-owned `ui/*.json`，无硬编码 Tab
- Electron 桌面版：macOS (arm64/x64)、Windows (x64/arm64 NSIS + portable)
- 外部化 prompt 模板与世界包（markdown + yaml）
- i18n：中英双语前端 + plugin 本地化 runtime
- 智能重试：超时 / 首 token 过慢 / 工具调用死循环 自动检测并回退
- 开发期 LLM replay cache（`COVEL_LLM_REPLAY=auto`）

### Documentation

- 项目 README、LICENSE (MIT)、CONTRIBUTING、CHANGELOG
- 三层文档：`reference/` (API/协议)、`guide/` (作者指南)、`architecture/` (系统设计)
- Release pipeline：`.github/workflows/release.yml`

[Unreleased]: https://github.com/AcKnEsS/covel/compare/v0.0.9...HEAD
[0.0.9]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.9
[0.0.8]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.8
[0.0.7]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.7
[0.0.6]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.6
[0.0.5]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.5
[0.0.4]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.4
[0.0.3]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.3
[0.0.2]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.2
[0.0.1]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1
[0.0.1-beta]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1-beta
