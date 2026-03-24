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
- `openai-compatible` adapter
- `text / object / stream / embed`
- 错误归一化
- DashScope live smoke

状态：

- mocked integration tests 已通过
- live smoke tests 已通过

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
- path traversal 防护

状态：

- fixture 测试已通过
- 真实 `extensions/*` 扫描测试已通过

### 1.8 Storage

已完成：

- in-memory repositories
- local artifact store
- artifact path policy
- PostgreSQL storage port
- PostgreSQL schema bootstrap
- PostgreSQL-backed repository persistence
- `DATABASE_URL` 存在时的 runtime 选择

状态：

- in-memory tests 已通过
- local artifact store tests 已通过
- PostgreSQL adapter tests 已通过
- runtime PostgreSQL selection tests 已通过

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

状态：

- deterministic tests 已通过

### 1.10 Runtime Host

已完成：

- `/health`
- `/worlds`
- `/sessions`
- `/sessions/:id/messages`
- `/packages`
- `/archives`
- `/archives/:id/restore`
- `/actions`
- runtime composition
- `start:runtime` 入口

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
- archive summary / restore

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

- 目前主要是 package runtime 可消费的最小壳
- 还不是完整业务实现

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
- `core-memory-rag` 的真实 package surface
- `core-archive` 的完整 package command surface
- `core-presets` 的完整 schema/settings UI
- `core-debug-commands` 的完整调试命令实现

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
- package/preset 编辑的正式 UI
- session / archive / trace 的更完整 UX
- Playwright E2E
- 移动端适配细化

### 3.6 Runtime 仍未完全装配

未完成：

- 将 `package runtime + command system + flow engine + model gateway` 装配成更完整的产品链路
- 将 block schema / response schema 校验接入 runtime submit 流
- 将 archive / memory / observability 全量接进 action 主链路
- 使用 PostgreSQL 时的 artifact metadata 与 artifact content 的真实协作链路

### 3.7 PostgreSQL 仍未完全产品化

未完成：

- 正式 migrations
- 连接池生命周期管理
- 真实生产级错误处理与重试
- 健康检查与启动时 schema upgrade 策略

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

## 5. 下一优先级建议

建议优先按下面顺序继续：

1. 做正式 PostgreSQL migrations 与启动/bootstrap 管理
2. 做 package 真实业务实现，先从 `core-guide / core-archive / core-presets` 开始
3. 做完整 memory-rag pipeline
4. 做完整 Web Host 的 package/preset/archive/trace 工作台
5. 最后补 OpenTelemetry / Langfuse / Playwright E2E
