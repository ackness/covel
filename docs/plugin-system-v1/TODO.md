# Plugin System V1 重构任务

时间：2026-04-07  
状态：进行中

## Phase 1: EventBus + ScopedLogger (`packages/event-bus/`)

- [x] 创建 `packages/event-bus/` 包结构 (package.json, tsconfig.json, vitest.config.ts)
- [x] 实现 `CovelEvent`, `EventSource`, `EventMeta` 类型
- [x] 实现三类事件常量 (Trigger / Domain / Runtime Bus)
- [x] 实现 `EventBus` 接口与核心逻辑 (emit, on, once, off, use, scope)
- [x] 实现通配符订阅
- [x] 实现 source filter 和 category filter
- [x] 实现 handler 错误隔离
- [x] 实现 `ScopedEventBus` (自动释放监听器)
- [x] 实现 `ScopedLogger` 接口与实现
- [x] 编写 EventBus 单元测试
- [x] 编写 ScopedLogger 单元测试

## Phase 2: ServiceGateway (`packages/services/`)

- [x] 创建 `packages/services/` 包结构
- [x] 定义 `ServiceGateway` 聚合接口
- [x] 实现 `RecordQueryService` (标准化记录查询)
- [x] 实现 `TableService` (live state tables 读写 + schema 演进)
- [x] 实现 `ScriptHostService` (JS worker_threads + Python child_process)
- [x] 实现 `ReferenceService` (按需加载 references)
- [x] 实现 `ApprovalService` (审批检查与授权)
- [x] 实现 `ToolGatewayService` (tool registry + invocation)
- [x] 实现 `RuntimeSettingsService`
- [x] 实现 `TraceService` (完整审计)
- [x] 编写 ServiceGateway 单元测试

## Phase 3: RuntimeContext + Structured Output (`packages/runtime-context/`)

- [x] 创建 `packages/runtime-context/` 包结构
- [x] 定义 `RuntimeContext` 接口
- [x] 实现 `PromptAssemblyContext` (PLUGIN.md + instructions.md + locale + tools + context)
- [x] 实现 RuntimeContext 工厂函数
- [x] 实现 Structured Output 三级降级策略
- [x] 定义 `ToolExecutionContext` 接口
- [x] 实现失败语义 (failed / approval_denied / skipped_condition / skipped_limit)
- [x] 编写 RuntimeContext 单元测试

## Phase 4: PluginManager (`packages/plugin-manager/`)

- [x] 从 `packages/plugin-runtime/` 迁移到 V1 结构
- [x] 更新 manifest validator 适配 `covel.plugin/v1` schema
- [x] 实现文件系统扫描 (plugin.json + runtimes/*/runtime.json + tools/ + scripts/)
- [x] 实现 `PluginManager` 接口 (loadAll, load, reload, unload, enable, disable)
- [x] 实现 `PluginRegistries` (plugins, runtimes, tools)
- [x] 实现 `ToolRegistry` (register, resolveForRuntime, export/import 双向声明)
- [x] 实现 generation-based 热重载 (generationId, draining, swap)
- [x] 实现 `dependencies` 字段拓扑排序
- [x] 实现失败容错 (单插件加载失败不阻塞)
- [x] 编写 PluginManager 单元测试

## Phase 5: Kernel Pipeline (`packages/kernel/` 重构)

- [x] 重构 trigger router 适配 V1 触发类型 (pre-game-once, turn, event, manual, approval-callback)
- [x] 重构 runtime-scheduler 适配 V1 priority 语义 (lower number = higher priority)
- [x] 实现 runtime 原子提交模型 (执行期写操作进事务, 结束后统一提交)
- [x] 实现 event-triggered runtime 推迟到下一 turn 的调度规则
- [x] 实现 pre-game 与正式 turn 分离 (priority < 100 只在 turn0 跑一次)
- [x] 实现所有状态输出 published record (success/failed/approval_denied/skipped_*)
- [x] 实现 action workflow 串行执行 + 步骤失败即终止
- [x] 实现 schema 变更传播规则
- [x] 实现 `KernelSession` 接口 (executeTurn, executeRuntime, executeAction)
- [x] 编写 Kernel Pipeline 单元测试

## Phase 6: Runtime 独立调用 API (`apps/server/`)

- [x] 添加 `POST /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/execute`
- [x] 添加 `GET /api/sessions/:sessionId/runtimes`
- [x] 添加 `POST /api/sessions/:sessionId/actions/:pluginId/:actionId/execute`
- [x] 添加 `GET /api/sessions/:sessionId/workflows/:workflowRunId`
- [x] 添加 `GET /api/sessions/:sessionId/runtimes/:pluginId/:runtimeId/last-record`
- [x] 添加 `POST /api/sessions/:sessionId/approvals/callback`
- [x] 编写 API 集成测试（路由已接入 V1KernelSession，覆盖 runtime/action/workflow/approval 路径）

## 迁移

- [ ] 迁移现有 16 个插件到 V1 结构 (runtimes/ 目录、runtime.json、dependencies)
- [ ] 更新前端适配新 API
