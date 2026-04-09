# Covel 插件系统 v2 — 完全重构 TODO

> 基于 `docs/plugin-system-req.md` 需求文档
> 目标：完全重构框架核心，不兼容现有插件和 API
> 各阶段详细设计：见同目录下的 `phase-*.md` 文档

---

## 总体进度

| 阶段 | 名称 | 预估工时 | 状态 | 文档 |
|------|------|---------|------|------|
| Phase 1 | 基础架构与类型系统 | 3-5 天 | `[x] 完成` (19 tests) | [phase-1-foundation.md](phase-1-foundation.md) |
| Phase 2 | 插件加载与注册系统 | 3-4 天 | `[x] 完成` (56 tests) | [phase-2-plugin-system.md](phase-2-plugin-system.md) |
| Phase 3 | 执行引擎与调度器 | 5-7 天 | `[x] 完成` (60 tests) | [phase-3-execution-engine.md](phase-3-execution-engine.md) |
| Phase 4 | 工具系统与输出系统 | 4-5 天 | `[x] 完成` (26 tests) | [phase-4-tools-and-output.md](phase-4-tools-and-output.md) |
| Phase 5 | 状态管理、事件与持久化 | 5-7 天 | `[x] 完成` (33 tests) | [phase-5-state-and-persistence.md](phase-5-state-and-persistence.md) |
| Phase 6 | 并发编排、冲突裁决与审批 | 4-5 天 | `[x] 完成` (24 tests) | [phase-6-orchestration-and-safety.md](phase-6-orchestration-and-safety.md) |
| Phase 7 | API、前端集成与完善 | 7-10 天 | `[x] 核心完成` (36 tests) | [phase-7-api-frontend-polish.md](phase-7-api-frontend-polish.md) |
| 统一存储 | DataStore + Memory + SQLite | — | `[x] 完成` (68 tests) | — |
| 集成接线 | TurnExecutor + LLM + Store + API | — | `[x] 完成` (E2E verified) | — |
| 模型解析 | Plugin llm.toml + API override | — | `[x] 完成` (9 tests) | — |

**总测试数：302+，真实 LLM E2E 验证通过（DeepSeek + Qwen + Qwen Flash）**

---

## Phase 1: 基础架构与类型系统

### 1.1 项目结构重组
- [ ] 创建新的 packages/ 目录结构（shared, plugin-loader, runtime, tools, context, state, events, store, approval, server）
- [ ] 更新 pnpm workspace 配置
- [ ] 更新 Turborepo 配置（turbo.json）
- [ ] 配置包间依赖关系

### 1.2 共享类型定义（@covel/shared）
- [ ] Plugin & Runtime 类型（PluginManifest, RuntimeManifest, TriggerConfig 等）
- [ ] 执行类型（RuntimeResult, ToolCallRecord, TurnInput, TurnResult）
- [ ] 状态类型（StateField, StateChangeEntry, WriteConflict, StateTableSchema）
- [ ] 事件类型（CovelMessage, MessageType）
- [ ] 审批类型（ApprovalRequest, ApprovalRecord, ApprovalDecision）
- [ ] Session 类型（Session, SessionPhase）
- [ ] UI 组件类型（UIComponentType, UIRenderInstruction）
- [ ] 通过 `tsc --noEmit` 编译检查

### 1.3 PLUGIN.md 解析器（@covel/plugin-loader）
- [ ] 安装 gray-matter 依赖
- [ ] 实现 `parsePluginMd()` 函数
- [ ] 实现 Zod schema 验证（runtimeManifestSchema）
- [ ] 实现模板变量提取（`{{ inputs.xxx }}` 语法识别）
- [ ] 实现 references 链接提取
- [ ] 单元测试：最简形态 PLUGIN.md
- [ ] 单元测试：完整 frontmatter 的 PLUGIN.md
- [ ] 单元测试：多 Runtime 形态（runtimes/ 子目录）
- [ ] 单元测试：无效 frontmatter 的错误处理

### 1.4 References 解析器
- [ ] 实现 `parseReference()` 函数（YAML frontmatter + keywords 提取）
- [ ] 实现 `shouldInjectReference()` 关键词匹配函数
- [ ] 单元测试：关键词匹配
- [ ] 单元测试：无 keywords 的 reference 处理

---

## Phase 2: 插件加载与注册系统

### 2.1 插件发现
- [ ] 实现 `discoverPlugins()` 目录扫描函数
- [ ] 支持单 Runtime / 多 Runtime 两种目录结构
- [ ] 支持 `.disabled` 后缀跳过
- [ ] 单元测试

### 2.2 渐进式加载
- [ ] 实现 Level 0: `loadPluginSummary()`（仅 name + description）
- [ ] 实现 Level 1: `loadPluginManifest()`（完整 frontmatter）
- [ ] 实现 Level 2: `loadRuntime()`（完整加载含 prompt + references + tools）
- [ ] 单元测试：三个级别逐步加载

### 2.3 插件注册表
- [ ] 实现 `PluginRegistry` 接口
- [ ] 注册 / 查询 / 卸载
- [ ] `getActiveRuntimes()` 按 priority 排序
- [ ] `onChange()` 事件订阅
- [ ] 单元测试

### 2.4 Session 插件作用域
- [ ] 实现 `SessionPluginScope`
- [ ] 启用 / 禁用 / 配置覆盖
- [ ] core-plugin 不可禁用检查
- [ ] 单元测试

### 2.5 插件信任分级
- [ ] 实现 `getPluginTrustInfo()` 
- [ ] builtin / official / community 三级分类
- [ ] 单元测试

### 2.6 热重载
- [ ] 实现 `PluginWatcher`（chokidar 或 fs.watch）
- [ ] 文件变更 → 重新解析 → 更新注册表
- [ ] 当前 Turn 不受影响（等待完成后生效）
- [ ] 集成测试

---

## Phase 3: 执行引擎与调度器

### 3.1 Trigger Router
- [ ] 实现 `TriggerEvaluator` 接口
- [ ] `auto` 触发类型
- [ ] `manual` 触发类型
- [ ] `scheduled` 触发类型（每 N 轮）
- [ ] `conditional` 触发类型（条件表达式评估）
- [ ] `event` 触发类型（topic 匹配）
- [ ] `error-retry` 触发类型
- [ ] 全局限制检查（maxTriggerCount, cooldownTurns）
- [ ] 单元测试：每种触发类型

### 3.2 Priority Scheduler
- [ ] 实现 `PriorityScheduler`（按优先级分组排序）
- [ ] 实现 `DependencyAnalyzer`（基于 input.inject / input.tools 声明）
- [ ] 循环依赖检测
- [ ] 同优先级组内的依赖调整
- [ ] 单元测试

### 3.3 Context Builder
- [ ] 实现 `ContextBuilder.build()` 
- [ ] 模板变量替换（`{{ inputs.xxx }}`, `{{ config.xxx }}`, `{{ session.xxx }}`）
- [ ] inject 处理（XML 标签注入）
- [ ] References 关键词触发注入
- [ ] UI 组件列表注入
- [ ] 单元测试

### 3.4 Runtime Runner
- [ ] 实现 LLM tool-calling loop
- [ ] tool call → 审批检查 → 执行 → result 追加 → 继续循环
- [ ] maxSteps / timeoutMs 硬限制
- [ ] 输出 schema 验证
- [ ] 验证失败重试（带错误提示）
- [ ] 集成测试（Mock LLM）

### 3.5 Turn Executor
- [ ] 实现完整 Turn 执行管线
- [ ] Trigger Router → Scheduler → 逐组执行 → 冲突检测 → Audit
- [ ] 最低保障原则：Narrator 保护
- [ ] 错误传播与依赖跳过
- [ ] 集成测试：完整 Turn 流程

### 3.6 LLM Provider 抽象
- [ ] 统一 `LLMProvider` 接口（generate + stream）
- [ ] 适配 OpenAI 协议
- [ ] 适配 Anthropic 协议
- [ ] Slot 机制（default, fast, balance, image）
- [ ] 模型能力检测（structured output 支持）

---

## Phase 4: 工具系统与输出系统

### 4.1 tool() 包装函数
- [ ] 实现 `tool()` 函数（@covel/tools）
- [ ] Zod schema → JSON Schema 转换（zod-to-json-schema）
- [ ] 运行时参数验证
- [ ] ToolModule 标准化输出
- [ ] 单元测试

### 4.2 工具注册表
- [ ] 实现 `ToolRegistry`
- [ ] 自动命名生成（covel_{plugin}_{runtime}_{fn}）
- [ ] 按 Runtime 查询可用工具
- [ ] LLM 格式转换（OpenAI / Anthropic）
- [ ] 单元测试

### 4.3 工具加载
- [ ] builtin 工具查找
- [ ] local 工具动态 import()
- [ ] 加载失败处理
- [ ] 单元测试

### 4.4 内置工具实现
- [ ] `get-game-context` — 游戏上下文摘要
- [ ] `get-narrator-output` — Narrator 输出查询
- [ ] `get-character-state` — 角色状态查询
- [ ] `get-scene-info` — 场景信息查询
- [ ] `get-runtime-result` — 任意 Runtime 结果查询
- [ ] `update-state` — 状态表更新（走审批管线）
- [ ] `query-table` — 动态表查询
- [ ] `emit-event` — 事件发送
- [ ] 每个工具的单元测试

### 4.5 工具调用记录
- [ ] 实现 `ToolCallRecorder`
- [ ] 每次调用自动持久化
- [ ] 按 Turn / Runtime 查询
- [ ] 单元测试

### 4.6 结构化输出
- [ ] 实现 `OutputSchemaLoader`（加载 output.schema.json）
- [ ] 实现 `OutputValidator`（JSON Schema 验证，使用 Ajv）
- [ ] 实现两种策略切换（native / prompt）
- [ ] 输出验证失败重试（最多 N 次）
- [ ] 默认 schema（未指定时）
- [ ] 单元测试

### 4.7 covel/sdk 公共包
- [ ] 创建 SDK 包（导出 tool, z 等）
- [ ] 包配置（package.json exports）
- [ ] 文档 / 使用示例

---

## Phase 5: 状态管理、事件与持久化

### 5.1 状态管理器
- [ ] 实现 `StateManager` 接口
- [ ] 表创建 / 删除
- [ ] 字段读写 / 批量更新
- [ ] 变更历史记录
- [ ] 滑动窗口策略（windowSize + keepSessionBoundary）
- [ ] 查询接口（简单过滤）
- [ ] 单元测试

### 5.2 写冲突收集
- [ ] 实现 `WriteCollector`
- [ ] Turn 内写操作收集（不立即写入）
- [ ] Turn 结束时冲突检测 + 提交
- [ ] 单元测试

### 5.3 事件总线
- [ ] 实现 `EventBus`（发布 / 订阅 / 确认）
- [ ] 支持通配符订阅
- [ ] 待处理事件队列（供 Trigger Router 使用）
- [ ] 事件持久化（EventLog）
- [ ] 单元测试

### 5.4 消息路由
- [ ] 实现 `MessageRouter`
- [ ] message 类型 → 追加到 Runtime 上下文
- [ ] event 类型 → 触发订阅回调
- [ ] callback 类型 → 触发 Runtime 执行
- [ ] 单元测试

### 5.5 持久化抽象层
- [ ] 实现 `DataStore` 接口定义
- [ ] `MemoryStore` 实现
- [ ] `PgStore` 实现（Drizzle ORM + 新 schema）
- [ ] 数据库 migration 脚本
- [ ] Contract tests（共享测试套件）
- [ ] IdbStore 实现（可后续补充）

### 5.6 Pre-Game 阶段
- [ ] Session 创建 + phase 管理
- [ ] 世界观预定义状态表加载（WorldStateLoader）
- [ ] Pre-Game Runtime（priority 0-99）执行
- [ ] Phase 转换（pre-game → playing）
- [ ] 集成测试

---

## Phase 6: 并发编排、冲突裁决与审批

### 6.1 并行执行
- [ ] 实现 `ParallelExecutor`（Promise.allSettled 并行）
- [ ] 实现 `ExecutionGraph`（依赖分析 + 执行计划）
- [ ] 循环依赖检测
- [ ] 集成测试：并行 Runtime

### 6.2 失败处理
- [ ] 实现 `FailureHandler`
- [ ] 依赖跳过逻辑
- [ ] Narrator 保护（降级而非跳过）
- [ ] 单元测试

### 6.3 冲突裁决
- [ ] 实现 `ConflictDetector`
- [ ] Audit Plugin PLUGIN.md 编写
- [ ] Audit Runtime 执行 + 裁决应用
- [ ] 冲突数据格式化
- [ ] 集成测试

### 6.4 审批管线
- [ ] 实现 `ApprovalPipeline` 接口
- [ ] 实现 `DefaultApprovalPipeline`（当前全部放行）
- [ ] 实现 `ApprovalGate`（Promise + EventEmitter 阻塞机制）
- [ ] 权限配置（PermissionConfig + PermissionRule）
- [ ] 审批记录持久化
- [ ] 单元测试

### 6.5 错误重试
- [ ] 实现 `RuntimeErrorHandler`
- [ ] 指数退避重试策略
- [ ] 不同错误类型的处理路径
- [ ] 单元测试

---

## Phase 7: API、前端集成与完善

### 7.1 HTTP API
- [ ] Session 管理（start / get / delete）
- [ ] Turn 执行（POST /session/:id/turn）
- [ ] 插件管理（list / config / enable / disable）
- [ ] Runtime 独立调用（POST /runtime/invoke）
- [ ] 事件（SSE subscribe / emit）
- [ ] 审批（pending / decide）
- [ ] 状态查询（state / history）
- [ ] 健康检查
- [ ] API 集成测试

### 7.2 SSE 事件流
- [ ] 实现 SSE handler（Hono streamSSE）
- [ ] Turn 生命周期事件
- [ ] Runtime 执行进度事件
- [ ] Narrator 流式文本推送
- [ ] 审批请求推送
- [ ] 状态变更推送
- [ ] 集成测试

### 7.3 UI 组件系统
- [ ] 预定义组件 schema（10 种内置类型）
- [ ] 组件 schema 注入 system prompt 的逻辑
- [ ] 自定义组件发现与加载
- [ ] CovelReadonlyAPI（前端沙箱 API）
- [ ] 前端组件渲染器（React）

### 7.4 插件配置
- [ ] 配置 schema 解析
- [ ] 配置 CRUD API
- [ ] 配置热生效机制
- [ ] 前端自动渲染配置 UI（基于 JSON Schema）

### 7.5 i18n
- [ ] PLUGIN.md 多语言文件加载
- [ ] locale 解析策略（精确 → 语言回退 → 默认）
- [ ] system prompt 片段的 locale 感知
- [ ] 内置工具提示文本 i18n

### 7.6 热重载
- [ ] 文件监听（chokidar）
- [ ] PLUGIN.md 变更 → 重新解析 + 更新注册表
- [ ] tools/ 变更 → 重新加载工具模块
- [ ] references/ 变更 → 清除缓存
- [ ] SSE 通知前端

### 7.7 测试框架
- [ ] TestHarness + TestEnv 实现
- [ ] MockLLMProvider 实现
- [ ] Store contract tests
- [ ] 端到端测试（完整 Turn 流程）

### 7.8 日志系统
- [ ] RuntimeLog 格式定义
- [ ] Runtime 执行日志自动记录
- [ ] pino infrastructure 日志配置
- [ ] 日志查询 API

---

## 跨阶段任务

### 文档
- [ ] 更新 CLAUDE.md（反映重构后的架构）
- [ ] 插件开发者指南（PLUGIN.md 格式 + tool() 用法 + 示例）
- [ ] API 文档（所有 HTTP 端点）
- [ ] 架构文档更新

### 核心插件重写
- [ ] core-narrator（主叙事）
- [ ] core-persona（AI 人格）
- [ ] core-audit（冲突裁决）
- [ ] core-init-wizard（角色创建引导）
- [ ] 其他插件迁移到新格式

### 迁移与清理
- [ ] 删除旧的 plugin.json 格式支持
- [ ] 删除旧的 kernel pipeline 代码
- [ ] 删除旧的 proposal 系统
- [ ] 更新前端适配新 API

---

## 依赖关系图

```
Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 6
  │              │           │
  │              │           ↓
  └──→ Phase 4 ←┘      Phase 7
  │         │
  └──→ Phase 5 ────────→ Phase 6
```

- Phase 1 是所有阶段的基础
- Phase 2 依赖 Phase 1
- Phase 3 依赖 Phase 1 + 2
- Phase 4 依赖 Phase 1，可与 Phase 2/3 部分并行
- Phase 5 依赖 Phase 1，可与 Phase 2/3 部分并行
- Phase 6 依赖 Phase 3 + 4 + 5
- Phase 7 依赖 Phase 1-6（可按子任务逐步交付）

---

## 参考开源项目

| 项目 | 参考点 | 链接 |
|------|--------|------|
| SillyTavern | 扩展框架、事件系统、渐进式加载 | [GitHub](https://github.com/SillyTavern/SillyTavern) |
| VoltAgent | Zod-typed tools、Supervisor Pattern、生命周期钩子 | [GitHub](https://github.com/VoltAgent/voltagent) |
| Mastra | Agent + Workflow 组合、Structured Output、TypeScript-first | [GitHub](https://github.com/mastra-ai/mastra) |
| Vercel AI SDK | tool() 定义模式、流式输出 | [Docs](https://sdk.vercel.ai/) |
| OpenAI Agents SDK | 工具注册、Agent 编排 | [GitHub](https://github.com/openai/openai-agents-js) |
| LangGraph.js | 图式执行引擎、条件分支 | [Docs](https://langchain.com/langgraph) |

---

## 技术栈

| 类别 | 选型 | 备注 |
|------|------|------|
| Runtime | Node.js ≥ 20.19.0 | ESM-only |
| 语言 | TypeScript (strict mode) | target ES2022 |
| 包管理 | pnpm 10.x | workspace monorepo |
| 构建 | Turborepo | 任务编排 |
| Schema 验证 | Zod | 运行时验证 + 类型推断 |
| JSON Schema | Ajv + zod-to-json-schema | 输出验证 + LLM tool calling |
| YAML 解析 | gray-matter | PLUGIN.md frontmatter |
| Web 框架 | Hono | API server |
| ORM | Drizzle | SQLite + PostgreSQL |
| SQLite | better-sqlite3 | 本地默认存储 |
| 前端 | React 19 + Vite 8 + TailwindCSS v4 | 保留现有 |
| 测试 | Vitest | 全部包 |
| 日志 | pino | infrastructure 日志 |
| ID 生成 | nanoid | |

---

## 已完成的额外工作（Phase 7 之后）

### 统一存储层 (@covel/store)
- [x] `DataStore` 统一接口（14 个实体，所有数据以 session 为维度）
- [x] `MemoryStore` 实现 + 34 contract tests
- [x] `SqliteStore` 实现（Drizzle + better-sqlite3）+ 34 contract tests
- [x] `createStore` 工厂 + `createStoreFromEnv` 环境变量驱动切换
- [x] `.gitignore` 排除 `data/`
- [x] 后端切换仅需改 `STORE_BACKEND=memory|sqlite|pg`

### 模块迁移到 DataStore
- [x] `StateManager(store)` — 所有状态读写通过 store 持久化
- [x] `EventBus(store?)` — 事件历史持久化（pub/sub 仍在内存）
- [x] `ApprovalPipeline(store?)` — 审批记录持久化
- [x] `TurnExecutor(deps.store?)` — Turn/Runtime 结果自动持久化
- [x] V2 Bootstrap 全部使用 DataStore，不再有 in-memory Map

### TurnExecutor + LLM 集成
- [x] `LLMAdapter` 接口 + `createGatewayAdapter` 桥接到 @covel/ai-provider
- [x] 完整 Turn 管线：Plugin 发现 → 加载 → 触发 → 调度 → 上下文 → LLM → 输出
- [x] 真实 LLM E2E 验证（DeepSeek + Qwen + Qwen Flash）
- [x] 世界观文档加载（Cloudmere 九州·云梦泽 完整测试通过）

### 模型解析链
- [x] `createModelResolver` — 多级优先级解析
- [x] 优先级：API override > plugin llm.toml[slot] > system llm.toml[slot] > default
- [x] 插件级 `llm.toml`：`[covel.default]`, `[covel.fast]` 等
- [x] PLUGIN.md `model` 字段作为 slot 名，先查插件 toml 再查系统 toml
- [x] API `body.model` 可动态切换模型（已验证 ds/qwen/fast 三模型切换）

### 命名变更
- [x] 系统级 `llm.toml` section 从 `[slots.xxx]` 改为 `[covel.xxx]`
- [x] 插件级 `llm.toml` section 使用 `[covel.xxx]`
- [x] `llm.toml.example` 同步更新

### 待完成
- [ ] PgStore 实现（复用 Drizzle schema）
- [ ] IdbStore 实现（浏览器端）
- [ ] SSE 事件流接线到 EventBus
- [ ] 前端适配新 V2 API
- [ ] 核心插件全部重写（目前只有 core-narrator）
- [ ] 删除 v1 备份代码（*.v1.bak 目录）
