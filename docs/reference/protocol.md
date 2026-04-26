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

（turn-band 重构后 `phase.changed` 已废弃：`SessionRecord.phase` 字段移除，运行进度改由 `turnCount` + `preGameCompleted` 描述。未来若需要推送 `status` 变化，将以 `status.changed` 形式重新引入，届时在此补记。）

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

### 媒体资产事件

图像生成插件的完成态输出使用 `assetGenerations[]`。runtime normalizer 会把每一项转成 `asset.generate` proposal,并在 commit 后写入 trace / SSE 视图。

```ts
type AssetGeneration = {
  ref: MediaRef;
  modality: string;      // e.g. "image", "audio", "video", "file"
  meta?: Record<string, unknown>;
};
```

`ref` 必须来自 `ctx.media.put()` 或 `ctx.media.ingestUrl()`。provider wire 层可短暂收到 `b64_json`、远程临时 URL 或 SDK 字节结果；handler 在返回前完成 MediaStore ingest,然后只通过 `assetGenerations[]` 和业务索引记录暴露 `MediaRef`。

图像画廊类插件仍可用 `plugin_data.images` 保存查询索引,索引值保存 `{ status, ref, prompt, ... }`。`Image` / `Media` 组件消费 `MediaRef`,由框架解析为展示 URL。

声明 `image-generation` capability 的插件在完成态缺少 `assetGenerations[]` 时会产生 `image.generate.asset_missing` error。`plugin_data.images` 中出现旧 `url` / `base64` / `dataUrl` 字段时会产生 `image.generate.plugin_data_inline_media` error。

### LLM content parts

`@covel/ai-provider` 的 `TextMessage.content` 使用双形态契约：

| 形态 | 用途 | 生命周期 |
|------|------|----------|
| `string` | 纯文本消息快路径 | 长期保留 |
| `null` | assistant tool-call 等 provider 允许空内容的消息 | 长期保留 |
| `ContentPart[]` | 多模态消息路径，当前包含 `{ type: "text", text }` 与 `{ type: "image", image: MediaRef }` | 长期保留 |

`@covel/shared` / `@covel/runtime` 保持 provider-agnostic content parts；`@covel/ai-provider` adapter 负责把 `MediaRef` 编码成各 provider 的 wire shape。`assetGenerateToLLM()` 会把 `asset.generate` proposal 派生成文本摘要，并在图片资产场景追加 image part。

Provider 图片输入矩阵：

| Provider 路径 | 图片 wire shape | 输入优先级 | 当前状态 |
|---------------|-----------------|------------|----------|
| OpenAI Chat | `{ type: "image_url", image_url: { url } }` | `MediaRef.url` URL / data URL 优先；File API 作为大图或复用资产后续能力 | URL-backed image parts 已实现 |
| OpenAI Responses | `{ type: "input_image", image_url }` | `MediaRef.url` URL / data URL 优先；File API 作为大图或复用资产后续能力 | URL-backed image parts 已实现 |
| Anthropic Messages | `{ type: "image", source: { type: "url", url } }` | URL source 优先；Files API 用于大图或复用资产；base64 用于小图兜底 | URL-backed image parts 已实现 |
| Gemini native | File API 或 `inlineData` | 大图 / 复用资产走 File API，小图走 `inlineData`；URL 输入先由框架或 adapter 取回字节 | native adapter 后续实现 |
| Gemini OpenAI-compatible endpoint | 跟随 OpenAI Chat / Responses 形态 | 使用 OpenAI-compatible adapter 的 URL / data URL 路径 | 随 OpenAI-compatible preset 生效 |

当前 adapter 直接消费 `MediaRef.url`。缺少 `url` 的 image part 会序列化为文本 `image_ref` JSON，保留资产 id / mime / size 供 trace 和模型上下文读取。远程 provider vision 调用应在进入 adapter 前提供 provider 可取回的 URL、data URL 或 provider file upload 引用；`file://` / `memory://` 这类本地 URL 主要服务本地后端、测试与展示路径。

**保留命名空间 `_jobs`（后台任务协议）:**

`POST /api/sessions/:id/plugin-rpc` 的 runtime 级 + `execution: background` 分支使用 `_jobs` 命名空间写回任务进度：

| `value.status` | 语义 | 前端行为 |
|--------------|------|----------|
| `pending` | 任务已受理,runtime 尚未完成 | 渲染 loading 占位 |
| `done` | 成功完成,`value.runtimeResults` 为 `executeTurn` 汇总 | 把结果合并回业务命名空间或直接显示 |
| `failed` | runtime 抛错,`value.error` 为消息 | 展示错误并让用户重试 |

所有 `_jobs/<jobId>` 的写入都是普通 `setPluginData` 调用，因此都会通过标准 `plugin-data.changed` 频道广播。插件**禁止**直接写入 `_jobs` —— 框架独占该命名空间。业务数据请使用自定义命名空间（如 `images`、`prompts`）。

### Suspend / Resume 事件（S4-T4）

需要环境变量 `COVEL_SUSPEND_V1=1`。关闭时 suspend 路径不会触发。

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `turn.suspended` | S→C | 插件调用 `suspend()` 工具成功序列化 pendingContinuation 后由 turn-executor 发出 | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed` | S→C | `POST /api/sessions/:id/resume` 成功重新启动 runtime 后由 resume 路由发出 | `{ sessionId, turnId, suspensionId }` |

### Snapshot / Fork 事件（S4-T2 / S4-T5）

需要环境变量 `COVEL_SNAPSHOTS_V1=1`。所有 snapshot 事件由服务端经 eventBus 广播（topic=`session`），SSE 命名事件名来自 payload 的 `_subType`。

| 事件类型 | 方向 | 描述 | 负载 |
|----------|------|------|------|
| `state.snapshot.created` | S→C | 新 snapshot 已写入。由 turn-executor（auto）和 snapshots 路由（manual / fork）发出 | `{ turnId, snapshotId, kind: 'auto' \| 'manual' \| 'fork', parentSnapshotId? }` |
| `session.forked` | S→C | `POST /api/sessions/:id/fork` 成功物化子 session 后由 snapshots 路由发出。fork 同时发出一条 `state.snapshot.created`（kind='fork'） | `{ parentSessionId, childSessionId, fromSnapshotId, forkSnapshotId }` |

发射点对照：

| 触发路径 | 事件序列 | 来源 |
|----------|----------|------|
| `executeTurn` 自动捕获 | `state.snapshot.created` (kind=auto) | `packages/runtime/src/turn-executor.ts` (auto-snapshot 块) |
| `POST /api/sessions/:id/snapshot` | `state.snapshot.created` (kind=manual) | `apps/server/src/routes/api/snapshots.ts` |
| `POST /api/sessions/:id/fork` | `state.snapshot.created` (kind=fork) → `session.forked` | `apps/server/src/routes/api/snapshots.ts` |

> 前端若要接收上述事件，需在 `apps/web/src/services/subscription.ts` 的 topic 路由里为 `state.snapshot.created` / `session.forked` 显式分发。当前尚未挂载这两个监听；在 fork / save UI 真正落地前，服务端已经在 SSE 通道上发送，前端订阅即生效。

### Working Memory / 上下文压缩事件（kernel-only by design）

下列事件由 commit chain / Compactor 内部发出，**保留为内核内部事件**，**不进入 `ProtocolEventType` 枚举**，**没有 SSE 推送计划**。它们的设计意图是让 runtime / hook 内部消费，而非驱动 UI。如果将来确实需要前端实时反应，需要先评审：①是否真的需要实时？还是可以靠 `state.changed` / 轮询拿到？②若需要再把对应 type promote 到 `ProtocolEventType` 并接 SSE forwarder。

| 事件 | 触发点 | 当前出口 | payload | 备注 |
|------|--------|----------|---------|------|
| `working_memory.changed` | commit chain 提交 `working_memory.set` proposal 后 | `KernelEvent`（runtime 内部事件） | `{ scope, key }`（顶层带有 sessionId/turnId/source） | kernel-only by design，UI 应通过 `state.changed` 感知 |
| `context.compacted` | Compactor 完成摘要写入后 | `trace_events` 表 | `{ summaryId, messagesCompacted, tokenSavings, focusSections }` | trace-only by design，仅可通过 `/api/traces/:sessionId` 离线查询 |

### SSE 命名事件订阅注意事项

所有 ProtocolEventType 在 SSE 流上都以**命名事件**（`event: <type>\ndata: ...`）形式发送，**不会**触发 `EventSource.onmessage` 默认 handler。前端必须为每个关心的事件类型显式注册 `addEventListener('<type>', handler)`，否则事件会被静默丢弃。`apps/web/src/services/subscription.ts` 已为 `narrative.delta` / `narrative.completed` / `interaction.requested` / `plugin-data.changed` 等关键事件挂载监听。新增事件类型时**必须同步更新该文件**。

> S4-T5 注意：`state.snapshot.created` / `session.forked` 服务端已经发出但前端尚未挂载 listener（FU-6 / 等 fork & save UI 落地）。此 follow-up 是已知的，与 framework 实现无关。

## 二、命令类型（CommandType）

### 会话管理

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `session.create` | POST | `/api/sessions` | JSON: `SessionRecord` |
| `session.restore` | GET | `/api/sessions/:id/snapshot` | JSON: `SessionSnapshot` |
| `session.delete` | DELETE | `/api/sessions/:id` | JSON: `{ deleted }` |

### 回合执行（SSE 流式响应）

`/api/actions` 接受的 `type` 字段（实际由 `apps/server/src/routes/api/actions.ts:79` 的 `SUPPORTED_ACTIONS` 数组定义）：

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `turn.submit` | POST | `/api/actions` `type: "send_message"` | SSE: ProtocolEvent 流 |
| `turn.cmd` | POST | `/api/actions` `type: "execute_command"` | SSE: ProtocolEvent 流 |
| `turn.start` | POST | `/api/actions` `type: "start_session"` | SSE: ProtocolEvent 流 |
| `turn.retry` | POST | `/api/actions` `type: "retry_runtime"` | SSE: ProtocolEvent 流 |
| `event.trigger` | POST | `/api/actions` `type: "trigger_event"` | SSE: ProtocolEvent 流 |

> **注意（audit P2-10）**：旧文档曾写 `type: "player_action"`，那是早期原型，当前实现已用 `send_message` 取代。若客户端仍发送 `player_action`，actions 路由会以 `unknown action type` 返回错误。
>
> 区分 chat turn 与 plugin runtime 调用：
> - 玩家发送的自然语言走 `/api/actions` `send_message`，触发 narrator 主链。
> - 插件 UI 上的按钮走 `/api/sessions/:id/plugin-rpc`（见下方"插件 RPC"段），单次结构化调用，不会经过 narrator。

### 交互响应

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `input.submit` | POST | `/api/sessions/:id/submit-inputs` | JSON: `{ results[], accepted }` (legacy alias,内部转发到 plugin-rpc `submit-form`) |

### 插件管理

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `plugin.enable` | POST | `/api/sessions/:id/plugins/enable` | JSON: `{ ok, active[] }` |
| `plugin.disable` | POST | `/api/sessions/:id/plugins/disable` | JSON: `{ ok, active[] }` |

### 插件 RPC(PR-3)

统一的"结构化插件指令"通道。同时承载 action 级与 runtime 级调用。Action 级单次 JSON,runtime 级按 `manifest.execution` 分 sync / background 两种响应。

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `plugin.rpc` | POST | `/api/sessions/:id/plugin-rpc` | JSON 变体,见下 |

**请求体(action 级或 runtime 级 二选一):**

```json
{ "pluginId": "framework", "action": "submit-form", "payload": { /* ... */ } }
```
```json
{ "pluginId": "my-plugin", "runtimeId": "my-plugin/my-runtime", "payload": { /* ... */ } }
```

**响应分支:**

| 状态码 | status | 触发 |
|-------|--------|------|
| 200 | `ok` | action 级成功 / runtime 级 sync 模式成功 |
| 202 | `approval-required` | community-trust 首次调用(action 或 runtime 级) |
| 202 | `accepted` | runtime 级 `execution: background`,payload 里含 `jobId` + `turnId`。进度走 `plugin-data.changed` + `_jobs` 命名空间 |
| 400 | `error` | 缺字段 / action+runtimeId 互斥违反 / payload 校验失败 / `plugin-mismatch` |
| 404 | `error` (`code: "unknown-action"` / `"runtime-not-active"`) | action 未注册 / runtimeId 未加载到该 session |
| 429 | `error` (`code: "queue-full"`) | pending approvals 超过 cap |
| 500 | `error` (`code: "runtime-execution-failed"` / `"background-enqueue-failed"`) | sync 执行异常 / 入队失败(background 模式下 runtime 内部异常走 SSE,不进 HTTP) |

**框架默认 action:** 见 [api.md](api.md#post-apisessionsidplugin-rpc) 的"框架默认 action"小节。

### RPC Approval(PR-7)

community-trust 插件的 RPC 调用需要玩家显式批准。框架返回 202 后,前端通过下述端点拉取 / 提交决定。

| 命令 | 方法 | 端点 | 响应 |
|------|------|------|------|
| `approval.list` | GET | `/api/sessions/:id/approvals` | JSON: `{ pending: RpcApprovalPending[] }` |
| `approval.get` | GET | `/api/approvals/:approvalId` | JSON: `{ pending }` 或 404 |
| `approval.decide` | POST | `/api/approvals/:approvalId/decision` | JSON: `{ ok, decision, scope, pending }` |

**Decision 请求体:**

```json
{
  "decision": "allow",      // "allow" 或 "deny"
  "scope": "once"           // "once" (默认,60s 内消费一次) 或 "session" (本 session 内永久缓存)
}
```

详细流程图见 [api.md](api.md#rpc-approval-流程pr-7)。

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

## 七、Debug trace events

These events ride the standard SSE envelope and are also persisted into `trace_events`. They are emitted by the runtime's `TurnEmitter` (`packages/runtime/src/turn-emitter.ts`), fanned out both to `trace_events` (for the `/api/traces` read API and the `/debug` inspector) and to the global `EventBus` (where the `/api/actions` SSE route re-forwards them through `FORWARDED_SUBTYPES`).

| Type | Payload |
|------|---------|
| `tool.calling` | `{ runtimeId, pluginId, toolName, toolCallId, label, arguments, source, approvalStatus }` |
| `tool.completed` | `{ runtimeId, pluginId, toolName, toolCallId, label, result, parsedResult, durationMs, approvalStatus, success: true }` |
| `tool.failed` | `{ runtimeId, pluginId, toolName, toolCallId, label, code, error, details?, durationMs, approvalStatus, success: false }` |
| `llm.calling` | `{ runtimeId, pluginId, slot, model, provider: string \| null, messages, tools, attempt, streaming? }` |
| `llm.responded` | `{ runtimeId, pluginId, text?, toolCalls?, usage, finishReason, durationMs, attempt, error? }` |
| `message.completed` | `{ runtimeId, pluginId, content, len, deltaCount }` — `deltaCount` is the number of upstream `narrative.delta` events the runtime produced. Frontend views aggregating live `narrative.delta` streams use a separate synthesized `_aggregated` field; the two are not interchangeable — `deltaCount` is the authoritative persisted count. |
| `block.emitted` | `{ runtimeId, pluginId, proposalId, source, block }` |
| `state.patch.applied` | `{ runtimeId, pluginId, proposalId, patch: { packageName, summary, ops } }` |
| `hook.fired` | `{ event, hookName, pluginId, runtimeId?, targetId?, targetType }` |
| `hook.rewrote` | `{ event, hookName, pluginId, runtimeId?, targetId?, diff? }` |
| `hook.aborted` | `{ event, hookName, pluginId, runtimeId?, targetId?, reason }` |

Delta narrative continues to ride `narrative.delta` for realtime UI; only `message.completed` is persisted to keep `trace_events` compact.

Payload notes:

- `llm.calling.tools` is `Array<{ name, description, jsonSchema }>` — mapped from `LLMToolDefinition.parameters` so the recorded schema matches what the provider actually received.
- `llm.calling.provider` is `null` at direct `generate` / `generateStream` sites where the resolved provider string is not available; slot-routed calls populate it with the provider name (`openai`, `anthropic`, `deepseek`, `qwen`).
