# 05. 当前实现进度

更新时间：

- `2026-03-25`

本文档记录当前仓库实际已经落地的内容，以及和 v1 规范相比仍未完成的部分。

规则：

- 本文件描述“当前实现状态”
- 不替代 `00-04` 的正式规范
- 如本文件与正式规范冲突，以正式规范为准

## 1. 已完成

### 1.1 工程基础

已完成：

- `pnpm workspace + turbo + typescript + vitest + vite` 基础工程
- `apps/* + modules/* + extensions/*` 目录骨架
- `.env.example`
- `docker-compose.postgres.yml`

### 1.2 核心 contracts

已完成：

- `ActionRequest`
- SSE envelope
- `Block`
- `BlockResponse`
- `TraceRecord`
- `RetrievalRun`
- `ArchiveVersion`

状态：

- 已有 deterministic contract tests

### 1.3 核心 domain

已完成：

- `World`
- `Session`
- `Message`
- `Artifact`
- `ArchiveVersion`
- `MemoryDocument`
- `RetrievalRun`
- `TraceRecord`

状态：

- 已有 invariant tests
- 已有 repository port contract tests

### 1.4 Command System

已完成：

- `SlashParser`
- `SlashCommandSpec`
- `CommandRegistry`
- `CommandBus`
- 结构化错误模型

状态：

- deterministic tests 已通过

### 1.5 Model Gateway

已完成：

- `ProviderRegistry`
- `ModelProfileRegistry`
- 自定义 provider 路由层
- `openai-chat-v1`
- `openai-responses-v1`
- `anthropic-messages-v1`
- `text / object / stream / embed`
- 错误归一化
- provider lifecycle hooks
- DashScope live smoke

状态：

- mocked integration tests 已通过
- 多协议 adapter tests 已通过
- live smoke tests 已通过

补充说明：

- 当前实现仍以 language-first 形态为主，正式能力面主要覆盖 `text / object / stream / embed`
- 规范层已经收敛到 `Connection Profile + Task Preset + World/Session task bindings`，但当前仓库仍主要停留在更简单的 runtime preset / session preset 过渡形态

### 1.6 Flow Engine

已完成：

- `turn flow`
- `command flow`
- `resume flow`
- interactive block 等待与恢复
- SSE phase / terminal event 最小闭环

状态：

- deterministic tests 已通过

### 1.7 Package Runtime

已完成：

- manifest 最小形状校验
- filesystem discovery
- `SKILL.md` 渐进式加载
- `enable / disable`
- context / command / block / renderer 注册
- command module 动态加载
- path traversal 防护

状态：

- fixture 测试已通过
- 真实 `extensions/*` 扫描测试已通过
- 第一方 command handler 已可通过 package runtime 加载

### 1.8 Storage

已完成：

- in-memory repositories
- local artifact store
- artifact path policy
- PostgreSQL storage port
- PostgreSQL schema bootstrap
- PostgreSQL-backed repository persistence
- preset metadata persistence
- `DATABASE_URL` 存在时的 runtime 选择
- `docker compose` 本地 PostgreSQL 启动文件

状态：

- in-memory tests 已通过
- local artifact store tests 已通过
- PostgreSQL adapter tests 已通过
- runtime PostgreSQL selection tests 已通过
- preset metadata persistence tests 已通过

### 1.9 Memory / Archive / Observability

已完成：

- memory chunking 最小版
- hybrid retrieval 最小 fused 规则
- fallback
- provenance tagging
- ingestion stale / idempotent marker
- archive snapshot
- restore-in-place
- restore-as-fork
- lineage
- reindex mark contract
- app log / audit log / trace sink 最小本地能力
- trace read API 最小版

状态：

- deterministic tests 已通过

### 1.10 Runtime Host

已完成：

- `/health`
- `/worlds`
- `/sessions`
- `/sessions/:id/messages`
- `/packages`
- `/presets`
- `/presets/:id`
- `/archives`
- `/archives/:id/restore`
- `/traces`
- `/traces/:traceId`
- `/actions`
- runtime composition
- `start:runtime` 入口
- package-backed command registry 组装
- built-in `/help`
- persisted preset 覆盖 runtime preset

状态：

- host tests 已通过

### 1.11 Web Host

已完成：

- `apps/web` Vite + React 主界面
- 三栏工作台最小形态
- 世界列表与创建
- session bootstrap
- timeline
- SSE reducer
- action dispatcher
- interactive block 提交
- preset editor
- archive summary / restore
- trace summary

状态：

- web unit/integration tests 已通过
- `build:web` 已通过

### 1.12 第一方 Packages

已完成目录与最小 manifest / `SKILL.md`：

- `core-worldbook`
- `core-character-card`
- `core-persona`
- `core-memory-rag`
- `core-archive`
- `core-guide`
- `core-presets`
- `core-debug-commands`

状态：

- `core-guide / core-archive / core-memory-rag / core-presets / core-debug-commands`
  - 已具备最小 command handler
- runtime 已优先从 first-party package command module 组装命令系统
- `core-guide / core-memory-rag / core-worldbook / core-character-card / core-persona`
  - 已补 manifest 对应占位 `context.ts` / renderer 文件，避免目录结构与声明脱节
- `core-worldbook`
  - 已具备最小 world seed catalog 与 `/world-seeds` command surface
- runtime 当前仍只真正消费 package command
- `Preset` 当前主要由 `model-gateway + storage + runtime/web host` 承载
- 其余 package 仍主要是 package runtime 可消费的最小壳
- 仍不是完整业务实现
- 旧项目的代表性世界观资产已先迁入 `extensions/core-worldbook/assets/legacy`

## 2. 当前验证结果

当前仓库已通过：

- `pnpm typecheck`
- `pnpm test`
- `pnpm test:live`
- `pnpm build:web`

其中：

- `pnpm test` 当前通过 `124` 个测试
- `pnpm test:live` 已在 DashScope `qwen3.5-flash` 上通过

## 3. 和规范相比仍未完成

下面这些仍未完成，或只完成了最小占位实现。

### 3.1 Package 业务实现仍是最小壳

未完成：

- `core-worldbook` 的真实 context 逻辑
- `core-character-card` 的真实角色卡逻辑
- `core-persona` 的真实人格逻辑
- `core-memory-rag` 的更完整 package surface
- `core-archive` 的更完整 package command surface
- `core-presets` 的完整 schema/settings UI 与持久化
- `core-debug-commands` 的完整调试命令与调试页联动

补充说明：

- package manifest 虽已声明 `context` / `renderer` contribution，但 runtime 仍未执行 package-owned context provider，也未动态装载 package-owned renderer
- 这意味着当前 package 层更接近“已建好承载位，但尚未接主链路”
- `core-worldbook` 已经不再只是纯占位壳，但当前真实能力仍停留在 staged content discovery / import draft，不等于已接入会话上下文

### 3.2 Memory / RAG 仍未达到规范全文能力

未完成：

- `query normalization`
- `source routing`
- `query rewrite`
- `graph neighbor expansion`
- `rerank`
- `budget packing`
- `retrieval critique`
- PostgreSQL 真向量索引与真实 embedding ingestion job

当前状态：

- 只有 deterministic 最小版

### 3.3 Archive 仍未完成完整恢复语义

未完成：

- restore 后完整 session state reconstruction
- restore 后 message / block / UI 恢复的全链路
- archive lineage UI

### 3.4 Observability 仍未达到 v1 正式能力

未完成：

- trace list 页面
- trace detail 页面
- prompt/context preview
- retrieval debug view
- archive lineage view
- OpenTelemetry exporter
- Langfuse adapter

### 3.5 Web Host 仍是最小工作台

未完成：

- `shadcn/ui` 正式接入
- 更完整的主界面信息架构
- package/preset 编辑的更完整正式 UI
- session / archive / trace 的更完整 UX
- Playwright E2E
- 移动端适配细化

### 3.6 Runtime 仍未完全装配

未完成：

- 将 `package runtime + command system + flow engine + model gateway` 装配成更完整的产品链路
- 将 block schema / response schema 校验接入 runtime submit 流
- 将 archive / memory / observability 全量接进 action 主链路
- 使用 PostgreSQL 时的 artifact metadata 与 artifact content 的真实协作链路
- preset 更新后对已运行 runtime 的更细粒度热更新策略

### 3.7 PostgreSQL 仍未完全产品化

未完成：

- 正式 migrations
- 连接池生命周期管理
- 真实生产级错误处理与重试
- 健康检查与启动时 schema upgrade 策略
- artifact metadata / preset metadata 的更系统化持久化模型

### 3.8 Provider Layer 仍未完全产品化

未完成：

- 还没有正式落地 `Connection Profile + Task Preset + Binding Profile`
- 当前仍未完成 `session.taskBindings` / `world.taskBindings`，仍偏向单一 preset 绑定
- image / speech / transcription capability 仍未纳入统一 provider kernel
- provider routing 策略仍偏简单，尚未达到 LiteLLM 那类完整路由器能力
- 还没有正式 WebSocket provider transport
- 还没有真正的 Langfuse adapter，只保留了 hooks / trace 接口位
- 还没有 request-level cost accounting 与更完整统计聚合
- provider policy 仍缺：
  - capability-specific routing
  - config-driven retry / fallback / timeout
  - provider-level budgets / privacy policy

## 4. 当前判断

当前仓库已经达到：

- 一个可运行、可测试、可继续扩展的 v1 基础实现
- 包含 in-memory 与 PostgreSQL 两条最小存储路径
- 包含真实 DashScope live smoke

但还没有达到：

- 文档定义的完整 v1 产品交付
- 完整第一方 package 能力
- 完整调试与观测工作台
- 完整 RAG / archive / runtime 装配
- 规范中新的 capability-first provider / profile 架构

## 5. 下一优先级建议

建议优先按下面顺序继续：

1. 先把 provider / preset / binding 结构收敛到规范中的 `Connection Profile + Task Preset + task bindings`
2. 再做正式 PostgreSQL migrations 与启动/bootstrap 管理
3. 做 package 真实业务实现，先从 `core-guide / core-archive / core-presets` 开始
4. 做完整 memory-rag pipeline
5. 做完整 Web Host 的 package/preset/archive/trace 工作台
6. 最后补 OpenTelemetry / Langfuse / Playwright E2E
