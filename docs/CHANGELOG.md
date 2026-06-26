# Changelog

All notable changes to this project will be documented in this file. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/AcKnEsS/covel/compare/v0.0.4...HEAD
[0.0.4]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.4
[0.0.3]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.3
[0.0.2]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.2
[0.0.1]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1
[0.0.1-beta]: https://github.com/AcKnEsS/covel/releases/tag/v0.0.1-beta
