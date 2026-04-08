# Phase 1: EventBus + ScopedLogger

依赖：无  
包名：`@covel/event-bus`  
预计产出：`packages/event-bus/`

## 目标

为插件系统提供统一事件与日志基础设施。V1 里事件语义必须拆成三层，避免把调度、业务事实和运行时诊断混在一起。

## 1. 三类事件

### 1.1 Trigger Events

用于驱动 runtime 调度。

典型事件：

- `session.pre_game`
- `session.start`
- `turn.start`
- `turn.input`
- `runtime.manual`
- `approval.callback`

规则：

- 这类事件的职责是“触发调度”
- 不等同于业务事实
- 会进入 trace，但不直接作为插件共享数据面

### 1.2 Domain Events

用于表达业务事实。

典型事件：

- `quest.completed`
- `combat.attack`
- `location.changed`
- `inventory.item_acquired`

规则：

- 通过 `kernel:emit_domain_event` 产生
- 会被标准化记录
- 可通过 `kernel:query_records` 查询

### 1.3 Runtime Bus Events

用于框架内部运行时生命周期和调试。

典型事件：

- `runtime.started`
- `runtime.completed`
- `runtime.failed`
- `tool.called`
- `tool.denied`
- `plugin.reloaded`

规则：

- 用于调试、监控、trace
- 不作为插件之间的共享业务数据接口

## 2. EventBus 接口

```typescript
interface EventBus {
  emit(event: CovelEvent): Promise<EventResult>;
  on(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe;
  once(pattern: string, handler: EventHandler, options?: SubscribeOptions): Unsubscribe;
  off(pattern: string, handler: EventHandler): void;
  use(middleware: EventMiddleware): Unsubscribe;
  scope(scopeId: string, options?: ScopeOptions): ScopedEventBus;
}

interface CovelEvent {
  type: string;
  payload: unknown;
  source?: EventSource;
  meta?: EventMeta;
}

interface EventSource {
  pluginId?: string;
  runtimeId?: string;
  system?: boolean;
}

interface EventMeta {
  sessionId?: string;
  turnId?: string;
  traceId?: string;
  timestamp?: string;
  category?: "trigger" | "domain" | "runtime-bus";
}
```

## 3. 命名规范

- 统一使用点分命名：`foo.bar`
- Trigger / Domain / Runtime Bus 三类都遵循同样命名风格
- 不再混用 `session_start`、`manual_action` 这类旧命名

## 4. 调度相关约束

- 同 priority runtime 并行执行
- 同 priority 并行 runtime 只能看到更小 priority（更先执行）已经提交的结果
- runtime 完成提交后，后续较大 priority 的 runtime 可见其数据和记录
- schema 变更也是同样规则：提交后才对后续较大 priority 可见

## 5. ScopedLogger

```typescript
interface ScopedLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, error?: Error | unknown, data?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): ScopedLogger;
}
```

日志需要带上最少字段：

- `pluginId`
- `runtimeId`
- `sessionId`
- `turnId`
- `traceId`
- `toolId`（如适用）

## 6. 内置系统事件建议

```typescript
export const SystemEvents = {
  SESSION_PRE_GAME: "session.pre_game",
  SESSION_START: "session.start",
  TURN_START: "turn.start",
  TURN_INPUT: "turn.input",
  RUNTIME_MANUAL: "runtime.manual",
  APPROVAL_CALLBACK: "approval.callback",

  RUNTIME_STARTED: "runtime.started",
  RUNTIME_COMPLETED: "runtime.completed",
  RUNTIME_FAILED: "runtime.failed",
  TOOL_CALLED: "tool.called",
  TOOL_DENIED: "tool.denied",
  PLUGIN_RELOADED: "plugin.reloaded"
} as const;
```

## 7. 实现要求

- 支持通配符订阅
- 支持 source filter
- 支持 category filter
- handler 错误隔离
- ScopedEventBus 自动释放监听器
- warn / error 日志可选回灌为 runtime bus events
