# Covel 通讯协议参考

> 定义框架所有对外通讯的统一架构。类型定义见 `packages/shared/src/types/protocol.ts`。

## 架构总览

所有通讯分为三类，各有统一的格式和约定：

```
┌─────────────────────────────────────────────────────────────────┐
│ Command (Client → Server)                                       │
│   POST 请求，触发状态变更                                         │
│   两种响应模式：JSON（即时）或 SSE（流式）                         │
├─────────────────────────────────────────────────────────────────┤
│ Event (Server → Client) — 两条独立流，信封形态不同                │
│   主通道 POST /api/actions:                                      │
│     · data-only SSE 帧（无 event: 头）                            │
│     · 信封 = SseEnvelope（requestId/traceId/flowId/seq/...）      │
│     · 客户端用 fetch + ReadableStream 解析（api/actions.ts）      │
│   辅助通道 GET /api/events/stream:                               │
│     · 命名 SSE 事件（event: <type>\ndata: ...）                   │
│     · 信封 = ProtocolEvent（id/source/...）                      │
│     · 客户端 EventSource + addEventListener                       │
│     · topic: runtime / state / game / plugin / session / store /  │
│             system，含 system.connected + 30s system.heartbeat   │
│             与 lastEventId 重连补放                               │
├─────────────────────────────────────────────────────────────────┤
│ Query (Client → Server)                                         │
│   GET 请求，只读数据获取                                          │
│   标准 REST JSON 响应                                            │
└─────────────────────────────────────────────────────────────────┘
```

> 关键差异：`/api/actions` **没有** `event:` 命名头，因此 `EventSource.addEventListener('narrative.delta', …)` 在 actions 流上**永远不会**触发。回合内事件请使用 `apps/web/src/services/api/actions.ts: sendAction` 的 ReadableStream 解析路径，或自行用 `fetch()` 读取 `data:` 行；命名事件订阅只对 `/api/events/stream` 有效。

## 一、事件类型（CovelEvent）

所有 server→client 事件现在收口为 `packages/shared/src/types/protocol.ts` 中的**单一 discriminated union** `CovelEvent`（`{ type; payload }`），它是事件名、转发白名单、前端穷尽校验的唯一真相。`ProtocolEventType` 现为 `CovelEvent['type']` 的历史别名（保留向后兼容）。

新增一个 SSE 事件 = 在 `CovelEvent` 加一个成员 + 在 `COVEL_EVENT_META` 加一条元数据，二者由 `satisfies Record<CovelEventType, CovelEventMeta>` 互相约束——漏改任一处即编译失败。

下表列出稳定事件类型。`/api/events/stream` 始终以命名事件帧（`event: <type>\ndata: ...`）发送；`/api/actions` 也使用同一组 `type` 字符串，但作为 `SseEnvelope.type` 包在 data-only 帧里。`/api/actions` 转发的若干**运行时内部 / trace 事件**（见末尾「转发的运行时内部事件」小节）现已纳入同一个 `CovelEvent` union，并通过 `COVEL_EVENT_META[type].forwardToActionStream` 标记是否转发。

### 叙事事件

| 事件类型              | 方向 | 描述             | 负载                                                |
| --------------------- | ---- | ---------------- | --------------------------------------------------- |
| `narrative.delta`     | S→C  | 流式叙事文本片段 | `{ runtimeId, pluginId, kind, delta }`              |
| `narrative.completed` | S→C  | 完整叙事消息     | `{ content, kind, messageId, runtimeId, pluginId }` |

### 交互事件

| 事件类型                | 方向 | 描述                           | 负载                                                       |
| ----------------------- | ---- | ------------------------------ | ---------------------------------------------------------- |
| `interaction.requested` | S→C  | 请求玩家输入（表单/选择/确认） | `{ block: { id, type, data, meta }, runtimeId, pluginId }` |

### 状态事件

| 事件类型         | 方向 | 描述         | 负载                                              |
| ---------------- | ---- | ------------ | ------------------------------------------------- |
| `state.changed`  | S→C  | 游戏状态变更 | `{ table, field, value, runtimeId, pluginId }`    |
| `event.emitted`  | S→C  | 游戏业务事件 | `{ topic?, type?, eventType?, data?, pluginId? }` |
| `record.updated` | S→C  | 长期记录更新 | `{ key, value, recordType, runtimeId, pluginId }` |

### 执行生命周期事件

| 事件类型              | 方向 | 描述              | 负载                                                                                                                                                                                            |
| --------------------- | ---- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution.started`   | S→C  | 回合执行开始      | `{ runtimeCount }`                                                                                                                                                                              |
| `runtime.started`     | S→C  | 单个 runtime 开始 | `{ runtimeId, pluginId, label }`                                                                                                                                                                |
| `runtime.completed`   | S→C  | 单个 runtime 完成 | `{ runtimeId, pluginId, durationMs }`                                                                                                                                                           |
| `runtime.failed`      | S→C  | 单个 runtime 失败 | `{ runtimeId, pluginId, error }`                                                                                                                                                                |
| `execution.completed` | S→C  | 回合执行完成      | `{ runtimeCount, resultCount, durationMs, abortReason? }`（`abortReason` 仅在回合被中止时出现：cost-gate 硬预算上限、玩家 abort（值 `"aborted-by-player"`）等——前端据此提示玩家而非静默空回合） |

### 回合中控制（W4：steer / abort）

回合中控制走 HTTP 端点而非 SSE 事件（见 [api.md § 回合中控制](./api.md#回合中控制w4)）：

- **steer**（`POST /api/sessions/:id/steer`）：玩家在回合进行中插话。消息进入服务端 per-session 队列，story runtime 在下一次 LLM 调用前把队列并入实时 transcript；若插话在最终响应流式期间才到达，story runtime 会在收尾前追加一步 LLM 调用消化它（受 maxSteps 约束）。同时持久化为 user 消息（后续回合的历史自然包含）；持久化失败时撤回队列项并返回 500，保证队列与历史一致。客户端本地回显即可，无新增 SSE 事件。
- **abort**（`POST /api/sessions/:id/abort`）：触发回合级 AbortSignal——重试层立刻切断在途 LLM 调用/流（玩家 abort 不可重试、**绕过流式 salvage**，不会把半截叙事当作结果提交），executor 停止调度后续 runtime 组并跳过事件链。被中止的 runtime 以 failed 上报（`runtime.failed`），其提案不产出；abort 前已完成的 runtime 结果照常提交。当次 `execution.completed` 带 `abortReason: "aborted-by-player"`（常量 `PLAYER_ABORT_REASON`，定义于 `@covel/shared`）。客户端收到该值时把它当作玩家主动的终态而非错误：丢弃该回合未提交的流式占位消息（服务端从不提交半截叙事，保留会造成刷新后消失的“幽灵文本”），不显示错误/重试提示；其他 `abortReason`（如 cost-gate）仍按错误提示展示。

### 会话生命周期事件

（turn-band 重构后 `phase.changed` 已废弃：`SessionRecord.phase` 字段移除，运行进度改由 `turnCount` + `preGameCompleted` 描述。未来若需要推送 `status` 变化，将以 `status.changed` 形式重新引入，届时在此补记。）

### 系统事件

| 事件类型         | 方向 | 描述     | 负载          |
| ---------------- | ---- | -------- | ------------- |
| `error.occurred` | S→C  | 执行错误 | `{ message }` |

### 世界事件

| 事件类型                   | 方向 | 描述                       | 负载                         |
| -------------------------- | ---- | -------------------------- | ---------------------------- |
| `world.dimensions.changed` | S→C  | 世界维度文件变更（热更新） | `{ worldId, changedKeys[] }` |

### 插件数据事件

| 事件类型              | 方向 | 描述               | 负载                                                                       |
| --------------------- | ---- | ------------------ | -------------------------------------------------------------------------- |
| `plugin-data.changed` | S→C  | 插件持久化数据变更 | `{ pluginId, runtimeId, changes: [{ namespace, key, value, operation }] }` |

`plugin-data-set` / `plugin-data-set-batch` / DELETE `/plugin-data/...` 等所有写路径均会触发此事件。`operation` 字段为 `'set'` 或 `'delete'`（删除时 `value` 为 `null`），由 `wrapStoreWithPluginDataEvents` 在 store 层统一拦截，前端可实时响应插件状态变更。

### 媒体资产事件

图像生成插件的完成态输出使用 `assetGenerations[]`。runtime normalizer 会把每一项转成 `asset.generate` proposal,并在 commit 后写入 trace / SSE 视图。

```ts
type AssetGeneration = {
  ref: MediaRef;
  modality: string; // e.g. "image", "audio", "video", "file"
  meta?: Record<string, unknown>;
};
```

生成中进度使用独立的 `asset.progress` 事件。function runtime 可调用 `ctx.assetProgress({ phase, percent, assetId, modality, message, meta })`；服务端会写入 trace 并经 `/actions` SSE 转发。`percent` 取值为 `0..100`。最终可持久化资产继续通过 `assetGenerations[]` 进入 `asset.generate` commit 路径。

| 事件类型          | 方向 | 描述                                   | 负载                                                                                     |
| ----------------- | ---- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `asset.progress`  | S→C  | 多模态生成进度                         | `{ runtimeId, pluginId, turnId, assetId?, phase, percent?, modality?, message?, meta? }` |
| `asset.generated` | S→C  | 资产完成并通过 `asset.generate` commit | `{ proposalId, runtimeId, pluginId, asset: AssetGenerateView }`                          |

`ref` 必须来自 `ctx.media.put()` 或 `ctx.media.ingestUrl()`。provider wire 层可短暂收到 `b64_json`、远程临时 URL 或 SDK 字节结果；handler 在返回前完成 MediaStore ingest,然后只通过 `assetGenerations[]` 和业务索引记录暴露 `MediaRef`。

图像画廊类插件仍可用 `plugin_data.images` 保存查询索引,索引值保存 `{ status, ref, prompt, ... }`。`Image` / `Media` 组件消费 `MediaRef`,由框架解析为展示 URL。

声明 `image-generation` capability 的插件在完成态缺少 `assetGenerations[]` 时会产生 `image.generate.asset_missing` error。`plugin_data.images` 中出现 `url` / `base64` / `dataUrl` 字段时会产生 `image.generate.plugin_data_inline_media` error；框架不会从这些旧字段合成 `asset.generated` 事件。

### LLM content parts

`@covel/ai-provider` 的 `TextMessage.content` 使用双形态契约：

| 形态            | 用途                                                                                      | 生命周期 |
| --------------- | ----------------------------------------------------------------------------------------- | -------- |
| `string`        | 纯文本消息快路径                                                                          | 长期保留 |
| `null`          | assistant tool-call 等 provider 允许空内容的消息                                          | 长期保留 |
| `ContentPart[]` | 多模态消息路径，当前包含 `{ type: "text", text }` 与 `{ type: "image", image: MediaRef }` | 长期保留 |

`@covel/shared` / `@covel/runtime` 保持 provider-agnostic content parts；`@covel/ai-provider` adapter 负责把 `MediaRef` 编码成各 provider 的 wire shape。`assetGenerateToLLM()` 会把 `asset.generate` proposal 派生成文本摘要，并在图片资产场景追加 image part。

Provider 图片输入矩阵：

| Provider 路径                     | 图片 wire shape                                   | 输入优先级                                                                           | 当前状态                         |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| OpenAI Chat                       | `{ type: "image_url", image_url: { url } }`       | `MediaRef.url` URL / data URL 优先；File API 作为大图或复用资产后续能力              | URL-backed image parts 已实现    |
| OpenAI Responses                  | `{ type: "input_image", image_url }`              | `MediaRef.url` URL / data URL 优先；File API 作为大图或复用资产后续能力              | URL-backed image parts 已实现    |
| Anthropic Messages                | `{ type: "image", source: { type: "url", url } }` | URL source 优先；Files API 用于大图或复用资产；base64 用于小图兜底                   | URL-backed image parts 已实现    |
| Gemini native                     | File API 或 `inlineData`                          | 大图 / 复用资产走 File API，小图走 `inlineData`；URL 输入先由框架或 adapter 取回字节 | native adapter 后续实现          |
| Gemini OpenAI-compatible endpoint | 跟随 OpenAI Chat / Responses 形态                 | 使用 OpenAI-compatible adapter 的 URL / data URL 路径                                | 随 OpenAI-compatible preset 生效 |

当前 adapter 直接消费 `MediaRef.url`。缺少 `url` 的 image part 会序列化为文本 `image_ref` JSON，保留资产 id / mime / size 供 trace 和模型上下文读取。远程 provider vision 调用应在进入 adapter 前提供 provider 可取回的 URL、data URL 或 provider file upload 引用；`file://` / `memory://` 这类本地 URL 主要服务本地后端、测试与展示路径。

**保留命名空间 `_jobs`（后台任务协议）:**

`POST /api/sessions/:id/plugin-rpc` 的 runtime 级 + `execution: background` 分支使用 `_jobs` 命名空间写回任务进度：

| `value.status` | 语义                                                  | 前端行为                           |
| -------------- | ----------------------------------------------------- | ---------------------------------- |
| `pending`      | 任务已受理,runtime 尚未完成                           | 渲染 loading 占位                  |
| `done`         | 成功完成,`value.runtimeResults` 为 `executeTurn` 汇总 | 把结果合并回业务命名空间或直接显示 |
| `failed`       | runtime 抛错,`value.error` 为消息                     | 展示错误并让用户重试               |

所有 `_jobs/<jobId>` 的写入都是普通 `setPluginData` 调用，因此都会通过标准 `plugin-data.changed` 频道广播。插件**禁止**直接写入 `_jobs` —— 框架独占该命名空间。业务数据请使用自定义命名空间（如 `images`、`prompts`）。

### Suspend / Resume 事件（S4-T4）

| 事件类型         | 方向 | 描述                                                                            | 负载                                                        |
| ---------------- | ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `turn.suspended` | S→C  | 插件调用 `suspend()` 工具成功序列化 pendingContinuation 后由 turn-executor 发出 | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed`   | S→C  | `POST /api/sessions/:id/resume` 成功重新启动 runtime 后由 resume 路由发出       | `{ sessionId, turnId, suspensionId }`                       |

### Snapshot / Fork 事件（S4-T2 / S4-T5）

所有 snapshot 事件由服务端经 eventBus 广播（topic=`session`），SSE 命名事件名来自 payload 的 `_subType`。

| 事件类型                 | 方向 | 描述                                                                                                                                | 负载                                                                            |
| ------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `state.snapshot.created` | S→C  | 新 snapshot 已写入。由 turn-executor（auto）和 snapshots 路由（manual / fork）发出                                                  | `{ turnId, snapshotId, kind: 'auto' \| 'manual' \| 'fork', parentSnapshotId? }` |
| `session.forked`         | S→C  | `POST /api/sessions/:id/fork` 成功物化子 session 后由 snapshots 路由发出。fork 同时发出一条 `state.snapshot.created`（kind='fork'） | `{ parentSessionId, childSessionId, fromSnapshotId, forkSnapshotId }`           |

发射点对照：

| 触发路径                          | 事件序列                                                | 来源                                                          |
| --------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| `executeTurn` 自动捕获            | `state.snapshot.created` (kind=auto)                    | `packages/runtime/src/turn-executor/turn-result-finalizer.ts` |
| `POST /api/sessions/:id/snapshot` | `state.snapshot.created` (kind=manual)                  | `apps/server/src/routes/api/snapshots.ts`                     |
| `POST /api/sessions/:id/fork`     | `state.snapshot.created` (kind=fork) → `session.forked` | `apps/server/src/routes/api/snapshots.ts`                     |

> 前端若要接收上述事件，需在 `apps/web/src/services/subscription.ts` 的 topic 路由里为 `state.snapshot.created` / `session.forked` 显式分发。当前尚未挂载这两个监听；在 fork / save UI 真正落地前，服务端已经在 SSE 通道上发送，前端订阅即生效。

### Working Memory / 上下文压缩事件

`working_memory.changed` 由 commit chain 在提交 `working_memory.set` proposal 后通过 `makeEvent` 产出，作为 commit event **直接写入 `/api/actions` 流**（与 `narrative.completed` 等同走 commit-direct 路径，不经 `FORWARDED_EVENT_TYPES` 白名单）。因此它**是 `CovelEvent` union 的成员**（`COVEL_EVENT_META` 中 `forwardToActionStream: false`——该 flag 只管 eventBus→action-stream 转发，对 commit-direct 事件无效）。前端 actions handler **显式不渲染**它（UI 通过 `state.changed` 感知 working memory 变化），但因它已在闭合 union 内，新增同类事件会被前端穷尽校验强制做出「处理或忽略」的决定。此前它被发射却缺席 union，每次提交都落到前端 `assertNeverEvent` 并 `console.warn`——已修复。

`context.compacted` 仍为 **trace-only by design**：由 Compactor 完成摘要写入后写入 `trace_events` 表，不进入 `CovelEvent` union，也没有 SSE 推送计划，仅可通过 `/api/traces/:sessionId` 离线查询。

`recursive.calling` / `recursive.completed` / `recursive.failed` 为递归 runtime 的 TurnEmitter trace 事件，**仅经订阅通道（topic `trace`）下发**，`forwardToActionStream: false`，不进入 `/api/actions`。它们现在也是 `CovelEvent` union 成员——使框架所有 `TurnEmitter.emit` / `makeEvent` 的事件名都受闭合 union 约束（发射端 `type` 已收紧为 `CovelEventType`，发射 union 外事件即编译错误）。

| 事件                     | 触发点                                             | 当前出口                                          | payload                                                         | 备注                                                                   |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `working_memory.changed` | commit chain 提交 `working_memory.set` proposal 后 | commit event → `/api/actions`（CovelEvent union） | `{ scope, key }`（顶层带有 sessionId/turnId/source）            | union 成员；前端显式忽略，UI 通过 `state.changed` 感知                 |
| `context.compacted`      | Compactor 完成摘要写入后                           | `trace_events` 表                                 | `{ summaryId, messagesCompacted, tokenSavings, focusSections }` | trace-only by design，不进 union，仅可通过 `/api/traces/:sessionId` 查 |

### SSE 帧格式按通道区分

| 通道                     | 帧形态                                                      | 客户端订阅方式                                                              | 文件                                               |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/actions`      | data-only（`data: <SseEnvelope JSON>`，**无 `event:` 头**） | `fetch()` + `ReadableStream`，按行扫 `data:` 解 JSON 后看 `envelope.type`   | `apps/web/src/services/api/actions.ts: sendAction` |
| `GET /api/events/stream` | 命名事件（`event: <type>\ndata: <ProtocolEvent JSON>`）     | `EventSource` + `addEventListener('<type>', handler)` —— 不监听就被静默丢弃 | `apps/web/src/services/subscription.ts`            |

`/api/events/stream` 在连接建立时先发一条 `system.connected`，每 30s 发 `system.heartbeat`；带 `lastEventId` 时会先回放 EventBus 缓存中 `seq > lastEventId` 的事件再切到实时。

#### 事件 id 形态：`${epoch}:${seq}`（H-05/H-06）

每条订阅事件的 `id`（同时是 SSE `id:` 行与重连时的 `lastEventId` 游标）为 `${epoch}:${seq}`：

- `seq` —— 每个 session 单调递增的序号。
- `epoch` —— 服务端 session 回放状态**每次(重新)创建**时铸造的不透明字符串（进程重启、LRU/TTL 驱逐后重建都会换新 epoch）。客户端只做**相等比较**，不解析其内部结构。epoch 变化即意味着「游标已失效，需要重置」。

解析用 `@covel/shared` 的 `parseSubscriptionEventId(id) → { epoch, seq } | undefined`（旧的纯数字 id 解析为 `undefined`，服务端一律以 `system.reset` 应答）。活跃 SSE 订阅期间该 session 的回放状态被 `pin` 住，不会被驱逐/换 epoch（H-06）。

#### `system.reset` 控制帧（H-05）

带 `lastEventId` 重连时，若游标无法被桥接，服务端**不做部分回放**，而是发一条**无 `id:` 头**的 `system.reset` 命名事件，客户端应据此**清空本地游标（lastEventId）+ 重新拉取权威状态**，再继续消费实时事件：

```
event: system.reset
data: {
  "sessionId": "<sessionId>",
  "reason": "gap" | "epoch-change" | "transport-gap",
  "epoch": "<current server epoch>",
  "oldestSeq": <number>,   // 缓存中最旧保留的 seq（无保留时为 0）
  "latestSeq": <number>,   // 本 epoch 已发出的最新 seq（未发过为 0）
  "timestamp": "<ISO8601>"
}
```

触发条件：

- `reason: "epoch-change"` —— 游标 epoch 与当前不符（含驱逐/重启后的换代，及无法解析的旧格式游标）。
- `reason: "gap"` —— epoch 相符但环形缓存已越过游标（`afterSeq` 早于 `oldestSeq`），或游标 seq 超前于 `latestSeq`。
- `reason: "transport-gap"` —— 跨 pod transport 检测到真实序号缺口；本地 replay 立即清空并换 epoch，所有已连接客户端收到 reset 后断线重连。

该帧与 `system.connected` / `system.heartbeat` 一样**不带 `id:` 头**，因此不会污染 `EventSource` 的 `lastEventId`。

`DEPLOYMENT_TIER=demo|commercial` 时该端点强制 session owner token 鉴权（audit S-02）。内置 Web 使用 fetch-based SSE 并提交 `X-Session-Token`；原生 `EventSource` 客户端可用 `?session_token=<ownerToken>`。缺失或错误返回 `401 { code: "session_owner_required" }`。`self`（默认）层级不强制。详见 [`docs/reference/api.md`](./api.md) 鉴权章节。

Web 收到 reset 或重连后会以 revision guard 重新拉取 session snapshot、plugins、全部 active plugin data、未解决 suspensions 与 world，并缓冲期间到达的 live events 后重放。服务端对 SSE write 使用单一有界串行队列（256），连接预算为每 session 8、进程总计 512；超限返回 429，慢客户端溢出时主动断开。

`apps/web/src/services/subscription.ts` 默认订阅 topic `runtime / state / game / plugin / session / system`（不含 `store`），并按 `event.topic` 路由分发；新增 topic 或 enum 事件时**必须同步更新该文件**。`/api/events/stream` 接受的合法 topic 由 `@covel/shared` 的 `SUBSCRIPTION_TOPICS` 单一真相派生（`subscribe.ts` 的 `VALID_TOPICS` 从中生成）：`runtime / state / game / plugin / session / store / system / trace / hooks`。其中 `trace`（TurnEmitter）与 `hooks`（hook pipeline）为运行时内部可观测性 topic——此前被运行时发出却被 `VALID_TOPICS` 拒绝（`topics=trace` 返回 400），现已纳入 union 并对齐。`/api/actions` 的回合内事件（`narrative.delta` / `narrative.completed` / `interaction.requested` / `plugin-data.changed` 等）在 actions 流里以 data-only 帧推送，由 `apps/web/src/services/api/actions.ts: sendAction` 的回调消费，不经过 `subscription.ts`。

> S4-T5 注意：`state.snapshot.created` / `session.forked` 服务端已经发出但前端尚未挂载 listener（FU-6 / 等 fork & save UI 落地）。此 follow-up 是已知的，与 framework 实现无关。

### 转发的运行时内部事件（`/api/actions` 转发，已纳入 `CovelEvent`）

下列事件由 server 透过 actions SSE 流转发用于 debug / trace。它们现在**已经是 `CovelEvent` union 的成员**（不再是「未进 enum 的私有事件」），并在 `COVEL_EVENT_META` 中标记 `forwardToActionStream: true`。server 的转发白名单 `FORWARDED_EVENT_TYPES` 完全从该元数据**派生**（不再手写 Set）。web 的 actions handler 对这些类型显式 no-op（它们经订阅通道驱动 `/debug` 时间线），但因已在 union 内，新增同类事件会被前端穷尽校验强制做出「处理或忽略」的决定。

| 事件                                                       | 来源                                                                                           | 用途                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `runtime.skipped`                                          | `apps/server/src/routes/api/actions.ts`                                                        | runtime 因 cooldown / startTurn / maxTriggerCount 被跳过                       |
| `character.upserted`                                       | `packages/runtime/src/commit/session-commit-handlers.ts`（`character.upsert` proposal commit） | 与 `record.updated` 平行的角色快照事件                                         |
| `tool.calling` / `tool.completed` / `tool.failed`          | TurnEmitter                                                                                    | LLM 工具调用 trace                                                             |
| `llm.calling` / `llm.responded` / `message.completed`      | TurnEmitter                                                                                    | LLM 调用 trace                                                                 |
| `block.emitted` / `state.patch.applied`                    | TurnEmitter                                                                                    | 块发出 / state patch 应用 trace                                                |
| `hook.fired` / `hook.rewrote` / `hook.aborted`             | TurnEmitter                                                                                    | Hook 行为 trace                                                                |
| `gateway.calling` / `gateway.responded` / `gateway.failed` | TurnEmitter（`withGatewayTrace`）                                                              | function-runtime `ctx.gateway` provider 调用 trace（与 `llm.*` 对等，A2-P1-5） |

> `function.executing` / `function.completed` 为 function-runtime 的 handler 边界 trace 事件（TurnEmitter），`forwardToActionStream: false`——**仅经订阅通道 / trace_events 下发**，与 `recursive.*` 同类，不进入 `/api/actions`。`gateway.*` 则 `forwardToActionStream: true`（对齐 `llm.calling/responded`），故列在上表。两组都已纳入 `CovelEvent` union（发射端受 `CovelEventType` 闭合约束）。
>
> `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed`（A2-P1-5 follow-up）trace 插件自带 wire 的 provider HTTP 调用（`ctx.utils.fetchWithRetry`，图像生成插件走的路径，由 `withUtilsTrace` 在 function-runtime / agent-guard 注入处包裹）。`forwardToActionStream: false`——polling 可能高频，故仅经 trace_events + 订阅通道驱动 `/debug`，不进 action 流。负载仅含 host / method / status / durationMs（**绝不含完整 URL、query、api key**，PII 保护）。

## 二、命令类型（CommandType）

### 会话管理

| 命令              | 方法   | 端点                         | 响应                    |
| ----------------- | ------ | ---------------------------- | ----------------------- |
| `session.create`  | POST   | `/api/sessions`              | JSON: `SessionRecord`   |
| `session.restore` | GET    | `/api/sessions/:id/snapshot` | JSON: `SessionSnapshot` |
| `session.delete`  | DELETE | `/api/sessions/:id`          | JSON: `{ deleted }`     |

### 回合执行（SSE 流式响应）

`/api/actions` 接受的 `type` 字段（实际由 `apps/server/src/routes/api/actions.ts:79` 的 `SUPPORTED_ACTIONS` 数组定义）：

| 命令            | 方法 | 端点                                     | 响应                  |
| --------------- | ---- | ---------------------------------------- | --------------------- |
| `turn.submit`   | POST | `/api/actions` `type: "send_message"`    | SSE: ProtocolEvent 流 |
| `turn.cmd`      | POST | `/api/actions` `type: "execute_command"` | SSE: ProtocolEvent 流 |
| `turn.start`    | POST | `/api/actions` `type: "start_session"`   | SSE: ProtocolEvent 流 |
| `turn.retry`    | POST | `/api/actions` `type: "retry_runtime"`   | SSE: ProtocolEvent 流 |
| `event.trigger` | POST | `/api/actions` `type: "trigger_event"`   | SSE: ProtocolEvent 流 |

> **注意（audit P2-10）**：旧文档曾写 `type: "player_action"`，那是早期原型，当前实现已用 `send_message` 取代。若客户端仍发送 `player_action`，actions 路由会以 `unknown action type` 返回错误。
>
> 区分 chat turn 与 plugin runtime 调用：
>
> - 玩家发送的自然语言走 `/api/actions` `send_message`，触发 narrator 主链。
> - 插件 UI 上的按钮走 `/api/sessions/:id/plugin-rpc`（见下方"插件 RPC"段），单次结构化调用，不会经过 narrator。

### 交互响应

| 命令           | 方法 | 端点                           | 响应                                                                   |
| -------------- | ---- | ------------------------------ | ---------------------------------------------------------------------- |
| `input.submit` | POST | `/api/sessions/:id/plugin-rpc` | Action `{ pluginId: "framework", action: "submit-form" }` 的 JSON 响应 |

### 插件管理

| 命令             | 方法 | 端点                                | 响应                     |
| ---------------- | ---- | ----------------------------------- | ------------------------ |
| `plugin.enable`  | POST | `/api/sessions/:id/plugins/enable`  | JSON: `{ ok, active[] }` |
| `plugin.disable` | POST | `/api/sessions/:id/plugins/disable` | JSON: `{ ok, active[] }` |

### 插件 RPC(PR-3)

统一的"结构化插件指令"通道。同时承载 action 级与 runtime 级调用。Action 级单次 JSON,runtime 级按 `manifest.execution` 分 sync / background 两种响应。

| 命令         | 方法 | 端点                           | 响应           |
| ------------ | ---- | ------------------------------ | -------------- |
| `plugin.rpc` | POST | `/api/sessions/:id/plugin-rpc` | JSON 变体,见下 |

**请求体(action 级或 runtime 级 二选一):**

```json
{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {
    /* ... */
  }
}
```

```json
{
  "pluginId": "my-plugin",
  "runtimeId": "my-plugin/my-runtime",
  "payload": {
    /* ... */
  }
}
```

**响应分支:**

| 状态码 | status                                                                       | 触发                                                                                                                |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 200    | `ok`                                                                         | action 级成功 / runtime 级 sync 模式成功                                                                            |
| 202    | `approval-required`                                                          | community-trust 首次调用(action 或 runtime 级)                                                                      |
| 202    | `accepted`                                                                   | runtime 级 `execution: background`,payload 里含 `jobId` + `turnId`。进度走 `plugin-data.changed` + `_jobs` 命名空间 |
| 400    | `error`                                                                      | 缺字段 / action+runtimeId 互斥违反 / payload 校验失败 / `plugin-mismatch`                                           |
| 404    | `error` (`code: "unknown-action"` / `"runtime-not-active"`)                  | action 未注册 / runtimeId 未加载到该 session                                                                        |
| 429    | `error` (`code: "queue-full"`)                                               | pending approvals 超过 cap                                                                                          |
| 500    | `error` (`code: "runtime-execution-failed"` / `"background-enqueue-failed"`) | sync 执行异常 / 入队失败(background 模式下 runtime 内部异常走 SSE,不进 HTTP)                                        |

**框架默认 action:** 见 [api.md](api.md#post-apisessionsidplugin-rpc) 的"框架默认 action"小节。

### RPC Approval(PR-7)

community-trust 插件的 RPC 调用需要玩家显式批准。框架返回 202 后,前端通过下述端点拉取 / 提交决定。

| 命令              | 方法 | 端点                                  | 响应                                      |
| ----------------- | ---- | ------------------------------------- | ----------------------------------------- |
| `approval.list`   | GET  | `/api/sessions/:id/approvals`         | JSON: `{ pending: RpcApprovalPending[] }` |
| `approval.decide` | POST | `/api/approvals/:approvalId/decision` | JSON: `{ ok, decision, scope, pending }`  |

**Decision 请求体:**

```json
{
  "decision": "allow", // "allow" 或 "deny"
  "scope": "once" // "once" (默认,60s 内消费一次) 或 "session" (本 session 内永久缓存)
}
```

详细流程图见 [api.md](api.md#rpc-approval-流程pr-7)。

## 三、查询端点

只读数据获取，标准 REST GET 响应：

| 查询     | 端点                                              | 响应                                                              |
| -------- | ------------------------------------------------- | ----------------------------------------------------------------- |
| 会话列表 | `GET /api/sessions?worldId=`                      | `{ items: SessionRecord[] }`                                      |
| 会话详情 | `GET /api/sessions/:id`                           | `SessionRecord`                                                   |
| 会话快照 | `GET /api/sessions/:id/snapshot`                  | `SessionSnapshot`（messages/steps 为最近窗口 + `messagesCursor`） |
| 消息列表 | `GET /api/sessions/:id/messages`                  | `FlatMessage[]`（全量）                                           |
| 消息分页 | `GET /api/sessions/:id/messages/page`             | `CursorPage<FlatMessage>`（游标）                                 |
| 角色列表 | `GET /api/sessions/:id/characters`                | `{ items: CharacterRecord[] }`                                    |
| 插件列表 | `GET /api/sessions/:id/plugins`                   | `{ active[], available[] }`                                       |
| 状态查询 | `GET /api/sessions/:id/state`                     | `{ tables }`                                                      |
| 状态补丁 | `GET /api/sessions/:id/state-patches`             | `Patch[]`                                                         |
| 插件数据 | `GET /api/sessions/:id/plugin-data/:pluginId/:ns` | `{ items[] }`                                                     |
| 世界列表 | `GET /api/worlds`                                 | `{ items: WorldRecord[] }`                                        |
| 执行追踪 | `GET /api/traces/:sessionId`                      | `{ events[] }`（全量）                                            |
| 追踪分页 | `GET /api/traces/:sessionId/turns/page`           | `{ turns[], nextCursor }`（游标）                                 |
| 服务健康 | `GET /api/health`                                 | `{ status, version, storeBackend }`                               |

## 四、SSE 信封格式

所有 SSE 事件使用统一信封：

```typescript
interface SseEnvelope {
  type: ProtocolEventType; // 事件类型（标准协议名）
  requestId: string; // 请求关联 ID
  traceId: string; // 追踪 ID
  sessionId: string; // 会话 ID
  turnId: string; // 回合 ID
  seq: number; // 序列号（单调递增）
  timestamp: string; // ISO 时间戳
  payload: Record<string, unknown>; // 事件数据
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

## 六、传输层（真实形态）

> 本节描述真实实现，不是设想。早期类型里曾有一个 `SessionTransport` 接口，注释宣称「所有通讯都通过它抽象」，并列出 `SSETransport` / `WebSocketTransport` / `StdioTransport` / `HTTPTransport` / `LocalTransport` 等实现——但**没有任何实现存在**（全仓零 `implements`、零工厂）。该接口已随本次清理删除。请勿据此以为「换个 Transport 即可上 WebSocket」。

当前没有统一的 transport 抽象层。通讯由以下几条**具体**路径承载（见「架构总览」的三类划分）：

| 方向            | 真实实现                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Command（上行） | REST `POST`，硬编码 `fetch('/api/...')`（`apps/web/src/services/`）                                                                              |
| 回合内 Event    | `POST /api/actions` 的 data-only SSE，`fetch` + `ReadableStream` 解析（`apps/web/src/services/sse.ts` / `api/actions.ts`，信封 = `SseEnvelope`） |
| 辅助 Event      | `GET /api/events/stream` 的命名 SSE，`EventSource` + `lastEventId` 重连（`apps/web/src/services/subscription.ts`，信封 = `ProtocolEvent`）       |
| Query（只读）   | REST `GET`，标准 JSON                                                                                                                            |

唯一真正的部署抽象在**数据层**，不在传输层：`apps/web/src/services/data-service.ts` 的 `DataService` 区分 `local`（浏览器 IndexedDB）与 `remote`（服务器 API）。但它**只覆盖数据 CRUD**——回合执行与上述两条 SSE 流即便在 `local` 模式下也仍然硬连服务器。

### WebSocket 升级路径

升级到 WebSocket **不是**「替换一个 Transport 实现」那么简单：上行/下行目前直接绑定在上述 `fetch` / `EventSource` 调用点上，需要在服务器与前端两侧分别新增 WS 处理与帧编解码。本文档不再承诺一个不存在的可插拔 transport 层。

## 七、Debug trace events

These events ride the standard SSE envelope and are also persisted into `trace_events`. They are emitted by the runtime's `TurnEmitter` (`packages/runtime/src/trace/turn-emitter.ts`), fanned out both to `trace_events` (for the `/api/traces` read API and the `/debug` inspector) and to the global `EventBus` (where the `/api/actions` SSE route re-forwards them through `FORWARDED_EVENT_TYPES` — the set derived from `COVEL_EVENT_META[type].forwardToActionStream`, replacing the former hand-written `FORWARDED_SUBTYPES`).

| Type                  | Payload                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool.calling`        | `{ runtimeId, pluginId, toolName, toolCallId, label, arguments, source, approvalStatus }`                                                                                                                                                                                                                                                  |
| `tool.completed`      | `{ runtimeId, pluginId, toolName, toolCallId, label, result, parsedResult, durationMs, approvalStatus, success: true }`                                                                                                                                                                                                                    |
| `tool.failed`         | `{ runtimeId, pluginId, toolName, toolCallId, label, code, error, details?, durationMs, approvalStatus, success: false }`                                                                                                                                                                                                                  |
| `llm.calling`         | `{ runtimeId, pluginId, slot, model, provider: string \| null, messages, tools, attempt, streaming? }`                                                                                                                                                                                                                                     |
| `llm.responded`       | `{ runtimeId, pluginId, text?, toolCalls?, usage, finishReason, durationMs, attempt, error? }`                                                                                                                                                                                                                                             |
| `message.completed`   | `{ runtimeId, pluginId, content, len, deltaCount }` — `deltaCount` is the number of upstream `narrative.delta` events the runtime produced. Frontend views aggregating live `narrative.delta` streams use a separate synthesized `_aggregated` field; the two are not interchangeable — `deltaCount` is the authoritative persisted count. |
| `block.emitted`       | `{ runtimeId, pluginId, proposalId, source, block }`                                                                                                                                                                                                                                                                                       |
| `ui.rendered`         | `{ runtimeId, pluginId, proposalId, source, render, block? }` — `/actions` SSE forwards this so chat can render committed `ui.render` blocks live; older trace-only payloads may omit `block`, in which case clients synthesize it from `render`.                                                                                          |
| `state.patch.applied` | `{ runtimeId, pluginId, proposalId, patch: { packageName, summary, ops } }`                                                                                                                                                                                                                                                                |
| `hook.fired`          | `{ event, hookName, pluginId, runtimeId?, targetId?, targetType }`                                                                                                                                                                                                                                                                         |
| `hook.rewrote`        | `{ event, hookName, pluginId, runtimeId?, targetId?, diff? }`                                                                                                                                                                                                                                                                              |
| `hook.aborted`        | `{ event, hookName, pluginId, runtimeId?, targetId?, reason }`                                                                                                                                                                                                                                                                             |

Delta narrative continues to ride `narrative.delta` for realtime UI; only `message.completed` is persisted to keep `trace_events` compact.

Payload notes:

- `llm.calling.tools` is `Array<{ name, description, jsonSchema }>` — mapped from `LLMToolDefinition.parameters` so the recorded schema matches what the provider actually received.
- `llm.calling.provider` is `null` at direct `generate` / `generateStream` sites where the resolved provider string is not available; slot-routed calls populate it with the provider name (`openai`, `anthropic`, `deepseek`, `qwen`).
