# Covel 通讯协议参考

> 定义框架所有对外通讯的统一架构。类型定义见 `packages/shared/src/types/protocol.ts`。

## 架构总览

所有通讯分为三类，各有统一的格式和约定：

```
┌────────────────────────────────────────────────────┐
│ Command (Client → Server)                          │
│   POST 请求，触发状态变更                            │
│   两种响应模式：JSON（即时）或 SSE（流式）            │
├────────────────────────────────────────────────────┤
│ Event (Server → Client)                            │
│   所有服务端推送使用 ProtocolEvent 格式               │
│   唯一通道：/actions SSE（回合内）                    │
│   辅助通道：/events/stream（回合外，仅 plugin 事件）  │
├────────────────────────────────────────────────────┤
│ Query (Client → Server)                            │
│   GET 请求，只读数据获取                             │
│   标准 REST JSON 响应                               │
└────────────────────────────────────────────────────┘
```

## 一、事件类型（ProtocolEventType）

所有 SSE 推送使用以下标准事件类型，服务端和前端必须一致使用：

### 叙事事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `narrative.delta` | S→C | 流式叙事文本片段 | `{ runtimeId, pluginId, kind, delta }` |
| `narrative.completed` | S→C | 完整叙事消息 | `{ content, kind, messageId, runtimeId, pluginId }` |

### 交互事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `interaction.requested` | S→C | 请求玩家输入（表单/选择/确认） | `{ block: { id, type, data, meta }, runtimeId, pluginId }` |

### 状态事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `state.changed` | S→C | 游戏状态变更 | `{ table, field, value, runtimeId, pluginId }` |
| `event.emitted` | S→C | 游戏业务事件 | `{ topic, data, runtimeId, pluginId }` |
| `record.updated` | S→C | 长期记录更新 | `{ key, value, recordType, runtimeId, pluginId }` |

### 执行生命周期事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `execution.started` | S→C | 回合执行开始 | `{ runtimeCount }` |
| `runtime.started` | S→C | 单个 runtime 开始 | `{ runtimeId, pluginId, label }` |
| `runtime.completed` | S→C | 单个 runtime 完成 | `{ runtimeId, pluginId, durationMs }` |
| `runtime.failed` | S→C | 单个 runtime 失败 | `{ runtimeId, pluginId, error }` |
| `execution.completed` | S→C | 回合执行完成 | `{ runtimeCount, resultCount, durationMs }` |

### 会话生命周期事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `phase.changed` | S→C | 会话阶段转换 | `{ phase }` |

### 系统事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `error.occurred` | S→C | 执行错误 | `{ message }` |

### 世界事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `world.dimensions.changed` | S→C | 世界维度文件变更（热更新） | `{ worldId, changedKeys[] }` |

### 插件数据事件

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `plugin-data.changed` | S→C | 插件持久化数据变更 | `{ pluginId, runtimeId, changes: [{ namespace, key, value, operation }] }` |

`plugin-data-set` / `plugin-data-set-batch` / DELETE `/plugin-data/...` 等所有写路径均会触发此事件。`operation` 字段为 `'set'` 或 `'delete'`（删除时 `value` 为 `null`），由 `wrapStoreWithPluginDataEvents` 在 store 层统一拦截，前端可实时响应插件状态变更。

### Suspend / Resume 事件（S4-T4）

需要环境变量 `COVEL_SUSPEND_V1=1`。关闭时 suspend 路径不会触发。

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `turn.suspended` | S→C | 插件调用 `suspend()` 工具成功序列化 pendingContinuation 后由 turn-executor 发出 | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed` | S→C | `POST /api/sessions/:id/resume` 成功重新启动 runtime 后由 resume 路由发出 | `{ sessionId, turnId, suspensionId }` |

### Snapshot / Fork 事件（S4-T2）

需要环境变量 `COVEL_SNAPSHOTS_V1=1`。当 fork 路由执行成功时由服务端经 eventBus 广播（topic=`session`），SSE 命名事件名来自 payload 的 `_subType`。

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `session.forked` | S→C | `POST /api/sessions/:id/fork` 成功物化子 session 后由 snapshots 路由发出 | `{ parentSessionId, childSessionId, fromSnapshotId, forkSnapshotId }` |

> 前端若要接收该事件，需在 `apps/web-v2/src/services/sse.ts` 里为 `session.forked` 显式 `addEventListener` —— 就像所有具名事件一样。当前 sse.ts 尚未挂载该监听；在 fork UI 真正落地前，服务端已经在 SSE 通道上发送，前端订阅即生效，kernel-only 无需改动。

### Working Memory / 上下文压缩事件（部分接入）

下列事件由 commit chain / Compactor 内部发出，**目前不在 `ProtocolEventType` 枚举中**，因此**尚未通过 SSE 推送到前端**。文档化是为了让插件作者知晓内核侧已经在发射对应信号；前端订阅需要等到事件被并入 `ProtocolEventType` 之后才能生效。

| 事件 | 触发点 | 当前出口 | payload | 备注 |
|------|--------|----------|---------|------|
| `working_memory.changed` | commit chain 提交 `working_memory.set` proposal 后 | `KernelEvent`（runtime 内部事件，尚未路由到 SSE） | `{ scope, key }`（顶层带有 sessionId/turnId/source） | 需要前端订阅时，需把该 type 加入 `ProtocolEventType` 并在 SSE 转发层接出 |
| `context.compacted` | Compactor 完成摘要写入后 | `trace_events` 表（仅持久化为 trace） | `{ summaryId, messagesCompacted, tokenSavings, focusSections }` | 同上；目前只能通过 `/api/traces/:sessionId` 查询，没有实时推送 |

### SSE 命名事件订阅注意事项

所有 ProtocolEventType 在 SSE 流上都以**命名事件**（`event: <type>\ndata: ...`）形式发送，**不会**触发 `EventSource.onmessage` 默认 handler。前端必须为每个关心的事件类型显式注册 `addEventListener('<type>', handler)`，否则事件会被静默丢弃。`apps/web-v2/src/services/sse.ts` 已为 `narrative.delta` / `narrative.completed` / `interaction.requested` / `phase.changed` / `plugin-data.changed` 等关键事件挂载监听。新增事件类型时**必须同步更新该文件**。

## 二、命令类型（CommandType）

### 会话管理

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `session.create` | POST | `/api/sessions` | JSON: `SessionRecord` |
| `session.restore` | GET | `/api/sessions/:id/snapshot` | JSON: `SessionSnapshot` |
| `session.delete` | DELETE | `/api/sessions/:id` | JSON: `{ deleted }` |

### 回合执行（SSE 流式响应）

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `turn.submit` | POST | `/api/actions` `type: "player_action"` | SSE: ProtocolEvent 流 |
| `turn.start` | POST | `/api/actions` `type: "start_session"` | SSE: ProtocolEvent 流 |
| `turn.retry` | POST | `/api/actions` `type: "retry_runtime"` | SSE: ProtocolEvent 流 |
| `event.trigger` | POST | `/api/actions` `type: "trigger_event"` | SSE: ProtocolEvent 流 |

### 交互响应

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `input.submit` | POST | `/api/sessions/:id/submit-inputs` | JSON: `{ results[], accepted }` |

### 插件管理

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `plugin.enable` | POST | `/api/sessions/:id/plugins/enable` | JSON: `{ ok, active[] }` |
| `plugin.disable` | POST | `/api/sessions/:id/plugins/disable` | JSON: `{ ok, active[] }` |

## 三、查询端点

只读数据获取，标准 REST GET 响应：

| 查询 | 端点 | 响应 |
|------|------|------|
| 会话列表 | `GET /api/sessions?worldId=` | `{ items: SessionRecord[] }` |
| 会话详情 | `GET /api/sessions/:id` | `SessionRecord` |
| 会话快照 | `GET /api/sessions/:id/snapshot` | `SessionSnapshot` |
| 消息列表 | `GET /api/sessions/:id/messages` | `MessageRecord[]` |
| 角色列表 | `GET /api/sessions/:id/characters` | `{ items: CharacterRecord[] }` |
| 插件列表 | `GET /api/sessions/:id/plugins` | `{ active[], available[] }` |
| 状态查询 | `GET /api/sessions/:id/state` | `{ tables }` |
| 状态补丁 | `GET /api/sessions/:id/state-patches` | `Patch[]` |
| 插件数据 | `GET /api/sessions/:id/plugin-data/:pluginId/:ns` | `{ items[] }` |
| 世界列表 | `GET /api/worlds` | `{ items: WorldRecord[] }` |
| 执行追踪 | `GET /api/traces/:sessionId` | `{ events[] }` |
| 服务健康 | `GET /api/health` | `{ status, version, storeBackend }` |

## 四、SSE 信封格式

所有 SSE 事件使用统一信封：

```typescript
interface SseEnvelope {
  type: ProtocolEventType;   // 事件类型（标准协议名）
  requestId: string;         // 请求关联 ID
  traceId: string;           // 追踪 ID
  sessionId: string;         // 会话 ID
  turnId: string;            // 回合 ID
  seq: number;               // 序列号（单调递增）
  timestamp: string;         // ISO 时间戳
  payload: Record<string, unknown>;  // 事件数据
}
```

## 五、前端事件路由

`handleSseEvent` 是唯一的回合内事件处理器，按事件类型路由到对应的 state slice：

```
narrative.delta       → messages (streaming buffer)
narrative.completed   → messages (completed)
interaction.requested → messages (block)
state.changed         → gameState (deep merge) + statePatches
event.emitted         → gameState.events
record.updated        → gameState.records
phase.changed         → session.phase
execution.started     → executionSteps
runtime.started       → executionSteps
runtime.completed     → executionSteps
runtime.failed        → executionSteps
execution.completed   → executing = false
error.occurred        → executionError
```

## 六、Transport 抽象

协议设计为 transport-agnostic。当前实现使用 HTTP + SSE，但所有通讯都通过 `SessionTransport` 接口抽象，支持未来适配：

| Transport | 上行 | 下行 | 场景 |
|-----------|------|------|------|
| SSETransport | HTTP POST | SSE stream | Web 前端（当前） |
| WebSocketTransport | WS message | WS message | Web 升级路径 |
| StdioTransport | stdin JSON | stdout JSON | TUI / CLI |
| HTTPTransport | HTTP POST | HTTP polling | REST API 集成 |
| LocalTransport | 函数调用 | 回调 | 测试 |
