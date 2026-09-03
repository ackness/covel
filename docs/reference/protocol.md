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

所有 server→client 事件收口为 `packages/shared/src/types/protocol.ts` 中的**单一 discriminated union** `CovelEvent`（`{ type; payload }`），它是事件名、转发白名单、前端穷尽校验的唯一真相；事件名类型直接使用 `CovelEventType`。

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

| 事件类型                 | 方向 | 描述                   | 负载                                               |
| ------------------------ | ---- | ---------------------- | -------------------------------------------------- |
| `state.changed`          | S→C  | 游戏状态变更           | `{ table, field, value, runtimeId, pluginId }`     |
| `event.emitted`          | S→C  | 已提交的游戏业务事件   | `{ topic?, type?, eventType?, data?, pluginId? }`  |
| `domain-event.previewed` | S→C  | 已校验业务事件即时预览 | `{ runtimeId, pluginId, toolCallId, topic, data }` |
| `record.updated`         | S→C  | 长期记录更新           | `{ key, value, recordType, runtimeId, pluginId }`  |

`domain-event.previewed` 在 `emit-event` 工具完成 schema 校验并产出 `emittedEvents` 后立即发出，先于回合事件链和最终事务提交。它只允许驱动可撤销的表现层状态，不代表业务状态已经落库，也不满足 runtime binding/gate。Web 在 `execution.completed`、错误或 proposal 提交失败时清除同一回合预览；对应持久状态到达后以 `plugin-data.changed` 为准。这样舞台动画可在叙事流生成期间响应，同时保留整回合事务的原子性。

### 执行生命周期事件

| 事件类型              | 方向 | 描述                                      | 负载                                                                                                                                                                                                                                                                                                                  |
| --------------------- | ---- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `execution.started`   | S→C  | 回合执行开始                              | `{ runtimeCount }`                                                                                                                                                                                                                                                                                                    |
| `runtime.started`     | S→C  | 单个 runtime 开始                         | `{ runtimeId, pluginId, label }`                                                                                                                                                                                                                                                                                      |
| `runtime.deferred`    | S→C  | staged runtime 已随原始回合提交并转入后台 | `{ runtimeId, pluginId, jobId, sourceTurnId }`                                                                                                                                                                                                                                                                        |
| `runtime.completed`   | S→C  | 单个 runtime 完成                         | `{ runtimeId, pluginId, durationMs }`                                                                                                                                                                                                                                                                                 |
| `runtime.failed`      | S→C  | 单个 runtime 失败                         | `{ runtimeId, pluginId, error }`                                                                                                                                                                                                                                                                                      |
| `execution.completed` | S→C  | 回合执行终态                              | `{ runtimeCount, resultCount, durationMs, committed, error?, abortReason? }`。`committed: true` 表示 proposal、execution journal 与会话时钟已落库；`false` 时 `error` 携带 proposal 或通用事务错误，客户端撤销该回合的 optimistic stream。`abortReason` 仅在回合被中止时出现（玩家 abort 值为 `"aborted-by-player"`） |

> **开场接力**：当一次玩家动作完成了最后一个 setup runtime，`POST /api/actions` 的同一条 SSE 流会自动接力一个主循环回合（见 [api.md § POST /api/actions](./api.md)）。此时流内会出现**两轮** `execution.started` / runtime 生命周期事件（信封 `turnId` 不同——setup 回合 + 接力回合），但只有**一个** `execution.completed` 收尾（前端以它复位 executing 状态并按 `committed` 收敛 optimistic 输出）。setup 提交失败时不会启动接力，终态直接返回 `committed: false`。

`runtime.deferred` 只在原始回合和 `_runtime_jobs` queued 记录原子提交成功、session lock 释放后发出；回滚时不产生“幽灵后台任务”。服务端分别写入当前 `/api/actions` 流，并通过 EventBus 的 `runtime` topic 发给 `/api/events/stream` 持久订阅。其 `COVEL_EVENT_META.forwardToActionStream` 为 `false`，避免 EventBus 再转发一次造成 action 流重复。

### 回合中控制（W4：steer / abort）

回合中控制走 HTTP 端点而非 SSE 事件（见 [api.md § 回合中控制](./api.md#回合中控制w4)）：

- **steer**（`POST /api/sessions/:id/steer`）：玩家在回合进行中插话。消息进入服务端 per-session 队列，story runtime 在下一次 LLM 调用前把队列并入实时 transcript；若插话在最终响应流式期间才到达，story runtime 会在收尾前追加一步 LLM 调用消化它（受 maxSteps 约束）。同时持久化为 user 消息（后续回合的历史自然包含）；持久化失败时撤回队列项并返回 500，保证队列与历史一致。客户端本地回显即可，无新增 SSE 事件。
- **abort**（`POST /api/sessions/:id/abort`）：触发回合级 AbortSignal——重试层立刻切断在途 LLM 调用/流（玩家 abort 不可重试、**绕过流式 salvage**，不会把半截叙事当作结果提交），executor 停止调度后续 runtime 组并跳过事件链。被中止的 runtime 以 failed 上报（`runtime.failed`），其提案不产出；abort 前已完成的 runtime 结果照常提交。当次 `execution.completed` 带 `abortReason: "aborted-by-player"`（常量 `PLAYER_ABORT_REASON`，定义于 `@covel/shared`）。客户端收到该值时把它当作玩家主动的终态而非错误：丢弃该回合未提交的流式占位消息（服务端从不提交半截叙事，保留会造成刷新后消失的“幽灵文本”），不显示错误/重试提示；其他 `abortReason`（如 cost-gate）仍按错误提示展示。

### 会话生命周期事件

（没有 `phase.changed` 事件：`SessionRecord.phase`（`'setup' | 'playing'`）与 `completedPlayerTurns` / `setupRuntimes` 是会话进度的业务真值，但 phase 翻转不单独推送 SSE——客户端从会话响应或快照读取这三个字段。未来若需要推送 `status` 变化，将以 `status.changed` 形式引入，届时在此补记。）

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

### 作业进度事件（job-status，实验性）

| 事件类型             | 方向 | 描述                     | 负载（完整 `JobStatusRecord`）                                                                                                                                                                            |
| -------------------- | ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-status.updated` | S→C  | 长任务作业进度（追加式） | `{ sessionId, progressScopeId, pluginId, runtimeId, jobId, state, progress?, message?, data?, sequence, createdAt }`；staged detached job 的 `data` 含 `{ originTurnId, durableStatus, reason?, error? }` |

长耗时的 function runtime（媒体生成等）在 finalizer 提交之前，通过 `ctx.progress.report({ jobId, state, progress?, message?, data?, sequence })` 实时上报进度。这是 effects 隔离的**唯一实时例外**：上报写入内核 job-status 存储（追加式、按 `(sessionId, progressScopeId, pluginId, runtimeId, jobId, sequence)` 幂等），成功后立即发出本事件并经 `/actions` SSE 转发；它不写游戏态、不满足 binding/gate、不随领域事务回滚。`state` 取值为 `queued | running | progress | waiting-input | succeeded | failed | cancelled`；身份字段全部由内核注入，插件只提供作业业务字段。

staged detached worker 也使用同一事件投影 durable 状态：`queued/claimed/running/committing/succeeded/cancelled` 分别映射为公开的 `queued/running/progress/succeeded/cancelled`；`failed/timed_out/stale/orphaned` 映射为公开 `failed`，具体终态保留在 `data.durableStatus`。`data.originTurnId` 让 Web 把后台任务挂回产生它的原始 turn，而不是后台执行自己的 `backgroundTurnId`。

> 本通道与两个框架保留 namespace 并存：manual/event `execution: background` 使用 `_jobs`；staged `turnCompletion: detached` 使用 `_runtime_jobs`。`job-status.updated` 是它们的实时/恢复投影，不替代领域结果事务。

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

`pending` 行也作为跨 Pod 删除 drain 的权威索引：入队会在 session lock 内先持久化 runtimeId，再启动 detached work。Memory/SQLite 启动时可按进程 owner 将孤儿标为 failed；PostgreSQL 多 Pod 不做不安全的 owner 扫描，崩溃遗留 pending 的自动回收需等待可续租 job lease/持久队列。

**保留命名空间 `_runtime_jobs`（staged detached runtime）:**

`turnCompletion.mode: detached` 的 scheduler 作业使用 `_runtime_jobs/<jobId>` 作为 durable source of truth。queued 记录与原始回合 proposal、journal 和会话时钟在同一事务中落库；worker 再通过 `compareAndSetPluginData` claim 并续租，防止多 Pod 重复执行或迟到结果复活。

| durable status        | 语义                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `queued`              | 已随原始回合提交，等待 worker；超过 `maxQueueMs` 转 `timed_out`                                                  |
| `claimed` / `running` | worker 已取得 CAS lease / 正在执行；同一 session/plugin/runtime 保持串行                                         |
| `committing`          | 已通过 owner CAS，正在 session lock 内做 stale/effect guard 和领域提交                                           |
| `succeeded`           | 后台 proposal 已提交，`result` 保存 background turn/execution/runtime 摘要                                       |
| `failed`              | 执行、effect guard 或领域提交失败；`reason/error` 为权威原因                                                     |
| `timed_out`           | 排队或 `maxExecutionMs` 到期；迟到执行不能再进入 committing                                                      |
| `cancelled`           | 控制面取消终态；不能转回 active 或接受迟到结果                                                                   |
| `stale`               | session inactive、session/plugin incarnation 或版本已变化；提交屏障以 `reason: commit-barrier-rejected` 拒绝结果 |
| `orphaned`            | 在途 owner 停止续租且 lease 过期                                                                                 |

启动恢复会继续执行未过排队期限且从未 claim 的 `queued` 作业；排队超时会终态化为 `timed_out`，lease 已过期的 `claimed/running/committing` 作业会终态化为 `orphaned`，这些终态**不自动 replay**，避免 provider 已计费但响应未落库时被重复扣费。提交前会重新确认 session 仍 active、session incarnation、插件 approval scope 和版本未变化，并以 manifest 的隔离 effects 白名单检查实际 proposal。`_runtime_jobs` 不进入 snapshot/fork payload，也不允许插件直接读写。当前没有用旧值表达新策略的兼容折叠；未来扩展状态或 overlap/stalePolicy 时必须同步升级 schema version、合法迁移图、SSE 投影与客户端 hydration。

客户端可用 `GET /api/sessions/:id/runtime-jobs` 恢复状态与成功结果；响应会移除包含冻结输入、设置与审批身份的内部 `payload`。detached runtime 内部通过 `ctx.progress` 发出的插件子任务消息会由内核在 `data` 中追加不可伪造的 `runtimeJobId` 与 `originTurnId`，客户端据此折叠到父任务，而不是产生孤立状态行。`POST .../:jobId/cancel` 只接受 `queued/claimed/running`，以 CAS 写入 `cancelled`，已经进入 `committing` 或终态的作业返回冲突。`POST .../:jobId/retry` 只接受失败类终态，显式创建新 `jobId` 和 queued 记录并使用当前 session incarnation、approval scope、locale 与 runtime model overrides；旧终态不改变，也不会被后台自动重放。

### Suspend / Resume 事件

| 事件类型         | 方向 | 描述                                                                                                                          | 负载                                                        |
| ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `turn.suspended` | S→C  | runtime 创建 suspension artifact；`finalizeExecution` 将记录与同一 execution 的写入提交成功后才发出。回滚不保留记录也不发事件 | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed`   | S→C  | `POST /api/sessions/:id/resume` 成功重新启动 runtime 后由 resume 路由发出                                                     | `{ sessionId, turnId, suspensionId }`                       |

### Snapshot / Fork 事件

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

> 内置 Web 当前不提供 snapshot / fork 操作界面。外部客户端可从 `session` topic 消费上述事件。

### Working Memory / 上下文压缩事件

`working_memory.changed` 由 commit chain 在提交 `working_memory.set` proposal 后通过 `makeEvent` 产出，作为 commit event **直接写入 `/api/actions` 流**（与 `narrative.completed` 等同走 commit-direct 路径，不经 `FORWARDED_EVENT_TYPES` 白名单）。因此它**是 `CovelEvent` union 的成员**（`COVEL_EVENT_META` 中 `forwardToActionStream: false`——该 flag 只管 eventBus→action-stream 转发，对 commit-direct 事件无效）。前端 actions handler **显式不渲染**它（UI 通过 `state.changed` 感知 working memory 变化）；闭合 union 会强制新增事件在前端选择处理或忽略。

`context.compacted` 是 **trace-only** 事件：由 Compactor 完成摘要写入后写入 `trace_events` 表，不进入 `CovelEvent` union，仅可通过 `/api/traces/:sessionId` 离线查询。

`recursive.calling` / `recursive.completed` / `recursive.failed` 为递归 runtime 的 TurnEmitter trace 事件，**仅经订阅通道（topic `trace`）下发**，`forwardToActionStream: false`，不进入 `/api/actions`。它们现在也是 `CovelEvent` union 成员——使框架所有 `TurnEmitter.emit` / `makeEvent` 的事件名都受闭合 union 约束（发射端 `type` 已收紧为 `CovelEventType`，发射 union 外事件即编译错误）。

| 事件                     | 触发点                                             | 当前出口                                                                | payload                                                         | 备注                                                                                                       |
| ------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `working_memory.changed` | commit chain 提交 `working_memory.set` proposal 后 | commit event → `/api/actions`（CovelEvent union）                       | `{ scope, key }`（顶层带有 sessionId/turnId/source）            | union 成员；前端显式忽略，UI 通过 `state.changed` 感知                                                     |
| `proposal.failed`        | proposal 提交失败时（每个失败一条）                | commit-direct → `/api/actions`；manual/background 路径写 `trace_events` | `{ proposalId, proposalType, runtimeId, pluginId, error }`      | 任一失败都会扣留完成屏障（`turn.completed` / 记忆摄入 / auto-snapshot 均不触发），前端映射为可见的执行错误 |
| `context.compacted`      | Compactor 完成摘要写入后                           | `trace_events` 表                                                       | `{ summaryId, messagesCompacted, tokenSavings, focusSections }` | trace-only by design，不进 union，仅可通过 `/api/traces/:sessionId` 查                                     |

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
- `reason: "transport-gap"` —— 跨 pod transport 检测到真实序号缺口。每个 `(origin, session, stream)` 从 `seq=1` 开始校验；新 stream 首帧大于 `1`，或接收状态被淘汰后首帧大于 `1`，均会触发缺口处理。本地 replay 清空并换 epoch，所有已连接客户端收到 reset 后断线重连。

该帧与 `system.connected` / `system.heartbeat` 一样**不带 `id:` 头**，因此不会污染 `EventSource` 的 `lastEventId`。

`DEPLOYMENT_TIER=demo|commercial` 时该端点强制 session owner token 鉴权。内置 Web 使用 fetch-based SSE 并提交 `X-Session-Token`；原生 `EventSource` 客户端可用 `?session_token=<ownerToken>`。缺失或错误返回 `401 { code: "session_owner_required" }`。`self`（默认）层级不强制。详见 [`docs/reference/api.md`](./api.md) 鉴权章节。

Web 收到 reset 或重连后会以 revision guard 重新拉取 session snapshot、plugins、全部 active plugin data、未解决 suspensions 与 world，并缓冲期间到达的 live events 后重放。服务端对 SSE write 使用单一有界串行队列（256），连接预算为每 session 8、进程总计 512；超限返回 429，慢客户端溢出时主动断开。

`apps/web/src/services/subscription.ts` 的通用缺省订阅 topic 为 `runtime / state / game / plugin / session / system`（不含 `store`）；session store 为恢复后台任务另外显式订阅 `job`。客户端按 `event.topic` 路由分发；新增 topic 或 enum 事件时**必须同步更新该文件**。`/api/events/stream` 接受的合法 topic 由 `@covel/shared` 的 `SUBSCRIPTION_TOPICS` 单一真相派生（`subscribe.ts` 的 `VALID_TOPICS` 从中生成）：`runtime / state / game / plugin / session / store / system / trace / hooks / job`。其中 `trace`（TurnEmitter）与 `hooks`（hook pipeline）为运行时内部可观测性 topic，`job` 承载 `job-status.updated`。`/api/actions` 的回合内事件（`narrative.delta` / `narrative.completed` / `interaction.requested` / `plugin-data.changed` 等）在 actions 流里以 data-only 帧推送，由 `apps/web/src/services/api/actions.ts: sendAction` 的回调消费，不经过 `subscription.ts`。

### 转发的运行时内部事件（`/api/actions` 转发，已纳入 `CovelEvent`）

下列事件由 server 透过 actions SSE 流转发用于 debug / trace。它们现在**已经是 `CovelEvent` union 的成员**（不再是「未进 enum 的私有事件」），并在 `COVEL_EVENT_META` 中标记 `forwardToActionStream: true`。server 的转发白名单 `FORWARDED_EVENT_TYPES` 完全从该元数据**派生**（不再手写 Set）。web 的 actions handler 对这些类型显式 no-op（它们经订阅通道驱动 `/debug` 时间线），但因已在 union 内，新增同类事件会被前端穷尽校验强制做出「处理或忽略」的决定。

| 事件                                                       | 来源                                                                                          | 用途                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `runtime.skipped`                                          | `apps/server/src/routes/api/actions.ts`                                                       | runtime 因 cooldown / startTurn / maxTriggerCount 被跳过              |
| `character.upserted`                                       | `packages/runtime/src/commit/session-commit-emitter.ts`（`character.upsert` proposal commit） | 与 `record.updated` 平行的角色快照事件                                |
| `tool.calling` / `tool.completed` / `tool.failed`          | TurnEmitter                                                                                   | LLM 工具调用 trace                                                    |
| `domain-event.previewed`                                   | ToolExecutor（`emittedEvents` 成功后）                                                        | 可撤销表现层即时预览；不代表领域提交                                  |
| `llm.calling` / `llm.responded` / `message.completed`      | TurnEmitter                                                                                   | LLM 调用 trace                                                        |
| `block.emitted` / `state.patch.applied`                    | TurnEmitter                                                                                   | 块发出 / state patch 应用 trace                                       |
| `hook.fired` / `hook.rewrote` / `hook.aborted`             | TurnEmitter                                                                                   | Hook 行为 trace                                                       |
| `gateway.calling` / `gateway.responded` / `gateway.failed` | TurnEmitter（`withGatewayTrace`）                                                             | function-runtime `ctx.gateway` provider 调用 trace（与 `llm.*` 对等） |

> `function.executing` / `function.completed` 为 function-runtime 的 handler 边界 trace 事件（TurnEmitter），`forwardToActionStream: false`——**仅经订阅通道 / trace_events 下发**，与 `recursive.*` 同类，不进入 `/api/actions`。`gateway.*` 则 `forwardToActionStream: true`（对齐 `llm.calling/responded`），故列在上表。两组都已纳入 `CovelEvent` union（发射端受 `CovelEventType` 闭合约束）。
>
> `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` trace 插件自带 wire 的 provider HTTP 调用（`ctx.utils.fetchWithRetry`，图像生成插件走的路径，由 `withUtilsTrace` 在 function-runtime / agent-guard 注入处包裹）。`forwardToActionStream: false`——polling 可能高频，故仅经 trace_events + 订阅通道驱动 `/debug`，不进 action 流。负载仅含 host / method / status / durationMs（**绝不含完整 URL、query、api key**，PII 保护）。
>
> `context.pruned`（TurnEmitter）在 prompt 初次组装、`PostContextAssembly` 改写后或 tool loop 某一步的实际请求触发预算硬裁剪时发出，负载为 `{ runtimeId, pluginId, prunedMessageCount }`；同一 runtime 一回合可能出现多次。`forwardToActionStream: false`——仅进 trace_events / 订阅通道，让 `/debug` 能解释「哪一步掉了历史」，玩家侧 action 流不受影响。若受保护尾部、压缩摘要、工具 schema 与响应 schema 本身已经无法装入预算，runtime 会在调用 provider 前显式失败。

## 二、命令类型（CommandType）

### 会话管理

| 命令              | 方法   | 端点                         | 响应                    |
| ----------------- | ------ | ---------------------------- | ----------------------- |
| `session.create`  | POST   | `/api/sessions`              | JSON: `SessionRecord`   |
| `session.restore` | GET    | `/api/sessions/:id/snapshot` | JSON: `SessionSnapshot` |
| `session.delete`  | DELETE | `/api/sessions/:id`          | JSON: `{ deleted }`     |

### 回合执行（SSE 流式响应）

`/api/actions` 接受的 `type` 字段由 `apps/server/src/routes/api/actions/request.ts` 的闭合请求联合定义：

| 命令            | 方法 | 端点                                     | 响应                  |
| --------------- | ---- | ---------------------------------------- | --------------------- |
| `turn.submit`   | POST | `/api/actions` `type: "send_message"`    | SSE: ProtocolEvent 流 |
| `turn.cmd`      | POST | `/api/actions` `type: "execute_command"` | SSE: ProtocolEvent 流 |
| `turn.start`    | POST | `/api/actions` `type: "start_session"`   | SSE: ProtocolEvent 流 |
| `turn.retry`    | POST | `/api/actions` `type: "retry_turn"`      | SSE: ProtocolEvent 流 |
| `runtime.retry` | POST | `/api/actions` `type: "retry_runtime"`   | SSE: ProtocolEvent 流 |

`retry_turn` 显式重跑整回合，payload 必须为空。`retry_runtime` 必须提供 `payload.runtimeId`，并通过 manual-trigger 路径只重跑该 runtime；它会以源回合（`payload.retryFromTurnId`，缺省取最近的 player-origin 工件）持久化的 runtime 输出**播种**执行，使被重试 runtime 的 `input.inject` / `needs` 按原回合叙事解析——裸 manual 触发这些解析为空，重试型调用因此必须播种。

`start_session` 要求会话已带非空 `activePlugins`（创建会话时选定）。空集合直接 400，不会退化成"激活全部注册插件"——详见 [api.md](./api.md#post-apiactions)。

> `type` 是闭集，上面五种之外的取值一律返回 400 `Unsupported action type`。插件侧发事件请用 builtin `emit-event` 工具。
>
> 区分 chat turn 与 plugin runtime 调用：
>
> - 玩家发送的自然语言走 `/api/actions` `send_message`，触发 narrator 主链。
> - 输入框先用 `GET /api/sessions/:id/plugins` 返回的会话命令目录匹配斜线命令。已知命令走 `/api/sessions/:id/plugin-rpc` 的 `{ commandId, input }` 变体，不经过 narrator；未知命令继续按原有 composer 规则处理（普通空闲提交走 `execute_command`），保留世界/旧插件对自由文本命令的兼容行为。
> - 已声明 command 的插件 UI 按钮使用 JSON-RENDER `invokeCommand`，走 `/api/sessions/:id/plugin-rpc` 的 `{ commandId, args }` 变体，不经过 narrator，并与输入框命令共用参数校验、上下文、审批、handler 和 trace。其他自定义 UI action 才使用 `invokePluginAction`。

### 交互响应

| 命令           | 方法 | 端点                           | 响应                                                                   |
| -------------- | ---- | ------------------------------ | ---------------------------------------------------------------------- |
| `input.submit` | POST | `/api/sessions/:id/plugin-rpc` | Action `{ pluginId: "framework", action: "submit-form" }` 的 JSON 响应 |

### 插件管理

| 命令             | 方法 | 端点                                | 响应                     |
| ---------------- | ---- | ----------------------------------- | ------------------------ |
| `plugin.enable`  | POST | `/api/sessions/:id/plugins/enable`  | JSON: `{ ok, active[] }` |
| `plugin.disable` | POST | `/api/sessions/:id/plugins/disable` | JSON: `{ ok, active[] }` |

### 插件 RPC

统一的"结构化插件指令"通道。同时承载 action 级、runtime 级和命令级调用。Action / command 级返回单次 JSON,runtime 级按 `manifest.execution` 分 sync / background 两种响应。

| 命令         | 方法 | 端点                           | 响应           |
| ------------ | ---- | ------------------------------ | -------------- |
| `plugin.rpc` | POST | `/api/sessions/:id/plugin-rpc` | JSON 变体,见下 |

**请求体(action / runtime / command 级三选一):**

```json
{
  "pluginId": "framework",
  "action": "submit-form",
  "payload": {/* ... */}
}
```

```json
{
  "pluginId": "my-plugin",
  "runtimeId": "my-plugin/my-runtime",
  "payload": {/* ... */}
}
```

```json
{
  "commandId": "dice-check:roll",
  "input": "/roll 2d6"
}
```

```json
{
  "commandId": "dice-check:roll",
  "args": { "notation": "2d6" }
}
```

command 请求的 `input` 与 `args` 必须且只能提供一个。服务端将两者归一化为 `RpcCommandInvocation`，所以日志和后续 handler 以 `commandId + args` 识别同一业务操作；仅 `source` 保留 `composer | plugin-ui` 的入口差异。

**响应分支:**

| 状态码 | status                                                                                                                       | 触发                                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 200    | `ok`                                                                                                                         | action / command 级成功，或 runtime 级 sync 模式成功                                                                |
| 202    | `approval-required`                                                                                                          | community-trust 首次调用(action、command 或 runtime 级)                                                             |
| 202    | `accepted`                                                                                                                   | runtime 级 `execution: background`,payload 里含 `jobId` + `turnId`。进度走 `plugin-data.changed` + `_jobs` 命名空间 |
| 400    | `error`                                                                                                                      | 缺字段 / 三种 selector 互斥违反 / 参数或 payload 校验失败 / `plugin-mismatch`                                       |
| 404    | `error` (`code: "unknown-action"` / `"runtime-not-active"` / `"command-not-active"`)                                         | action 未注册 / runtime 未加载 / command 不在当前会话目录                                                           |
| 409    | `error` (`code: "approval-scope-changed"` / `"session-not-active"` / `"session-deleting"` / `"session-incarnation-changed"`) | 等锁期间授权/会话代次变化，或 session 已暂停、结束、删除中；客户端应刷新后重新发起                                  |
| 429    | `error` (`code: "queue-full"`)                                                                                               | pending approvals 超过 cap                                                                                          |
| 500    | `error` (`code: "runtime-execution-failed"` / `"background-enqueue-failed"`)                                                 | sync 执行异常 / 入队失败(background 模式下 runtime 内部异常走 SSE,不进 HTTP)                                        |

带延迟 `entry` 的 community action 会连续返回两次 `approval-required`：先授权 `covel:plugin-server-code`，重试后再授权真实 action。客户端逐阶段展示审批并重试原请求，最多处理两个阶段，超过上限即终止以避免异常审批循环。

**框架默认 action:** 见 [api.md](api.md#post-apisessionsidplugin-rpc) 的"框架默认 action"小节。

### RPC Approval

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

每个 pending/grant 都绑定服务端持久化的 session incarnation 与 plugin revocation generation。撤销、禁用、删除或同 ID 重建后，旧 decision 返回 `409 approval_scope_changed`；旧 Pod 的内存 grant 也不能命中新代次。

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
| 服务健康 | `GET /api/health`                                 | `{ status, version, bootId, timestamp, storage, vector }`         |

## 四、SSE 信封格式

所有 SSE 事件使用统一信封：

```typescript
interface SseEnvelope {
  type: CovelEventType; // 事件类型（标准协议名）
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
runtime.deferred      → executionSteps（pending，按 sourceTurnId 归属原始回合）
runtime.completed     → executionSteps
runtime.failed        → executionSteps
job-status.updated    → executionSteps（按 data.originTurnId 更新后台终态）
execution.completed   → committed=true: finalize；committed=false: discard optimistic stream + executionError；两者均 executing=false
error.occurred        → executionError
```

## 六、传输层（真实形态）

> 本节描述真实实现，不是设想。**没有统一的 transport 抽象层**，也没有可替换的 Transport 实现——想上 WebSocket 需要改动下面列出的具体路径，而不是换一个实现类。

通讯由以下几条**具体**路径承载。通讯由以下几条**具体**路径承载（见「架构总览」的三类划分）：

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

| Type                     | Payload                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool.calling`           | `{ runtimeId, pluginId, toolName, toolCallId, label, arguments, source, approvalStatus }`                                                                                                                                                                                                                                                  |
| `tool.completed`         | `{ runtimeId, pluginId, toolName, toolCallId, label, result, parsedResult, durationMs, approvalStatus, success: true }`                                                                                                                                                                                                                    |
| `tool.failed`            | `{ runtimeId, pluginId, toolName, toolCallId, label, code, error, details?, durationMs, approvalStatus, success: false }`                                                                                                                                                                                                                  |
| `domain-event.previewed` | `{ runtimeId, pluginId, toolCallId, topic, data }` — `emit-event` 校验成功后的临时表现层信号；持久业务状态仍由正常事件链提交。                                                                                                                                                                                                             |
| `llm.calling`            | `{ runtimeId, pluginId, slot, model, provider?: string \| null, messages, tools, attempt, startedAt, streaming? }`；`slot` 是 runtime 请求的 slot；生产 gateway 在调用前把它解析为 `model` / `provider` 目标身份。不支持 slot 解析的自定义 adapter 可省略 `provider`。                                                                     |
| `llm.responded`          | `{ runtimeId, pluginId, text?, toolCalls?, usage, finishReason, durationMs, attempt, error? }`；`usage` 为 `{ inputTokens, outputTokens, cachedInputTokens?, cacheWriteInputTokens? }`，其中 `inputTokens` 是包含缓存读写的总输入，后两项是 provider 报告的子集。                                                                          |
| `gateway.responded`      | function-runtime gateway 的成功结果；文本/对象调用带 `{ runtimeId, pluginId, method, finishReason, usage, model?, provider?, durationMs }`，`model/provider` 是 fallback 后实际命中的目标。转写调用同样携带可用的 `usage/model/provider`；旧 trace 或不支持该元数据的自定义 gateway 可以省略。                                             |
| `message.completed`      | `{ runtimeId, pluginId, content, len, deltaCount }` — `deltaCount` is the number of upstream `narrative.delta` events the runtime produced. Frontend views aggregating live `narrative.delta` streams use a separate synthesized `_aggregated` field; the two are not interchangeable — `deltaCount` is the authoritative persisted count. |
| `block.emitted`          | `{ runtimeId, pluginId, proposalId, source, block }`                                                                                                                                                                                                                                                                                       |
| `ui.rendered`            | `{ runtimeId, pluginId, proposalId, source, render, block? }` — `/actions` SSE forwards this so chat can render committed `ui.render` blocks live; older trace-only payloads may omit `block`, in which case clients synthesize it from `render`.                                                                                          |
| `state.patch.applied`    | `{ runtimeId, pluginId, proposalId, patch: { packageName, summary, ops } }`                                                                                                                                                                                                                                                                |
| `hook.fired`             | `{ event, hookName, pluginId, runtimeId?, targetId?, targetType, proposalType? }`                                                                                                                                                                                                                                                          |
| `hook.rewrote`           | `{ event, hookName, pluginId, runtimeId?, targetId?, diff?, proposalType? }`                                                                                                                                                                                                                                                               |
| `hook.aborted`           | `{ event, hookName, pluginId, runtimeId?, targetId?, reason, proposalType? }`                                                                                                                                                                                                                                                              |
| `command.invoked`        | `{ invocationId, commandId, command, pluginId, action, source, canonical, raw, argv, args }`；输入框和 JSON-RENDER 使用同一结构。                                                                                                                                                                                                          |
| `command.completed`      | `command.invoked` 的字段 + `{ durationMs, resultOk? }`。                                                                                                                                                                                                                                                                                   |
| `command.failed`         | `command.invoked` 的字段 + `{ durationMs, error }`。                                                                                                                                                                                                                                                                                       |

Delta narrative continues to ride `narrative.delta` for realtime UI; only `message.completed` is persisted to keep `trace_events` compact.

`command.*` 由 action 级 command dispatcher 的 TurnEmitter 写入 `trace_events` 并发布到 `trace` 订阅 topic，`forwardToActionStream: false`，因此不会污染游戏 `/api/actions` 流。三个事件共享 `invocationId` 作为 `traceId/turnId`；日志不持久化完整 handler 返回值，只记录终态、耗时和可选 `resultOk`。`raw` / `args` 会按设计进入 trace，命令参数不得承载 API key、凭据或其他秘密。

Payload notes:

- `/api/traces/*` 的读模型在不修改原始 `payload` 的前提下，为每条事件补充
  持久化 `id`、响应内单调 `eventOrder` 与统一 `diagnostic` 摘要。客户端可直接用
  `diagnostic.error` 定位失败，用 `diagnostic.prompt` 找到提示词规模与正文路径；
  不需要按事件类型猜测 `payload` 字段。
- `eventOrder` 从 0 开始，仅表示当前 API 响应（全量结果或单页）中的 chronological
  record order，不是全局数据库序号，不能跨页比较。
- `diagnostic.severity` 为 `info` / `warning` / `error`；错误优先。成功的
  `llm.responded`、`gateway.responded`、`utils.fetch.responded`、`tool.completed`、
  `runtime.completed`、`function.completed` 达到 1000ms 时标为 `warning`，并带
  `diagnostic.warning = { code: "slow", thresholdMs: 1000 }`。
- `tool.*` 事件带 `diagnostic.tool` 摘要（name、callId、参数/结果可用性与
  `payload.arguments` / `payload.result` 等内容路径、success、durationMs）；原始
  参数和结果仍只在 `payload`。
- `llm.calling.payload.startedAt`（并投影为 `diagnostic.startedAt`）记录真实 provider
  请求开始时间。事件自身 `timestamp` 仍是 trace 行持久化时间；部分 adapter 为了先确认
  最终 provider/model 会稍后写入 calling 事件，耗时判断应结合 `startedAt` 与 responded
  的 `durationMs`。
- `llm.calling.tools` is `Array<{ name, description, jsonSchema }>` — mapped from `LLMToolDefinition.parameters` so the recorded schema matches what the provider actually received.
- `llm.calling.provider` is `null` at direct `generate` / `generateStream` sites where the resolved provider string is not available; slot-routed calls populate it with the provider name (`openai`, `anthropic`, `deepseek`, `qwen`).
