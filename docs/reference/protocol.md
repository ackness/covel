# SSE 协议

这一页讲客户端和 Covel 服务端之间怎样通讯：客户端发什么请求，服务端推什么事件，每个事件带什么数据，断线之后怎样恢复。

它适合三类读者：写自己的客户端的人、把 Covel 运行时嵌进自己宿主的人，以及改内置网页端或服务端的人。只写插件一般用不到这一页；插件能发的事件见[工具参考](./tools.md)，HTTP 接口的完整说明见 [api.md](./api.md)。

类型定义在 `packages/shared/src/types/protocol.ts`。

## 架构总览

所有通讯分成三类：

| 类别            | 方向            | 形式                                                             |
| --------------- | --------------- | ---------------------------------------------------------------- |
| 命令（Command） | 客户端 → 服务端 | `POST` 等请求，会改变状态。回答是 JSON（马上返回）或 SSE（流式） |
| 事件（Event）   | 服务端 → 客户端 | 两条独立的 SSE 流，见下表                                        |
| 查询（Query）   | 客户端 → 服务端 | `GET` 请求，只读，普通的 REST JSON 回答                          |

SSE 是服务端在一条 HTTP 连接上持续推送文本的方式。Covel 有两条 SSE 流，它们的格式不一样：

|            | 主通道 `POST /api/actions`                                    | 辅助通道 `GET /api/events/stream`                                                                        |
| ---------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 用途       | 一次玩家动作（一个回合）期间的事件                            | 回合之外的持续订阅：后台任务、别处的改动                                                                 |
| 帧的样子   | 只有 `data:` 行，**没有 `event:` 头**                         | 命名事件：`event: <type>\ndata: ...`                                                                     |
| 外层结构   | `SseEnvelope`（`requestId` / `traceId` / `flowId` / `seq` …） | `ProtocolEvent`（`id` / `source` …）                                                                     |
| 客户端读法 | `fetch` + `ReadableStream`，逐行读 `data:`                    | `fetch` 读流，按 `event:` 头分发                                                                         |
| 其他       | 流随动作结束而结束                                            | 按 topic 订阅；连接时发 `system.connected`，每 30 秒发 `system.heartbeat`；带 `lastEventId` 重连可以补发 |

> [!WARNING]
> `/api/actions` 的帧没有 `event:` 头。所以 `EventSource.addEventListener('narrative.delta', …)` 这种按事件名订阅的写法，在这条流上**永远不会**触发。读回合内的事件，请用 `apps/web/src/services/api/actions.ts` 的 `sendAction`（它用 ReadableStream 解析），或者自己用 `fetch()` 读 `data:` 行。按事件名订阅只对 `/api/events/stream` 有效。

## 宿主执行与提交边界

这一节写给把 `@covel/runtime` 嵌进自己服务的人。核心只有一句：**执行成功不等于提交成功**。一次执行先算出结果，再由宿主把结果写进存储；只有写成功了，才算数。

### 执行和提交是两步

`@covel/runtime.executeTurn` 和 `resumeSuspendedRuntime` 返回 `{ result, commit }`：

- `result` 是可以用来回答客户端的执行结果。
- `commit` 是留在宿主手里的完整提交计划。它包含顶层和递归的结果、待提交的命令、对话 journal、暂停记录、Hook 设置的快照、回合计数的责任，以及执行时加载的输出 schema。

宿主调用 `commitExecution({ execution, store, completion, ...services })` 完成提交。宿主不用自己收集这些字段，提交时也不会重新加载插件。公开的执行入口要求 `deps.store`。

```ts
const execution = await executeTurn(input, runtimes, deps);
const outcome = await commitExecution({
  store: deps.store,
  execution,
  completion: {
    kind: "turn",
    turnId: execution.result.turnId,
    durationMs: execution.result.durationMs,
  },
});
// Respond only after interpreting the durable commit outcome.
return { result: execution.result, committed: outcome.status === "committed" };
```

> [!IMPORTANT]
> 只把 `result` 发给客户端。不能把 `commit` 发出去，也不能接受客户端提交的 `commit`。两者都不带收尾函数。

### 宿主负责的事

- 鉴权、会话锁、请求取消，以及执行和恢复的 claim，仍然由宿主负责。上面的调用要遵守宿主自己的锁策略。
- 玩家这一回合的身份通过 `input.logicalTurnId` 明确传入。
- 有暂停记录时，回合计数推迟。同一个逻辑回合的最后一次成功恢复，通过 ledger 计数一次。失败的恢复不能确认 continuation。
- 后台执行在提交锁里重新检查启用的插件集合，并通过 `commitExecution.activePluginIds` 缩小 Hook 的范围。这个参数只能过滤执行时已经记下的插件，不能加入后来才启用的插件。设置仍然用执行时的快照。

### 什么时候不提交

- 提交计划里保留了 TurnStart Hook 的否决原因，以及执行期间看到的取消状态。
- 这样的执行，`commitExecution` 返回失败：在域事务之前停下，不允许宿主的 `extraInTx` 写入，也不产生成功的完成事件或快照。之前已经保存的客户端输入保留。
- 没有提交的执行结束时，客户端撤下这次执行生成的 assistant 内容，保留玩家的输入。
- 本地输入回显按动作的 `requestId` 认领 `turnId`。被拒绝的输入不会归到后续动作；回显在权威消息替换之前不参与历史分页游标。
- 声明了 `output.recordAs` 的成功结果，必须有执行时记下的输出 schema。缺少依赖会让整次提交回滚，不会悄悄跳过导出。已加载的 schema 对单次导出值的校验、媒体的整理和修订冲突的处理，仍然遵循[事务契约](./transactions.md)。

### 挂起和恢复

- function runtime 挂起时，continuation 保存还没提交的命令、输入和导出的绑定，以及 activation。
- 恢复时使用这些冻结的快照。还没提交的命令仍然可以被这次运行读到，并在恢复成功时一起原子提交。
- 恢复失败会丢弃这些域写入。
- continuation 还记下挂起时历史里的玩家回合数和插件版本。恢复时任一项变了，挂起项就被作废，不再运行，见[过时的挂起项](./api.md#过时的挂起项)。

> [!WARNING]
> continuation 的格式更新之后，已有的开发期暂停记录需要重建。

### 工具产生的命令

工具作者返回的 `PluginToolResult` 见[工具结果协议](./tools.md)。内核解包之后，把命令放进 `RuntimeResult.pendingProposals`，业务内容留在 `output`。命令不会出现在公开的执行结果里，也不会出现在保存下来的 turn history 里。

`executeTurn` 的返回值是上面的 `{ result, commit }`，不是 `TurnResult`。`collectExecutionJournal` / `collectExecutionSuspensions` 不是公开 API。

### 并发时的几条规则

- 执行期间提交表单时，先检查互斥，再去取得流的所有权。所以它抢不走正在进行的 action 流。
- 叙事结束之后才到的插话不会被接收，因为模型已经没有机会读它。插话保存下来的记录和实时消息使用同一个身份。
- 生成、修订、翻译这些 SSE 操作有“同一时间只跑一个”的标记。这个标记一直保持到流的回调完成，包括清理阶段。
- 后台作业等待会话锁时，超时之后可以继续等，并且响应取消。普通的交互请求仍然在锁超时后返回“忙碌”。

## 一、事件类型（CovelEvent）

所有服务端发给客户端的事件，都是 `packages/shared/src/types/protocol.ts` 里**同一个联合类型** `CovelEvent` 的成员，形状是 `{ type; payload }`。事件名、转发白名单和前端的穷尽检查都以它为准。事件名的类型是 `CovelEventType`。

新增一个 SSE 事件要改两处：

1. 在 `CovelEvent` 里加一个成员。
2. 在 `COVEL_EVENT_META` 里加一条元数据。

两处由 `satisfies Record<CovelEventType, CovelEventMeta>` 互相约束，漏改任何一处都会编译失败。

下面各表列出稳定的事件类型。两条流用的是同一组 `type` 字符串：

- `/api/events/stream` 总是用命名事件帧发送（`event: <type>\ndata: ...`）。
- `/api/actions` 把它放在 `SseEnvelope.type` 里，包在只有 `data:` 的帧中。

`/api/actions` 还会转发一些运行时内部事件和 trace 事件（见本章末尾的“转发的运行时内部事件”）。它们也在 `CovelEvent` 里，是否转发由 `COVEL_EVENT_META[type].forwardToActionStream` 决定。

表里的“S→C”表示服务端发给客户端。

### 叙事事件

| 事件类型              | 方向 | 描述             | 负载                                                |
| --------------------- | ---- | ---------------- | --------------------------------------------------- |
| `narrative.delta`     | S→C  | 流式叙事文本片段 | `{ runtimeId, pluginId, kind, delta }`              |
| `narrative.completed` | S→C  | 完整叙事消息     | `{ content, kind, messageId, runtimeId, pluginId }` |

- `narrative.delta` 可以带 `reset: true`，这时 `delta` 是空字符串。意思是：同一个 runtime 已经流出来的文字属于工具调用之前的准备步骤，或者是被审查驳回的草稿，不会成为最终的叙事。客户端应该清掉已经显示的部分，再接收后面的片段。
- `narrative.completed` 的 `content` 始终是审查通过之后的最终文本。它替换流式显示的内容。

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

`domain-event.previewed` 是“预览”，不是“已保存”：

- 它在 `emit-event` 工具完成 schema 校验、产出 `emittedEvents` 之后马上发出，早于回合的事件链和最终的事务提交。
- 它只能用来驱动可以撤销的显示效果。它不代表业务状态已经保存，也不满足 runtime 的 binding 和 gate。
- 网页端不直接保存或读取这个事件。服务端将它投影为 `ui.slot.preview`；网页端通过 UI slot 事件显示和清除预览。

这样舞台动画可以在叙事还在生成时就有反应，同时整个回合的事务仍然是原子的。

### 执行生命周期事件

| 事件类型                | 方向 | 描述                                                                                | 负载                                                                                                                    |
| ----------------------- | ---- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `execution.started`     | S→C  | 回合执行开始                                                                        | `{ runtimeCount }`                                                                                                      |
| `interaction.submitted` | S→C  | `submit_interaction` 的回答已落库、后续回合已开始；先于该回合的 `execution.started` | `{ interactionTurnId, results: [{ submissionId, interactionId, values, filledNarrative }], message?: { id, content } }` |
| `runtime.started`       | S→C  | 单个 runtime 开始                                                                   | `{ runtimeId, pluginId, turnId, runId, label }`                                                                         |
| `runtime.deferred`      | S→C  | staged runtime 已随原始回合提交并转入后台                                           | `{ runtimeId, pluginId, jobId, sourceTurnId }`                                                                          |
| `runtime.completed`     | S→C  | 单个 runtime 完成                                                                   | `{ runtimeId, pluginId, turnId, runId, status, durationMs }`                                                            |
| `runtime.failed`        | S→C  | 单个 runtime 失败                                                                   | `{ runtimeId, pluginId, turnId, runId, status, durationMs, error }`                                                     |
| `execution.completed`   | S→C  | 回合执行终态                                                                        | `{ runtimeCount, resultCount, durationMs, committed, error?, abortReason?, resync? }`，各字段见下                       |

`execution.completed` 的字段：

| 字段          | 含义                                                                                                                                                                                               |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `committed`   | `true`：proposal、execution journal 和会话时钟都已经保存。`false`：没有保存，客户端撤掉这一回合先行显示的流式内容                                                                                  |
| `error`       | `committed: false` 时带上 proposal 错误或通用的事务错误                                                                                                                                            |
| `abortReason` | 只在回合被中止时出现。玩家主动停止时，值是 `"aborted-by-player"`                                                                                                                                   |
| `resync`      | 只在 `committed: true`、并且这一回合提交之后有一部分事件没发出去时为 `true`。数据已经保存，客户端应该去读已保存的状态，不要等那些事件。订阅流同时会收到 `system.reset`，`reason: "publish-failed"` |

> [!NOTE]
> **开场接力。** 一次玩家动作完成了最后一个 setup runtime 时，`POST /api/actions` 的同一条 SSE 流会自动接着跑一个主循环回合（见 [api.md § POST /api/actions](./api.md)）。这时流里会出现**两轮** `execution.started` 和 runtime 生命周期事件，它们外层的 `turnId` 不同（setup 回合和接力回合）。但只有**一个** `execution.completed` 收尾。前端靠它结束“执行中”的状态，并按 `committed` 处理先行显示的内容。setup 提交失败时不会启动接力，直接以 `committed: false` 结束。玩家在接力开始前停止时，接力不再开始，`execution.completed` 带接力回合的 `turnId` 和 `abortReason: "aborted-by-player"`。

**`runtime.deferred` 是“移交公告”**

- 它只在原始回合和 `_runtime_jobs` 的 queued 记录原子提交成功、会话锁释放之后才发出。回滚时不会出现并不存在的后台任务。
- 服务端把它分别写进当前的 `/api/actions` 流，并通过 EventBus 的 `runtime` topic 发给 `/api/events/stream` 的订阅者。它的 `forwardToActionStream` 是 `false`，避免 EventBus 再转发一次，让 action 流里出现两条。
- 它不是作业的最新状态，可能比 worker 的状态事件晚到。网页端对同一个 `jobId` 已经看到的进度和终态会保留，迟到的公告不会把它改回 queued。

### 回合中控制（W4：steer / abort）

回合进行中的控制走 HTTP 接口，不是 SSE 事件（见 [api.md § 回合中控制](./api.md#回合中控制w4)）。

**steer：玩家在回合进行中插话**（`POST /api/sessions/:id/steer`）

- 消息进入服务端里这个会话的队列。story runtime 在下一次调用模型之前，把队列里的内容并进实时的对话记录。
- 如果插话在最终回答的流式输出期间才到，story runtime 会在收尾之前多做一步模型调用来处理它（受 maxSteps 限制）。
- 插话跟着回合一起保存。回合提交时，它在同一个事务里写进对话历史（排在玩家这一回合的消息之后），也写进聊天记录，之后的回合能读到它。插话不算一个新的玩家回合。回合被停止、失败或回滚时，两边都不留它。
- 客户端自己在本地显示这条插话就行，没有新增的 SSE 事件。

**abort：玩家停止这一回合**（`POST /api/sessions/:id/abort`）

- 停止作用于玩家的这次动作请求，不只是当前的一个回合。请求还在等会话锁或等记忆更新时停止，回合不再开始，流里只有一个带 `abortReason` 的 `execution.completed`。
- 它触发回合级的取消信号。重试层立刻切断正在进行的模型调用和流。玩家停止不会自动重试，也不会把半截叙事当成结果提交。
- executor 停止调度后面的 runtime 组，并跳过事件链。
- 被中止的 runtime 以失败上报（`runtime.failed`），它的提案不产出。最终提交时会检查玩家的取消信号：提交之前收到取消，整个回合都不提交。
- 这一次的 `execution.completed` 带 `abortReason: "aborted-by-player"`（常量 `PLAYER_ABORT_REASON`，定义在 `@covel/shared`）。

客户端收到这个值时，把它当成玩家主动造成的结束，不是错误：

- 丢掉这一回合没有提交的流式占位消息。服务端从不提交半截叙事，留着它会在刷新后消失。
- 显示“已停止，本轮未提交”和一个明确的重试入口，不显示通用的错误提示。
- 其他的 `abortReason`（例如 TurnStart hook 中止了回合）仍然按错误显示。

### 会话生命周期事件

没有 `phase.changed` 事件。

会话进度的真实值是 `SessionRecord.phase`（`'setup' | 'playing'`）、`completedPlayerTurns` 和 `setupRuntimes`。`phase` 变化时不单独推送 SSE，客户端从会话的回答或快照里读这三个字段。

### 系统事件

| 事件类型         | 方向 | 描述     | 负载                           |
| ---------------- | ---- | -------- | ------------------------------ |
| `error.occurred` | S→C  | 执行错误 | `{ message, code?, details? }` |

- `code` 是可选的、稳定的错误码（如 `"session_busy"`）。客户端可以据此做翻译和重试。没有 `code` 时按 `message` 显示。动作开始前被拒绝的 code 见 [api.md § 流里的拒绝](./api.md#流里的拒绝)。
- `details` 只随 `code: "form_rejected"` 出现，见[交互响应](#交互响应)。

世界翻译接口使用另一种独立的 SSE 事件 `{ type: "error", message }`，没有 `code` 字段：

- 流打开之后不再改变 HTTP 状态。
- 未知的生产环境错误，消息固定为 `Internal server error`，和 JSON 接口的做法一样。
- 锁超时使用一句固定的、安全的“忙碌”提示。
- 原始的诊断信息只进服务端日志。

这不影响 action 流里 `error.occurred` 的结构。

### 世界事件

| 事件类型                   | 方向 | 描述                       | 负载                         |
| -------------------------- | ---- | -------------------------- | ---------------------------- |
| `world.dimensions.changed` | S→C  | 作者维度声明变更（热更新） | `{ worldId, changedKeys[] }` |

这是“世界包的声明改了”的通知，不是会话当前值的更新。客户端不能据此把当前进度换成新的 `initialValue`。已有的会话需要明确执行 sync 并检查冲突。

### 会话维度事件

| 事件类型                        | 方向 | 触发点                                         | 负载                                                                                      |
| ------------------------------- | ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `dimensions.changed`            | S→C  | 初始化或当前值/有效定义提交                    | `{providerPluginId, dimensions: DimensionSnapshot, settlement?}`                          |
| `dimensions.settlement.changed` | S→C  | 登记 pending、结算失败，或无数值变化的终态回执 | `{providerPluginId, source:{resultId,turnNumber}, sourceTurnId, version, status, error?}` |

**负载的细节**

- `dimensions.changed.dimensions` 只包含变了的公开条目。客户端按 ID 合并，不是整份替换。
- 每个条目是 `{name,description?,schema,value,version}`。
- 可选的 `settlement` 和第二个事件使用同样形状的摘要（属主在外层），其中的 `version` 是回执的版本。摘要不含冻结的 definitions / readVersions，也不重复传叙事正文。
- `status` 有五种：`pending-settlement` / `settled` / `no-change` / `manual` / `skipped`。

**什么时候发**

- 两个事件都在事务提交之后发出。回滚、版本冲突或只有元数据变化时，不会发出虚假的数值变化事件。
- 没有变化、`manual` / `skipped` 的无值修改，以及失败和 pending，通过回执事件单独可见。数值变化的事件可以同时带回执摘要。

> [!IMPORTANT]
> `execution.completed.committed: true` 可以表示“叙事和待结算的义务已经提交”，不等于维度已经结算。客户端必须检查回执。不能因为 runtime 成功了、工具成功了，或者没收到变化事件，就推断结果是 `no-change`。

**恢复和重连**

- 从会话视图读取 `dimensions`、`dimensionSettlements`、宿主绑定的 `dimensionProviderPluginId`，以及经过验证的 `dimensionRecovery:{editorRuntimeId,trackerRuntimeId}`。
- 公共读取在一次执行里是冻结的。回合结束，或者新的手动修改执行完成之后，才装载已提交的快照，不会退回到世界的初始值。
- pending 状态下保留最后可用的值，并阻止下一次叙事。恢复通过 [manual/runtime RPC](./api.md#维度编辑与待结算恢复) 进行，不引入新的 action 类型。

### 插件数据事件

| 事件类型              | 方向 | 描述               | 负载                                                            |
| --------------------- | ---- | ------------------ | --------------------------------------------------------------- |
| `plugin-data.changed` | S→C  | 插件持久化数据变更 | `{ pluginId, changes: [{ namespace, key, value, operation }] }` |

**谁会触发它**

- 所有写入路径都会触发：`plugin-data-set`、`plugin-data-set-batch`、DELETE `/plugin-data/...` 等。成功的 compare-and-set 写入也算（runtime job 的状态迁移、维度记录）。
- 它由 `wrapStoreWithPluginDataEvents` 在 store 层统一拦截，所以前端可以实时看到插件状态的变化。
- 后台任务的终态以 `job-status.updated` 为准。`_runtime_jobs` 行的变化只用于同步数据。

**负载**

- `operation` 是 `'set'` 或 `'delete'`。删除时 `value` 是 `null`。
- 负载只有 `pluginId` 和 `changes` 两个字段。事件不带写入的来源、runtime 或回合标识。
- 客户端把每条变化直接写进自己那份插件数据（`applyChanges`），不再回头去读接口。所以 `value` 带的是这一行完整的公开值。

**公开的范围**

事件和 REST 读取使用同一种公开形状：

- 隐藏的世界数据（`_hidden.*`）的变化不发出。
- `_runtime_jobs` 和维度记录只带公开的部分，不含任务的 `payload`、原始错误或维度规则。
- 以 `expectsBackgroundFollower` 排队的任务另外带 `phase: "prompt"`。

### 作业进度事件（job-status，实验性）

| 事件类型             | 方向 | 描述                     | 负载（完整 `JobStatusRecord`）                                                                                                                                                                            |
| -------------------- | ---- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-status.updated` | S→C  | 长任务作业进度（追加式） | `{ sessionId, progressScopeId, pluginId, runtimeId, jobId, state, progress?, message?, data?, sequence, createdAt }`；staged detached job 的 `data` 含 `{ originTurnId, durableStatus, reason?, error? }` |

**插件怎样上报进度**

耗时长的 function runtime（例如生成媒体）在收尾提交之前，可以调用：

```ts
ctx.progress.report({ jobId, state, progress?, message?, data?, sequence })
```

- 上报写进内核的 job-status 存储。它是追加式的，按 `(sessionId, progressScopeId, pluginId, runtimeId, jobId, sequence)` 去重。
- 写成功之后马上发出这个事件，并经 `/actions` SSE 转发。
- `state` 的取值：`queued | running | progress | waiting-input | succeeded | failed | cancelled`。
- 身份字段全部由内核填写，插件只提供作业的业务字段。

> [!NOTE]
> 这是“效果只在提交后生效”这条规则的**唯一实时例外**。进度上报不写游戏状态，不满足 binding 和 gate，也不随领域事务回滚。

**执行结束时的收尾**

执行结束之后，框架按最终保存的结果处理这次执行上报过的作业：

- 还没结束的作业，按 runtime 的结果换成终态。
- 插件已经上报了 `succeeded`，但这次的领域写入没有提交（整次执行回滚、这个 runtime 失败，或者它的写入在提交时被单独丢弃）：框架追加一条 `failed`，不保留成功状态。
- 插件自己上报的 `failed` / `cancelled` 不会被改写。
- 挂起的 runtime 的作业停在 `waiting-input`。它们记在挂起那次执行名下：恢复成功提交后换成 `succeeded`；挂起项被放弃、过期或作废时换成 `cancelled`；恢复失败、还能重试时继续等待。

**后台作业的状态对应**

staged detached worker 也用这个事件报告持久状态：

| 持久状态（`data.durableStatus`）              | 公开的 `state` |
| --------------------------------------------- | -------------- |
| `queued`                                      | `queued`       |
| `claimed` / `running`                         | `running`      |
| `committing`                                  | `progress`     |
| `succeeded`                                   | `succeeded`    |
| `cancelled`                                   | `cancelled`    |
| `failed` / `timed_out` / `stale` / `orphaned` | `failed`       |

`data.originTurnId` 让网页端把后台任务挂回产生它的那个回合，而不是后台执行自己的 `backgroundTurnId`。

**客户端合并的规则**

- 对同一个持久作业的控制事件，网页端比较 `sequence`。重复的或更旧的状态不会覆盖新状态。恢复时读到的终态，也不会被旧的排队公告撤销。
- 控制通道的 `progressScopeId` 和 `jobId` 都是这个持久作业的 ID。
- 插件的子进度通过 `data.runtimeJobId` 关联到父任务，但有自己独立的序号。它不能和父任务的序号比较，也不能撤销父任务的终态。
- 不同 `jobId` 的重试可以重新开始。
- 普通插件先报 succeeded、随后因为提交失败被改报 failed 的情况，按最后一个事件更新。
- 恢复时读到的持久记录没有控制序号，合并时保留已经看到的序号。
- 同一个作业的 `queued → claimed → running → committing` 不能倒退。恢复读取可以把阶段往前推，或者补上终态。恢复期间新收到控制事件时，最后的合并也按这些规则。
- 网页端用持久作业的 `backgroundTurnId`，把恢复出来的 worker 推理内容挂到它来源回合的任务上。worker 另有自己的 trace ID，这个 ID 不能产生另一个玩家可见的回合，也不能产生“任务中断”的提示。trace 和作业的恢复可以按任意顺序到达；状态和失败详情以持久作业为准；重复恢复时推理内容不会重复。

> [!NOTE]
> 这条通道和框架保留的 namespace `_runtime_jobs` 并存。manual / event 的 `execution: background` 和 staged 的 `turnCompletion: detached` 都记录在里面。`job-status.updated` 是它的实时显示和恢复手段，不能代替领域结果的事务。

### 后台任务（保留命名空间 `_runtime_jobs`）

所有后台 runtime 都以 `_runtime_jobs/<jobId>` 作为可靠的状态来源。一共三种来源：

| `origin.activation` | 来源                                                                             |
| ------------------- | -------------------------------------------------------------------------------- |
| `"stage"`           | `turnCompletion.mode: detached` 的调度作业                                       |
| `"manual"`          | plugin-rpc 的 `execution: background` 或 `expectsBackgroundFollower` 的手动激活  |
| `"event"`           | 事件链里 `execution: background` 的 follower，在触发它的那次执行的提交事务里排队 |

- 插件不能写这个命名空间。
- queued 记录和原始回合的 proposal、journal、会话时钟在同一个事务里保存。
- worker 通过 `compareAndSetPluginData` 领取作业并续租，防止多个 Pod 重复执行，也防止迟到的结果把作业“复活”。

| durable status        | 语义                                                                                                                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`              | 已随原始回合提交，等待 worker；超过 `maxQueueMs` 转 `timed_out`                                                                                                                                                         |
| `claimed` / `running` | worker 已取得 CAS lease / 正在执行；同一 session/plugin/runtime 保持串行                                                                                                                                                |
| `committing`          | 已通过 owner CAS，正在 session lock 内做 stale/effect guard 和领域提交                                                                                                                                                  |
| `succeeded`           | 后台 proposal 已提交，`result` 保存 background turn/execution/runtime 摘要                                                                                                                                              |
| `failed`              | 执行、effect guard 或领域提交失败；`reason/error` 为权威原因。手动/事件激活中 runtime 自报失败（`runtime-reported-failure`）或未发出预期 follower（`follower-not-emitted`）时，该执行的领域写入与失败终态在同一事务提交 |
| `timed_out`           | 排队超过 `maxQueueMs`，或 runtime 执行超过 `maxExecutionMs`（执行返回后等待 session lock 提交的时间不计入）；迟到执行不能再进入 committing                                                                              |
| `cancelled`           | 控制面取消终态；不能转回 active 或接受迟到结果                                                                                                                                                                          |
| `stale`               | session inactive、session/plugin incarnation 或版本已变化；提交屏障以 `reason: commit-barrier-rejected` 拒绝结果                                                                                                        |
| `orphaned`            | 在途 owner 停止续租且 lease 过期；owner 自己连续续租失败直到 lease 过期时，会立即中止正在进行的执行并落此状态                                                                                                           |

**启动时的恢复**

- 还没过排队期限、并且从来没被领取过的 `queued` 作业，继续执行。
- 排队超时的，结束为 `timed_out`。
- 租约已经过期的 `claimed` / `running` / `committing` 作业，结束为 `orphaned`。
- 这些终态**不会自动重放**。原因：服务商可能已经计费，只是回答没保存下来；重放会重复扣费。

**提交之前的检查**

- 重新确认：会话仍然 active，会话的代次、插件的授权范围和版本都没有变。
- 用清单里隔离的 effects 白名单检查实际的 proposal。
- 领域结果和 `succeeded/result` 在同一个事务里保存。事务回滚不会留下一个“成功”的任务。
- 事务之后的通知失败，不改变任务的成功状态，也不会开放重试。

**保留和维护**

- 每个会话的每个 runtime 只保留最近 20 条终态作业。worker 在对账时删除更早的记录。
- 作业描述里，只为这个 runtime 声明依赖的上游保留完整输出。其他上游只保留身份和状态，并且不复制工具调用记录。
- `_runtime_jobs` 不进入快照和 fork 的内容，写入由框架控制。现有插件 store 对保留 namespace 的读取规则仍然适用。
- 恢复扫描只处理“扫描期间 revision 没变”的过期租约。
- worker 第一次唤醒时，以及之后每 30 秒的维护里，恢复过期的任务；失败之后 1 秒重试。
- `committing` 的作业要先取得非阻塞的会话提交锁。锁忙就推迟。
- 维护不占用执行的容量。关闭时等待实际的扫描和锁回调退出。

> [!NOTE]
> 以后扩展状态，或者增加 overlap / stalePolicy 时，必须同时升级 schema version、合法的状态迁移图、SSE 的状态对应和客户端的恢复逻辑。目前没有“用旧值表达新策略”的兼容做法。

**读取时去掉了什么**

后台任务的 HTTP 读取出口共用一种公开形状。这些出口是：专用的 runtime-jobs 接口、通用的 plugin-data（全量 / 按 namespace / 按 key），以及 state。

- 去掉：冻结的输入 `payload` 和原始错误。
- 保留：作业、来源和后台执行的关联 ID，当前状态，业务结果。
- `job-status.updated` 同样只发送已知的 reason，以及按状态分类的固定安全错误文字。服务商或 handler 的异常原文不会透出去。
- 只有 reason 的排队超时，在页面重新加载之后也保留看得懂的失败说明。

这只是 HTTP 和 SSE 这两个出口的规则。内部任务错误、普通游戏结果、插件直接读取，以及其他 trace 和日志通道各有各的约定。它不等于对所有日志或游戏内容做了脱敏。

**客户端可以做的操作**

| 操作 | 接口                                 | 规则                                                                                                                                                         |
| ---- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 恢复 | `GET /api/sessions/:id/runtime-jobs` | 返回状态和成功的结果。回答里去掉了包含冻结输入、设置和审批身份的内部 `payload`                                                                               |
| 取消 | `POST .../:jobId/cancel`             | 只接受 `queued` / `claimed` / `running`，用 CAS 写入 `cancelled`。已经进入 `committing` 或终态的作业返回冲突                                                 |
| 重试 | `POST .../:jobId/retry`              | 只接受失败类的终态。明确创建新的 `jobId` 和 queued 记录，使用当前会话的代次、授权范围、locale 和 runtime model overrides。旧的终态不变，也不会被后台自动重放 |

detached runtime 内部通过 `ctx.progress` 发出的插件子任务消息，由内核在 `data` 里追加无法伪造的 `runtimeJobId` 和 `originTurnId`。客户端据此把它折叠到父任务下面，不会多出一行孤立的状态。

### 媒体资产事件

图像生成插件完成时，用 `assetGenerations[]` 输出结果。runtime 把每一项转成 `asset.generate` proposal，提交之后写进 trace 和 SSE。

```ts
type AssetGeneration = {
  ref: MediaRef;
  modality: string; // e.g. "image", "audio", "video", "file"
  meta?: Record<string, unknown>;
};
```

生成过程中的进度用另一个事件 `asset.progress`。function runtime 调用：

```ts
ctx.assetProgress({ phase, percent, assetId, modality, message, meta });
```

服务端把它写进 trace，并经 `/actions` SSE 转发。`percent` 的范围是 `0..100`。最终要保存的资产仍然通过 `assetGenerations[]` 走 `asset.generate` 的提交路径。

| 事件类型          | 方向 | 描述                                   | 负载                                                                                     |
| ----------------- | ---- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `asset.progress`  | S→C  | 多模态生成进度                         | `{ runtimeId, pluginId, turnId, assetId?, phase, percent?, modality?, message?, meta? }` |
| `asset.generated` | S→C  | 资产完成并通过 `asset.generate` commit | `{ proposalId, runtimeId, pluginId, asset: AssetGenerateView }`                          |

**规则**

- `ref` 必须来自 `ctx.media.put()` 或 `ctx.media.ingestUrl()`。
- provider 的 wire 层可能短暂地拿到 `b64_json`、远程的临时 URL 或 SDK 的字节结果。handler 要在返回之前把它们存进 MediaStore，之后只通过 `assetGenerations[]` 和业务索引记录对外给出 `MediaRef`。
- 图像画廊类的插件仍然可以用 `plugin_data.images` 保存查询用的索引，索引值形如 `{ status, ref, prompt, ... }`。`Image` / `Media` 组件接收 `MediaRef`，由框架解析成显示用的 URL。

**两种错误**

| 错误码                                    | 什么时候出现                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `image.generate.asset_missing`            | 由启用的 `media.image-flow@1` 扩展声明的 asset runtime，完成时没有 `assetGenerations[]` |
| `image.generate.plugin_data_inline_media` | `plugin_data.images` 里出现了 `url` / `base64` / `dataUrl` 字段                         |

框架不会从这些内联字段合成 `asset.generated` 事件。

### LLM content parts

`@covel/ai-provider` 的 `TextMessage.content` 有三种形态：

| 形态            | 用途                                                                               | 生命周期 |
| --------------- | ---------------------------------------------------------------------------------- | -------- |
| `string`        | 纯文本消息快路径                                                                   | 长期保留 |
| `null`          | assistant tool-call 等 provider 允许空内容的消息                                   | 长期保留 |
| `ContentPart[]` | 多模态消息路径：`{ type: "text", text }` 与 `{ type: "image", image, mediaType? }` | 长期保留 |

**图片 part**

它的形状和 Vercel AI SDK 的同名 part 一致：

- `image` 是一个字符串，可以是纯 base64、`data:` URL 或 `http(s)` URL。
- `mediaType` 是 MIME 类型。纯 base64 没写它时，按文件头识别（PNG、JPEG、GIF、WebP）；识别不出来按 `image/png`。
- provider 层只负责把收到的内容编码成各家的格式。它不下载，也不读 MediaStore。
- 框架自己发图片时（见 [Prompt 结构参考：展示过的图片](./prompt-structure.md#展示过的图片)），由 runtime 从 MediaStore 读出字节，以纯 base64 加 `mediaType` 传入。在这之前，内核内部使用 `{ type: "media", ref: MediaRef }`，这种 part 不会到达 provider 层。

**各协议怎样发图片**

| Provider 路径                     | 内联数据（base64 / data URL）                                       | `http(s)` URL                                                                                    |
| --------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| OpenAI Chat                       | `{ type: "image_url", image_url: { url: "data:<mime>;base64,…" } }` | 同一形状，`url` 为原 URL                                                                         |
| OpenAI Responses                  | `{ type: "input_image", image_url: "data:<mime>;base64,…" }`        | 同一形状，`image_url` 为原 URL                                                                   |
| Anthropic Messages                | `{ type: "image", source: { type: "base64", media_type, data } }`   | `{ type: "image", source: { type: "url", url } }`                                                |
| Gemini native                     | `{ inlineData: { mimeType, data } }`                                | 仅已上传的 Google 文件 URI，转为 `fileData`（需要 `mediaType`）；其他 URL 以 `CONFIG_ERROR` 拒绝 |
| Gemini OpenAI-compatible endpoint | 跟随 OpenAI Chat 形状                                               | 跟随 OpenAI Chat 形状                                                                            |

[Google 原生图片输入说明](https://ai.google.dev/gemini-api/docs/image-understanding)区分内联数据和文件引用。

**模型不接受图片时**

- 目标模型已知只接受文本时（模型表或 `llm.toml` 的 `input` 里没有 `image`），请求里的图片 part 在编码之前被去掉。一条只有图片的消息换成文本 `[image]`。
- 能力未知的模型不做处理，由服务商决定接不接受。
- 回退时有一条例外：用途的首选模型已知接受图片（调用方因此才附了图），而这次调用回退到了另一个模型。这时后者只有在已知接受图片时才收到图片。能力未知的回退模型也只收到文本。
- 判断回退模型能不能装下请求时，一张图片按 1,600 token 算，不按它的 base64 长度算。
- 记录到 trace 的请求体里，超过 4,096 个字符的内联图片数据换成一句长度说明，这个请求的 `complete` 是 `false`。

### Gemini 原生文本协议

`google-generative-ai-v1` 调用 Google 的 `generateContent` / `streamGenerateContent`。

**支持的**

- 文本、结构化对象和流式文本生成。
- 发送图片输入和函数声明。
- `google` 服务商的内置地址是 `https://generativelanguage.googleapis.com/v1beta`，密钥取 `GOOGLE_API_KEY`。设置界面里可以选“Google Gemini”协议。
- `generateObject` 使用 `generationConfig.responseMimeType: "application/json"` 和 `generationConfig.responseJsonSchema`。返回之后仍然由 Covel 的 Zod schema 校验。

**用量的算法**

- 模型 `usage` 里的思考 token 计入输出 token。
- 报告的缓存 token 是输入 token 的一部分，不能和总输入再加一次。

**没有实现的**

Google 的 embedding、原生图片或音频生成、File API 上传，以及 grounding 工具。模型目录声称支持这些能力，也不会让文本适配器自动获得对应的 wire。

Gemini 原生的思考强度、`providerOptions.google.thinkingConfig`、`cachedContent`、`seed`，以及它和 OpenAI 兼容接口的差别，见[模型用途配置](./slots.md#思考强度)和 [Google thinking 文档](https://ai.google.dev/gemini-api/docs/generate-content/thinking)。

### Suspend / Resume 事件

| 事件类型         | 方向 | 描述                                                                                                                          | 负载                                                        |
| ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `turn.suspended` | S→C  | runtime 创建 suspension artifact；`finalizeExecution` 将记录与同一 execution 的写入提交成功后才发出。回滚不保留记录也不发事件 | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed`   | S→C  | suspension 资源的 `resume` 动作成功后由路由发出                                                                               | `{ sessionId, turnId, suspensionId }`                       |

### Snapshot / Fork 事件

所有 snapshot 事件由服务端通过 eventBus 广播（topic 是 `session`）。SSE 的命名事件名取自 payload 的 `_subType`。

| 事件类型                 | 方向 | 描述                                                                                                                                | 负载                                                                            |
| ------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `state.snapshot.created` | S→C  | 新 snapshot 已写入。由 turn-executor（auto）和 snapshots 路由（manual / fork）发出                                                  | `{ turnId, snapshotId, kind: 'auto' \| 'manual' \| 'fork', parentSnapshotId? }` |
| `session.forked`         | S→C  | `POST /api/sessions/:id/fork` 成功物化子 session 后由 snapshots 路由发出。fork 同时发出一条 `state.snapshot.created`（kind='fork'） | `{ parentSessionId, childSessionId, fromSnapshotId, forkSnapshotId }`           |

发射点对照：

| 触发路径                           | 事件序列                                                | 来源                                              |
| ---------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `commitExecution` 提交后捕获       | `state.snapshot.created` (kind=auto)                    | `packages/runtime/src/commit/commit-execution.ts` |
| `POST /api/sessions/:id/snapshots` | `state.snapshot.created` (kind=manual)                  | `apps/server/src/routes/api/snapshots.ts`         |
| `POST /api/sessions/:id/fork`      | `state.snapshot.created` (kind=fork) → `session.forked` | `apps/server/src/routes/api/snapshots.ts`         |

> [!NOTE]
> 内置网页端目前没有 snapshot / fork 的操作界面。外部客户端可以从 `session` topic 接收上面的事件。

**已提交的交互也走订阅通道**

已提交的 `interaction.requested` 和 `ui.rendered` 同时通过 `state` topic 推送，带 `block` 和 `turnId`。这样手动 runtime 或后台 runtime 生成的交互，不用刷新就能显示。

- 整个执行事务成功之后才发布，回滚不发布。
- 客户端按 `block.id` 合并，避免 action SSE 和订阅（或事件重放）产生重复的消息。
- 断线之后，仍然以会话视图为准来恢复。

### 世界模型、插件记忆与上下文压缩事件

- `character-schema.changed` 在 `character.schema.set` 提交之后发出，payload 是 `{schema: CharacterSchemaRecord}`。
- `character.upserted` 带 `{character}`。
- 客户端按领域记录更新角色和字段定义，不去读某个插件的数据镜像。

**插件记忆**

- 插件记忆和其他插件数据一样，提交之后发出 `plugin-data.changed`，更新哪些内容由所属插件的 namespace 决定。没有专门的“工作记忆变更”事件。
- detached 提取的失败和完成状态，通过通用的 job 和执行记录恢复。
- 后面的执行在 `before-next-execution` 屏障之后读取已提交的快照。

**只进 trace 的事件**

- `context.compacted` 只写进 `trace_events`，由历史压缩的编排写入，不在 `CovelEvent` 里。摘要策略通过 `history.compact@2` 扩展提供。
- `recursive.calling/completed/failed` 在 `CovelEvent` 里，但只通过订阅 topic `trace` 下发，不转发到 `/api/actions`。

| 事件                            | 触发点                | payload                                                                                                                                 |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `character-schema.changed`      | domain schema 提交    | `{schema}`                                                                                                                              |
| `character.upserted`            | domain character 提交 | `{character}`                                                                                                                           |
| `dimensions.changed`            | dimension batch 提交  | `{providerPluginId, dimensions, settlement?}`                                                                                           |
| `dimensions.settlement.changed` | 回执提交              | `{providerPluginId, source, sourceTurnId, version, status, error?}`                                                                     |
| `plugin-data.changed`           | 所属插件数据提交      | pluginId、namespace 和受影响 key                                                                                                        |
| `proposal.failed`               | proposal 提交失败     | `{proposalId,proposalType,runtimeId,pluginId,error}`                                                                                    |
| `context.compacted`             | 压缩摘要保存          | `{summaryId,summaryIds,messagesCompacted,tokenSavings,focusSections,summariesMerged,summaryTokens,totalSummaryTokens,summaryTruncated}` |

提交失败会扣住“执行完成”这一步，客户端把错误显示成执行失败。后台的结果不能重新打开已经结束的 action 流，重连时用保存下来的会话状态恢复。

### SSE 帧格式按通道区分

| 通道                     | 帧形态                                                      | 客户端订阅方式                                                                                                                         | 文件                                               |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/actions`      | data-only（`data: <SseEnvelope JSON>`，**无 `event:` 头**） | `fetch()` + `ReadableStream`，按行扫 `data:` 解 JSON 后看 `envelope.type`                                                              | `apps/web/src/services/api/actions.ts: sendAction` |
| `GET /api/events/stream` | 命名事件（`event: <type>\ndata: <ProtocolEvent JSON>`）     | `fetch` 读流（`readSseStream`），按 `event:` 头分发 —— 没有处理器的事件被静默丢弃；不能设请求头的客户端才用 `EventSource` + 查询串令牌 | `apps/web/src/services/subscription.ts`            |

**订阅流的连接过程**

1. 连接建立时，先发一条 `system.connected`。
2. 之后每 30 秒发一条 `system.heartbeat`。
3. 重连游标可通过 `lastEventId` 查询参数或标准 `Last-Event-ID` 请求头传入；两者都有时，查询参数优先。游标的 epoch 仍有效时，先补发 EventBus 缓存里序号大于游标 seq 的事件，再切换到实时事件；无法补齐时发送 `system.reset`。

`system.connected` 的 data 里有 `cursor`：这一刻这个会话已经发出的最新事件 id（`${epoch}:${seq}`，还没发过事件时 seq 是 0）。

- 还没有游标的客户端把它记成 `lastEventId`。这样即使这条连接上一个事件都没收到，下次连接（例如一次 action 结束之后恢复订阅）也能补上这期间错过的事件。
- 已经有游标的客户端忽略它。

**订阅哪些 topic**

- `/api/events/stream` 接受的 topic 由 `@covel/shared` 的 `SUBSCRIPTION_TOPICS` 定义：`runtime / state / game / plugin / session / store / system / trace / hooks / job`。`subscribe.ts` 的 `VALID_TOPICS` 从它生成。
- `trace`（来自 TurnEmitter）和 `hooks`（来自 hook 管线）是运行时内部的观测 topic。`job` 承载 `job-status.updated`。
- `apps/web/src/services/subscription.ts` 默认订阅 `runtime / state / game / plugin / session / system`，不含 `store`。session store 为了恢复后台任务，另外明确订阅 `job`。
- 客户端按 `event.topic` 分发。新增 topic 或事件时，**必须同时更新这个文件**。
- `/api/actions` 的回合内事件（`narrative.delta` / `narrative.completed` / `interaction.requested` / `plugin-data.changed` 等）由 `sendAction` 的回调处理，不经过 `subscription.ts`。

**鉴权**

- `DEPLOYMENT_TIER=demo|commercial` 时，订阅接口强制要求会话归属者令牌。
- `self`（默认）通常不强制。但 `NODE_ENV=production`、并且实际使用的存储后端是 MemoryStore 时同样强制。判断依据是真正注入的后端，不只是 `STORE_BACKEND` 环境变量的值。
- 内置网页端用基于 fetch 的 SSE，并提交 `X-Session-Token`。原生 `EventSource` 客户端可以用 `?session_token=<ownerToken>`。
- 缺少或错误时返回 `401 { code: "session_owner_required" }`。

详见 [api.md](./api.md) 的鉴权章节。

**连接和写入的限制**

`/api/actions` 和 `/api/events/stream` 的每条连接都有一条有上限的、按顺序写的队列：

| 限制                                       | 值                           |
| ------------------------------------------ | ---------------------------- |
| 队列里“正在写 + 等待写”的帧数              | 最多 256，只有一个实际的写者 |
| 单次写入、收尾时排空队列、关闭，各自最多等 | 2 秒                         |
| 每个会话的订阅连接数                       | 8                            |
| 整个进程的订阅连接数                       | 512，超过返回 429            |

- 队列溢出、写入出错或超过期限之后：不再接收新的帧，丢掉还没开始的写入，并中止连接。不会在一次写入卡住之后另起一个替身。
- 订阅流的 connected、补发、reset 和 heartbeat 帧也受同样的限制。
- 监听器、pin、heartbeat 和连接额度在清理时释放。

**action 流和业务执行互不拖累**

- action 流里每一帧的 seq、回合和 trace 身份、负载，都在入队那一刻定下来。已接受的帧按队列顺序写出。
- 业务锁里的执行和提交回调只负责入队，不等客户端读完。最后的排空发生在业务所有权之外。
- SSE 关闭或丢失不算业务执行失败：不会撤销已经提交的内容，不会重复调用模型，也不会开放恢复重放。客户端应该通过只读的 execution / session 状态来恢复。

**断流之后的恢复（网页端）**

- 网页端收到 reset 或重连之后，带着 revision 检查重新拉取：会话快照、插件列表、所有启用插件的数据、没解决的 suspension 和世界。这期间到达的实时事件先缓冲，之后再重放。
- 只有访问代次和执行所有权仍然对得上时，才用同一个 `turnId/runtimeId` 的已保存终态叙事替换流式占位，并移除这个占位的外部文本和待刷新的片段。一条新的、健康的 POST 流仍然拥有自己现场的输出。
- 出错或断流后，只有恢复确认回合失败或中断、且没有对应的已保存故事时，才把已显示的文字移到“未保存”区域，清除占位和流式缓存。文字只保留到离开会话，不进入故事历史、舞台或插件数据；有可恢复动作时，旁边提供重试。未知网络状态不开放重试，已保存故事仍按上面的规则替换。玩家主动中止和正常 `committed: false` 的撤回规则不变。
- 恢复快照的最近窗口如果和已加载的历史接不上，客户端先通过现有的消息分页接口只读地补到旧的锚点，再合并发布。它不删除旧窗口，也不重新发送动作。

**给嵌入 `@covel/events` 的宿主**

`createEventBus(store?, options?)` 只需要一个可选的 `EventStore`。它有两个异步方法：`saveEvent(record)`，以及按会话隔离的 `getEventById(sessionId, id)`。

- 记录类型 `EventStoreRecord` 随包导出。现有的 DataStore 可以直接传入；独立的宿主不用实现其他数据库方法。
- 持久化是一条有上限的、尽力而为的审计队列。`flush()` 等队列排空，但不保证 transport 已经送达。
- 特别大的 transport 帧，在保存成功之后只发送一个引用，接收方通过同一个存储读出内容。

#### 事件 id 形态：`${epoch}:${seq}`（H-05/H-06）

每条订阅事件的 `id` 是 `${epoch}:${seq}`。它同时是 SSE 的 `id:` 行，也是重连时的 `lastEventId` 游标。

- `seq`：每个会话里单调递增的序号。
- `epoch`：服务端这个会话的“补发状态”**每次（重新）创建**时生成的一个字符串。进程重启、被 LRU/TTL 清掉之后重建，都会换一个新的 epoch。客户端只比较它**相不相等**，不解析它的内容。epoch 变了，就表示游标已经失效，需要重置。

解析用 `@covel/shared` 的 `parseSubscriptionEventId(id) → { epoch, seq } | undefined`。纯数字的 id 解析为 `undefined`，服务端一律用 `system.reset` 回答。

**pin 和容量**

- 订阅还连着时，这个会话的补发状态被“钉住”（pin），不会被清掉，也不会换 epoch。
- EventBus 的 `MAX_TRACKED_SESSIONS`（当前是 256）是可以被清掉的补发状态的目标容量，不是活跃订阅的硬上限。
- pin 在容量清理之前登记。当所有状态都有活跃的 pin 时，允许暂时超过这个目标，包括第 257 个不同的会话。
- 最后一个 pin 释放之后，这个状态重新可以被 LRU/TTL 清掉。之后的访问或容量压力会触发清理；释放本身不会马上清掉它。
- 连接数量仍然由上面的 SSE 额度限制。

#### `system.reset` 控制帧（H-05）

带 `lastEventId` 重连时，如果服务端没法从这个游标接上，它**不会只补一部分**，而是发一条**不带 `id:` 头**的 `system.reset` 命名事件。客户端收到之后要做两件事，再继续接收实时事件：

1. 把本地游标（`lastEventId`）换成帧里的 `cursor`。
2. 重新拉取权威状态。

```
event: system.reset
data: {
  "sessionId": "<sessionId>",
  "reason": "gap" | "epoch-change" | "transport-gap" | "publish-failed",
  "epoch": "<current server epoch>",
  "oldestSeq": <number>,   // oldest seq still in the buffer (0 when none)
  "latestSeq": <number>,   // newest seq emitted in this epoch (0 when none)
  "cursor": "<epoch>:<latestSeq>",  // the cursor the client adopts
  "timestamp": "<ISO8601>"
}
```

触发条件：

| `reason`           | 什么时候发生                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `"epoch-change"`   | 游标的 epoch 和当前的不一样。包括状态被清掉或进程重启之后换了 epoch，也包括无法解析的旧格式游标                        |
| `"gap"`            | epoch 一样，但环形缓存已经越过了游标（`afterSeq` 早于 `oldestSeq`），或者游标的 seq 比 `latestSeq` 还大                |
| `"transport-gap"`  | 跨 pod 的 transport 发现序号真的缺了一段，或者已经收到的大事件引用没法还原（记录不存在、读取失败，或接收端没有 store） |
| `"publish-failed"` | 提交方已经把数据保存了，但提交之后的事件发布失败                                                                       |

`transport-gap` 的细节：

- 每个 `(origin, session, stream)` 从 `seq=1` 开始校验。新 stream 的第一帧大于 `1`，或者接收状态被淘汰之后第一帧大于 `1`，都会按缺口处理。
- 出问题的那一帧之前的事件交付完、之后的事件交付之前，本地的补发缓存被清空并换 epoch。所有已连接的客户端收到 reset 之后断线重连。
- 接收端给每个 `(origin, session)` 只留当前 stream 的状态。发送方换了 stream，旧 stream 的状态就收回；旧 stream 还有等着前一帧的事件时，先交付它们并 reset。
- 接收状态最多 1024 个，满了先淘汰最久没收到帧、也没有等待中事件的状态。都在等待时，淘汰最久没收到帧的那个，先交付它等着的事件并 reset。
- 发送方每个会话最多有 256 帧等着发出。transport 一直不返回、超过这个数时，新帧直接丢掉并告警。接收方等到之后的帧时会发现缺了一段，按缺口 reset。

`publish-failed` 的细节：

- `finalizeExecution` 和会话提交管线在事务提交之后，逐个执行缓冲着的发布。发布失败不回滚数据。
- 服务端写入 trace 事件 `commit.fanout.failed`（`{ failedCount, totalCount, errors }`，`forwardToActionStream: false`，在 `/debug` 里可以看到）。
- 随后清空这个会话的补发状态并换 epoch。已连接的订阅流收到 reset 之后重连，并完整地重新读取。
- 触发这一回合的 `POST /api/actions` 流照常以 `execution.completed` 收尾，并带 `resync: true`。

这一帧和 `system.connected` / `system.heartbeat` 一样**不带 `id:` 头**，所以它不会改掉 `EventSource` 的 `lastEventId`。

### 转发的运行时内部事件（`/api/actions` 转发，已纳入 `CovelEvent`）

下面这些事件由服务端通过 actions SSE 流转发，用于调试和 trace。

- 它们是 `CovelEvent` 的成员，在 `COVEL_EVENT_META` 里标记 `forwardToActionStream: true`。
- 服务端的转发白名单 `FORWARDED_EVENT_TYPES` 完全从这份元数据**生成**，不是手写的集合。
- 网页端的 actions 处理器对这些类型明确地什么都不做，它们通过订阅通道驱动 `/debug` 的时间线。因为它们在联合类型里，新增同类事件时，前端的穷尽检查会强制你决定“处理还是忽略”。

| 事件                                                       | 来源                                                                                          | 用途                                                                                                                   |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `runtime.skipped`                                          | `apps/server/src/routes/api/actions.ts`                                                       | runtime 因 cooldown / startTurn / maxTriggerCount 被跳过                                                               |
| `character.upserted`                                       | `packages/runtime/src/commit/session-commit-emitter.ts`（`character.upsert` proposal commit） | 角色快照事件                                                                                                           |
| `tool.calling` / `tool.completed` / `tool.failed`          | TurnEmitter                                                                                   | LLM 工具调用 trace                                                                                                     |
| `domain-event.previewed`                                   | ToolExecutor（`emittedEvents` 成功后）                                                        | 服务端投影成 UI slot 预览；前端不直接消费，不代表领域提交                                  |
| `llm.calling` / `llm.responded` / `message.completed`      | TurnEmitter                                                                                   | LLM 调用 trace                                                                                                         |
| `block.emitted` / `state.patch.applied`                    | TurnEmitter                                                                                   | 块发出 / state patch 应用 trace                                                                                        |
| `hook.fired` / `hook.aborted`                              | TurnEmitter                                                                                   | Hook 行为 trace                                                                                                        |
| `gateway.calling` / `gateway.responded` / `gateway.failed` | TurnEmitter（`withGatewayTrace`）                                                             | function-runtime 和扩展点提供方的 `ctx.gateway` provider 调用 trace（与 `llm.*` 对等）；失败时带服务商已报告的 `usage` |

`runtime.skipped` 是 actions 路由自己写进流里的，它在元数据里的 `forwardToActionStream` 是 `false`。

本页其他小节里讲到的这些事件，同样标记为转发：`ui.rendered`、`asset.progress`、`world.dimensions.changed`、`plugin-data.changed`、`character-schema.changed`、`dimensions.changed`、`dimensions.settlement.changed`、`ui.slot.changed` / `ui.slot.preview` / `ui.slot.cleared`、`turn.suspended` / `turn.resumed`、`job-status.updated`。

**不转发到 `/api/actions` 的内部事件**

它们只写进 `trace_events`，并通过订阅通道下发，用来驱动 `/debug`：

| 事件                                                                   | 说明                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook.rewrote`                                                         | Hook 改写了内容                                                                                                                                                                                                                                                                           |
| `function.executing` / `function.completed`                            | function-runtime 的 handler 开始和结束（TurnEmitter），和 `recursive.*` 同类                                                                                                                                                                                                              |
| `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` | 插件自带 wire 的 provider HTTP 调用（`ctx.utils.fetchWithRetry`，图像生成插件走的路径；由 `withUtilsTrace` 在 function-runtime / agent-guard 注入的地方包起来）。轮询可能很频繁，所以不进 action 流。负载只有 host / method / status / durationMs，**绝不包含完整 URL、query 或 api key** |
| `context.pruned`                                                       | 提示词第一次组装、`PostContextAssembly` 改写之后，或者工具循环某一步的实际请求触发了预算的硬裁剪时发出。负载是 `{ runtimeId, pluginId, prunedMessageCount }`。同一个 runtime 一回合里可能出现多次。它让 `/debug` 能说明“哪一步丢了历史”                                                   |
| `context.compaction.failed`                                            | 历史压缩尝试失败时发出，负载是 `{ pluginId, extensionId, reason, consecutiveFailures }`                                                                                                                                                                                                   |
| `commit.fanout.failed`                                                 | 见上文“`system.reset` 控制帧”一节                                                                                                                                                                                                                                                         |

补充：

- 历史压缩连续失败每满 3 次，同一回合另外发一条 `job-status.updated`（`state: "failed"`，`message` 是按会话语言写给玩家的说明），借用执行时间线对失败任务的显示方式。
- 如果受保护的尾部、压缩摘要、工具 schema 和回答 schema 本身就已经装不进预算，runtime 会在调用 provider 之前明确失败。

**隐藏内容的 runtime**

声明了 `io.concealed: true` 的 runtime，它的 TurnEmitter 事件在保存和转发之前，只保留不含内容的字段，并带 `concealed: true`：

- 保留：`runtimeId`、`pluginId`、`toolName`、`toolCallId`、`status`、`durationMs`、`usage`、`finishReason`、`seq` 等。
- 移除：`messages`、`text`、`toolCalls`、`arguments`、`result`、`parsedResult`、`output` 等内容字段。

## 二、命令类型（CommandType）

下面各表的“命令”一列（`session.create`、`turn.submit` 等）只是这份文档里给请求起的名字，方便称呼。代码里没有叫这些名字的标识符，也没有 `CommandType` 这个类型；请求由“方法 + 端点”和 `type` 字段决定。

### 会话管理

| 命令              | 方法   | 端点                     | 响应                    |
| ----------------- | ------ | ------------------------ | ----------------------- |
| `session.create`  | POST   | `/api/sessions`          | JSON: `SessionRecord`   |
| `session.restore` | GET    | `/api/sessions/:id/view` | JSON: `SessionSnapshot` |
| `session.delete`  | DELETE | `/api/sessions/:id`      | JSON: `{ deleted }`     |

`SessionSnapshot` 顶层的 `dimensions` 是[当前值的公开快照](./world-model.md#动态维度快照)。可选的 `dimensionSettlements` 是回执摘要。provider 和 recovery 的元数据由宿主绑定并校验。

> [!WARNING]
> 不兼容旧的 raw dimension 格式。受影响的开发期世界、会话和快照需要重建。

### 回合执行（SSE 流式响应）

`/api/actions` 接受的 `type` 是一个封闭的集合，由 `packages/shared/src/schemas/api-contract.ts` 的 `actionRequestSchema` 定义（服务端通过 `validateActionRequest` 校验）：

| 命令             | 方法 | 端点                                           | 响应                  |
| ---------------- | ---- | ---------------------------------------------- | --------------------- |
| `turn.submit`    | POST | `/api/actions` `type: "send_message"`          | SSE: ProtocolEvent 流 |
| `turn.cmd`       | POST | `/api/actions` `type: "execute_command"`       | SSE: ProtocolEvent 流 |
| `turn.start`     | POST | `/api/actions` `type: "start_session"`         | SSE: ProtocolEvent 流 |
| `turn.retry`     | POST | `/api/actions` `type: "retry_turn"`            | SSE: ProtocolEvent 流 |
| `runtime.retry`  | POST | `/api/actions` `type: "retry_runtime"`         | SSE: ProtocolEvent 流 |
| `runtimes.retry` | POST | `/api/actions` `type: "retry_failed_runtimes"` | SSE: ProtocolEvent 流 |

加上[交互响应](#交互响应)里的 `submit_interaction`，一共七种。其他取值一律返回 400 `Unsupported action type`。插件要发事件，请用内置的 `emit-event` 工具。

流里的每一帧外层是 `SseEnvelope`，见下文“四、SSE 信封格式”。

**`start_session`**

要求会话已经带有非空的 `activePlugins`（创建会话时选定）。空集合直接返回 400，不会变成“启用所有已注册的插件”。详见 [api.md](./api.md#post-apiactions)。

**`retry_turn`**

- 普通请求的 payload 是空的。它用空的玩家输入和当前已提交的上下文，启动一个新的主循环回合。提交成功之后，玩家回合数加一。
- 它不恢复、也不重新生成历史回合。

**恢复没有完成的回合**

- 上表的六种动作都可以附加 `payload.recoverFromTurnId`，并且必须和服务端返回的原 action 描述一致。
- 客户端从 `GET /api/sessions/:id/execution` 读取只读的状态。刷新页面不会重新提交动作。玩家明确点了恢复重试之后，才用新的 requestId 发送。
- 恢复轮询在成功时每 3 秒检查一次；失败后等待 3、6、12、24 秒，之后最多每 30 秒一次，成功后复位。状态请求不叠加 HTTP 重试；页面隐藏时暂停，重新显示时立即检查，同一观察不会并发轮询。
- 服务端在会话锁里校验来源回合。开场恢复保留 continuation 的来源，不增加玩家回合数。
- 执行状态查询在发送回答之前，会复核通过鉴权的会话代次。查询期间会话被删除，或者用同一个 ID 重建了，返回 `409 session_incarnation_changed`，而不是新会话的 `retry` 输入。这个只读的检查不等待正在运行的长回合，也不自动重新提交动作。

**`retry_runtime`**

- 必须提供 `payload.runtimeId`。
- 明确给出的 `retryFromTurnId` 必须指向一个已提交、并且仍然属于当前故事的原回合，而且目标仍然处于失败状态。
- 不带来源时，按普通的 manual 调用处理。

**`retry_failed_runtimes`**

- 必须提供原回合的 `retryFromTurnId`，以及 1–20 个不重复的 `runtimeIds`。
- 在锁里合并这个来源已提交的恢复尝试之后，只有仍然失败、并且 active 的目标可以重跑。
- 同一个 action 按 stage / DAG 执行，统一提交，不重新计回合数。
- 批量恢复和带来源的单任务恢复，都只执行选中的目标。不允许事件订阅者、递归或后台分发把范围扩大。普通的、不带来源的 manual / plugin-RPC 行为不变。
- 原来的故事和已提交成功的非目标结果只作为上下文，不重复提交。
- 一个目标失败、另一个因为依赖被跳过时，两者都仍然待恢复。
- 整个回合中断、没有已提交的来源时，应该先恢复原来的 action。不能把 trace 里的“成功”当成已提交的数据。

**恢复时的 trace 和摘要**

- 每次恢复的生命周期 trace / SSE payload 都带着 `sourceTurnId` 和这次的 `runtimeIds`。`turnId` 保留这次尝试自己的身份。
- 客户端在收到 `committed: true` 的回合或执行终态，或者确认了已提交的产物之后，才更新任务的恢复状态，并保留原来的失败记录。事务回滚和中断不会清除原来的失败。
- 批量操作中断时，`retry` 描述保留同一组目标。`recoverFromTurnId` 的校验不允许改动这一组。
- 新的 scope 还带着服务端验证过的 `sourceCommitted: true` 和 `sourceFailedRuntimeIds`。旧的 trace 可以没有这两个字段。
- 失败摘要完整地包含来源账本里仍然失败的 ID，包括 inactive 的，不按所选目标的上限截断。
- 执行中的摘要是开始之前的情况。已提交的终态按这次真实的结果结算：成功的移除，失败和 skipped 的保留。回滚或中断时不变。空数组也会发送。
- 客户端用最新的摘要替换旧的集合。同一次尝试里，已提交的终态优先于执行中的摘要。这样有上限的 trace 快照不会漏掉没恢复的任务，也不会让旧的失败重新出现。
- 一个 ID 不在摘要里，不等于有一个可以显示的成功步骤。成功步骤仍然需要真实的执行和提交证据。

**`payload.inputMessageId`**

`send_message` 和 `execute_command` 可以提供它。流程是：浏览器先保存玩家的输入，再把它的 ID 随动作发出。

| 情况                                                       | 结果                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| 同一个会话里有同 ID、同内容、未提交的 user 记录            | 服务端在最终提交的事务里接管它，保留原来的时间戳，并写入 `metadata.turnId` |
| 同一回合重复提交相同的输入                                 | 保留原记录                                                                 |
| 这个 ID 已经关联了别的回合、内容对不上，或者被别的会话占用 | 提交失败                                                                   |
| 没有本地记录                                               | 按这个 ID 插入                                                             |
| 没有提供 ID                                                | 由服务端生成                                                               |

- ID 不同、文本相同，仍然是两条独立的输入。
- 失败恢复保留原来的 `inputMessageId`，不会再生成一份输入的副本。
- 这个字段不适用于 steering 请求。
- 已有开发数据里的重复记录不会自动合并，需要重新创建受影响的会话。

**聊天回合和插件调用的区别**

- 玩家发送的自然语言走 `/api/actions` 的 `send_message`，触发写故事的主流程。
- 输入框先用 `GET /api/sessions/:id/plugins` 返回的会话命令目录匹配斜线命令。
  - 已知的命令走 `/api/sessions/:id/plugin-rpc` 的 `{ kind: "command", commandId, input }`，不经过写故事的主流程。
  - 未知的命令按输入框原有的规则处理（普通空闲时提交走 `execute_command`）。
- 声明了 command 的插件 UI 按钮使用 JSON-RENDER 的 `invokeCommand`，走 `/api/sessions/:id/plugin-rpc` 的 `{ kind: "command", commandId, args }`。它不经过写故事的主流程，并且和输入框命令共用参数校验、上下文、审批、handler 和 trace。
- 其他自定义的 UI action 才使用 `invokePluginAction`。

### 交互响应

| 命令           | 方法 | 端点           | 响应                                                                                  |
| -------------- | ---- | -------------- | ------------------------------------------------------------------------------------- |
| `input.submit` | POST | `/api/actions` | `type: "submit_interaction"` 的 SSE 流：`interaction.submitted`，随后是后续回合的事件 |

保存回答和开始后续回合是一次操作：同一把会话锁，同一个事务。见 [api.md § 玩家交互](./api.md#玩家交互)。

- `interaction.submitted` 外层的 `turnId` 是后续回合的 ID。
- 客户端用 `results[].values`（服务端保存下来的值）把表单标成已提交。
- 客户端用 `message` 画出玩家的气泡。`message.id` 是保存下来的消息的 ID，所以回合结束后刷新不会多出一行。

回答没有被接受时，流里只有一个 `error.occurred`。没有内容被保存，也没有回合开始：

| `code`                            | 含义                                                                                         | 客户端怎么做                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"form_rejected"`                 | 玩家填的值没有通过校验。`message` 是按会话语言写给玩家的文字                                 | `details.issues` 按字段列出每条原因（`{ field?, message }`，没有 `field` 的属于整张表单）。把每条消息显示在对应字段下面，聚焦第一个出错的字段；整张表单的错误显示在字段上方。保留玩家已经填的内容，不进入“执行出错”状态 |
| `"interaction_already_submitted"` | 这个交互已经被回答了（另一个标签页，或者一次回答丢失的提交）                                 | 不重发。从会话视图的 `submittedInteractions` 标记表单，并用 `GET /api/sessions/:id/execution` 观察那次提交开始的回合                                                                                                    |
| `"form_validator_failed"`         | 来源插件的表单校验器抛了错。`message` 是按会话语言写的固定文字，插件抛出的原文只进服务端日志 | 按普通错误显示。表单可以再次提交                                                                                                                                                                                        |

连接在流开始之后中断时，同样不重发：回合在服务端一直运行到提交，客户端通过执行状态轮询和会话视图恢复。

表单交互可选的 `notice` 字段显示在字段上方。

### 插件管理

| 命令             | 方法   | 端点                                  | 响应                              |
| ---------------- | ------ | ------------------------------------- | --------------------------------- |
| `plugin.enable`  | PUT    | `/api/sessions/:id/plugins/:pluginId` | JSON: `{ ok, activePluginIds[] }` |
| `plugin.disable` | DELETE | `/api/sessions/:id/plugins/:pluginId` | JSON: `{ ok, activePluginIds[] }` |

### 插件 RPC

这是给插件发“结构化指令”的统一通道。它同时承载三种调用：action 级、runtime 级和命令级。

- action 级和 command 级返回一次 JSON。
- runtime 级按 `manifest.execution` 分成 sync 和 background 两种回答。

| 命令         | 方法 | 端点                           | 响应           |
| ------------ | ---- | ------------------------------ | -------------- |
| `plugin.rpc` | POST | `/api/sessions/:id/plugin-rpc` | JSON 变体,见下 |

**请求体（action / runtime / command 三选一）：**

```json
{
  "kind": "action",
  "pluginId": "my-plugin",
  "action": "my-action",
  "payload": {/* ... */}
}
```

```json
{
  "kind": "runtime",
  "pluginId": "my-plugin",
  "runtimeId": "my-plugin/my-runtime",
  "payload": {/* ... */}
}
```

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "input": "/roll 2d6"
}
```

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "args": { "notation": "2d6" }
}
```

- `kind` 必填。服务端只看它来决定走哪个分支，不根据其他字段去猜。
- command 请求的 `input` 和 `args` 必须提供一个，而且只能提供一个。
- 服务端把两种写法整理成同一个 `RpcCommandInvocation`。所以日志和后面的 handler 都用 `commandId + args` 来识别同一个业务操作。只有 `source` 保留入口的差别：`composer`（输入框）或 `plugin-ui`（插件界面）。

**响应分支：**

| 状态码 | 成功 `status` / 错误 `code`                                                                          | 触发                                                                                                                                    |
| ------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 200    | `ok`                                                                                                 | action / command 级成功，或 runtime 级 sync 模式成功                                                                                    |
| 202    | `approval-required`                                                                                  | community-trust 首次调用(action、command 或 runtime 级)                                                                                 |
| 202    | `accepted`                                                                                           | runtime 级 `execution: background` 或 `expectsBackgroundFollower`，含 `jobId` + `turnId`；状态走 `job-status.updated` + `_runtime_jobs` |
| 400    | 通用错误信封                                                                                         | kind/字段组合、参数或 payload 校验失败                                                                                                  |
| 404    | `unknown_action` / `runtime_not_active` / `command_not_active`                                       | action 未注册 / runtime 未激活 / command 不在当前会话目录                                                                               |
| 409    | `approval_scope_changed` / `session_not_active` / `session_deleting` / `session_incarnation_changed` | 等锁期间授权/会话代次变化，或 session 已暂停、结束、删除中；客户端应刷新后重新发起                                                      |
| 429    | `queue_full`                                                                                         | pending approvals 超过 cap                                                                                                              |
| 500    | `runtime_execution_failed` / `background_enqueue_failed` / `turn_commit_failed`                      | sync 执行异常 / 入队失败(background 模式下 runtime 内部异常走 SSE,不进 HTTP)                                                            |

所有非 2xx 的回答都使用 `{ error, code?, details? }`，不返回业务的 `status`。

**两次授权**

带延迟 `entry` 的社区插件 action 会连续返回两次 `approval-required`：

1. 先授权 `covel:plugin-server-code`（运行服务端代码）。
2. 重试之后，再授权真正的 action。

客户端逐个阶段显示审批，并重试原来的请求。同一个请求重复索取相同的 `(pluginId, action)` 授权时，客户端停止，并拒绝跨会话的审批回答。

`submit_interaction` 的一批回答可以涉及多个来源插件，不限制阶段的数量。所有来源的 server-code 授权都齐了，才校验并原子保存。

**框架默认 action：** 见 [api.md](./api.md#post-apisessionsidplugin-rpc) 的“框架默认 action”小节。

恢复挂起的 runtime 也逐项请求缺少的授权。审批期间释放客户端的会话队列；切换会话或拒绝审批会停止重试并保留挂起项。见 [恢复接口](./api.md#post-apisessionsidsuspensionssuspensionidresume)。

### RPC Approval

社区插件的 RPC 调用需要玩家明确批准。框架返回 202 之后，前端通过下面的接口读取待批准的项，并提交决定。

| 命令              | 方法 | 端点                                  | 响应                                     |
| ----------------- | ---- | ------------------------------------- | ---------------------------------------- |
| `approval.list`   | GET  | `/api/sessions/:id/approvals`         | JSON: `{ items: RpcApprovalPending[] }`  |
| `approval.decide` | POST | `/api/approvals/:approvalId/decision` | JSON: `{ ok, decision, scope, pending }` |

**Decision 请求体：**

```json
{
  "decision": "allow",
  "scope": "once"
}
```

| 字段       | 取值                                                                    |
| ---------- | ----------------------------------------------------------------------- |
| `decision` | `"allow"` 或 `"deny"`                                                   |
| `scope`    | `"once"`（默认，60 秒内使用一次）或 `"session"`（在这个会话里一直有效） |

详细的流程图见 [api.md](./api.md#rpc-approval-流程)。

每个待批准项和每次授权，都绑定服务端保存的会话代次和插件的撤销代次。撤销、禁用、删除，或者用同一个 ID 重建之后，旧的决定返回 `409 approval_scope_changed`。旧 Pod 内存里的授权也不能用在新的代次上。

## 三、查询端点

只读的数据获取，普通的 REST GET 回答：

| 查询     | 端点                                              | 响应                                                                                                                       |
| -------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 会话列表 | `GET /api/sessions?worldId=`                      | `{ items: SessionRecord[] }`                                                                                               |
| 会话详情 | `GET /api/sessions/:id`                           | `SessionRecord`                                                                                                            |
| 会话视图 | `GET /api/sessions/:id/view`                      | `SessionSnapshot`（messages/steps 为最近窗口 + 不透明 `messagesCursor`；`submittedInteractions` 为窗口内回合已回答的交互） |
| 消息列表 | `GET /api/sessions/:id/messages`                  | `FlatMessage[]`（全量）                                                                                                    |
| 消息分页 | `GET /api/sessions/:id/messages/page`             | `CursorPage<FlatMessage>`（游标）                                                                                          |
| 角色列表 | `GET /api/sessions/:id/characters`                | `{ items: CharacterRecord[] }`                                                                                             |
| 插件列表 | `GET /api/sessions/:id/plugins`                   | `{ active[], available[] }`                                                                                                |
| 状态查询 | `GET /api/sessions/:id/state`                     | `{ tables }`                                                                                                               |
| 状态补丁 | `GET /api/sessions/:id/state-patches`             | `Patch[]`                                                                                                                  |
| 插件数据 | `GET /api/sessions/:id/plugin-data/:pluginId/:ns` | `{ items[] }`                                                                                                              |
| 世界列表 | `GET /api/worlds`                                 | `{ items: WorldRecord[] }`                                                                                                 |
| 执行追踪 | `GET /api/traces/:sessionId`                      | `{ events[], nextCursor }`（最近 5000 条，游标读更早的）                                                                   |
| 追踪分页 | `GET /api/traces/:sessionId/turns/page`           | `{ turns[], nextCursor }`（游标）                                                                                          |
| 服务健康 | `GET /api/health`                                 | `{ status, version, bootId, timestamp, storage, vector }`                                                                  |

## 四、SSE 信封格式

`/api/actions` 流里的每一帧都用同一个外层结构（`packages/shared/src/types/api-contract.ts`）：

```typescript
interface SseEnvelope {
  type: string; // event type, one of CovelEventType
  requestId: string; // id of the request that opened the stream
  traceId: string; // trace id
  sessionId: string; // session id
  turnId: string; // turn id
  flowId: string; // mirrors traceId
  seq: number; // sequence number, increases monotonically
  timestamp: string; // ISO timestamp
  payload: Record<string, unknown>; // event data
}
```

`/api/events/stream` 的帧用的是另一个结构 `ProtocolEvent`：`{ id, type, sessionId, turnId?, source?: { pluginId, runtimeId }, payload, timestamp }`。

## 五、前端事件路由

`handleSseEvent` 是回合内事件唯一的处理器。它按事件类型，把事件交给对应的状态片段：

```
narrative.delta       → messages (streaming buffer)
narrative.completed   → messages (completed)
interaction.requested → messages (block)
state.changed         → gameState (deep merge) + statePatches
event.emitted         → gameState.events
interaction.submitted → handled by the caller that submitted the form: SUBMIT_BLOCK + player bubble (not through handleSseEvent)
execution.started     → executionSteps
runtime.started       → executionSteps
runtime.deferred      → executionSteps (pending, attached to the source turn by sourceTurnId)
runtime.completed     → executionSteps
runtime.failed        → executionSteps
job-status.updated    → executionSteps (background terminal state, by data.originTurnId)
execution.completed   → committed=true: finalize; committed=false: discard optimistic stream + executionError; both set executing=false
error.occurred        → executionError
```

## 六、传输层（真实形态）

这一节描述的是真实的实现。**没有统一的 transport 抽象层**，也没有可以替换的 Transport 实现。

通讯由下面几条**具体**的路径承载（对应“架构总览”的三类）：

| 方向            | 真实实现                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command（上行） | REST `POST`，硬编码 `fetch('/api/...')`（`apps/web/src/services/`）                                                                               |
| 回合内 Event    | `POST /api/actions` 的 data-only SSE，`fetch` + `ReadableStream` 解析（`apps/web/src/services/sse.ts` / `api/actions.ts`，信封 = `SseEnvelope`）  |
| 辅助 Event      | `GET /api/events/stream` 的命名 SSE，`fetch` 读流 + `lastEventId` 查询参数重连（`apps/web/src/services/subscription.ts`，信封 = `ProtocolEvent`） |
| Query（只读）   | REST `GET`，标准 JSON                                                                                                                             |

唯一真正的部署抽象在**数据层**，不在传输层：`apps/web/src/services/data-service.ts` 的 `DataService` 区分 `local`（浏览器的 IndexedDB）和 `remote`（服务器 API）。但它**只管数据的增删改查**。回合执行和上面两条 SSE 流，即使在 `local` 模式下也仍然直接连服务器。

### WebSocket 升级路径

升级到 WebSocket **不是**“换一个 Transport 实现”那么简单。上行和下行现在都直接写在上面那些 `fetch` 调用的地方。要上 WebSocket，需要在服务器和前端两边分别新增 WS 的处理和帧的编解码。

## 七、Debug trace events

内置 `TurnEmitter` 的诊断事件，保存和广播都是“尽力而为”：

- 存储接口同步抛错或异步拒绝时，仍然尝试广播。
- 广播抛错时，仍然等已经开始的保存完成。
- 投递失败时的兜底告警只包含事件类型、sessionId、turnId 和 traceId，不复制原始异常或 trace 正文。
- Hook trace 投递失败，不改变已经接受的策略结果，也不触发重复的 runtime 收尾。
- 诊断记录缺失不代表领域提交失败。

### Thinking output and continuation

**思考内容放在哪里**

`LLMResponse.reasoningContent` 是服务商给出的思考文本或摘要，和叙事内容分开。服务商给出时，适配器从下面这些地方取出它：

| 协议        | 来源                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------- |
| Chat        | `reasoning_content` 或 `reasoning`（DeepSeek 和 DashScope 用前者；groq、OpenRouter 和较新的 vLLM 用后者） |
| Responses   | `output[].summary[].text`                                                                                 |
| Anthropic   | `thinking` 块                                                                                             |
| Gemini 原生 | thought part                                                                                              |

- 加密或打码的状态和签名，永远不会被当成可显示的文字。
- 服务商没有返回可读的内容时，不显示思考面板。

**写在正文里的 `<think>…</think>`**

有些模型把思考直接写在回答里（Qwen3、DeepSeek-R1 和它们的蒸馏版，前面有一个把它当正文透传的网关）。

- 这部分会从 Chat 和 Responses 的文本里移出来，放进 `reasoningContent` 和 `reasoning-delta`。流式回答也一样。做法和 AI SDK 的 `extractReasoningMiddleware` 相同。
- 被流的分片切开的标签，会先扣住，等凑完整了再处理。
- 回答在一个思考块里被截断时，从那里到结尾都算思考。
- 这种思考不会回传给模型：它的 continuation 记录来源是 `think`，对同一个目标的后续请求只发送回答的文字，这也是这些模型期望的。

**Chat 协议回传思考时用哪个字段**

回传思考用的字段是由接口地址决定的，所以 Covel 不维护一张服务商名单：

- 一个以 `reasoning` 字段到达的回答，带一个 `providerContinuation`，里面记下了这个字段。
- 请求带着这样的 continuation，并且协议、模型和地址都相同时，每条 assistant 消息的思考都用 `reasoning` 回传。
- 否则用通用的 `reasoning_content`，它也是 AI SDK 的 openai-compatible provider 的默认值。
- groq 拒绝 assistant 消息上的 `reasoning_content`。

**界面上怎样显示**

- 会话记录和 DEBUG 页面把这段文字放在一个默认折叠的展开区里。
- 会话里的条目按来源回合和 runtime 分组，每次完成的模型调用一条，包括 function 插件的 gateway 调用。
- 实时的 action 事件和从保存的 trace 恢复出来的内容使用同一个身份（`turnId`、runtime、事件类型、`flowId`、`seq`），所以重放不会产生重复的条目。
- 重新加载会恢复本地可用的执行历史，以及服务端保留的 trace 窗口。
- detached 任务完成时会触发快照恢复。
- 思考内容在每次调用结束之后才显示。界面上逐 token 的流式显示不属于这份约定。

**`reasoning-delta` 和超时**

`LLMStreamEvent.reasoning-delta` 和叙事的片段是两种事件。它算作“服务商有动静”：

- 它计入首 token 超时；第一次输出之后，它也计入空闲超时。
- 文本、思考和工具调用事件，每一个都让空闲等待重新开始。所以一条一直在写的流没有总时长的限制。
- 服务商要求的退避时间不算在内：一次被限流或失败的传输尝试（HTTP 429 / 5xx，遵守 `retry-after`）之后，首 token 超时暂停；后面的尝试得到回答时，它重新开始计时。
- runtime 的期限和请求预算仍然适用。

**`providerContinuation`：工具续调时带回原生内容**

- 它按原顺序保存服务商原生的回答条目，包括签名和加密的思考。只在协议、模型和地址都相同时，用于工具续调。
- Gemini 原生的工具回合保留带 `thoughtSignature` 的、有顺序的 part。
- 一个 Gemini 原生的 continuation 进来时，协议没变但模型或地址变了，带签名的续调以 `CONFIG_ERROR` 失败。
- 换到另一种协议时，重新构建通用的历史，不回放 Gemini 的签名。
- runtime 带着这个不解释的字段经过流的完成、assistant 的工具调用消息和挂起的历史。用于显示和回答的 trace 负载只使用 `reasoningContent`。
- 请求的 trace 里可能包含回放的原生条目，因为它反映的是实际发出去的请求。

**参考**

这种分离参考了 [AI SDK 的 reasoning 流协议](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)和[各家 Responses 的续调做法](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/convert-to-openai-responses-input.ts)。Covel 保留自己的 gateway，不增加 SDK 依赖。Gemini 原生请求的形状参考了 [Google generateContent](https://ai.google.dev/api/generate-content)、[thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures) 和 [AI SDK 的 Google 语言模型](https://github.com/vercel/ai/blob/main/packages/google/src/google-language-model.ts)。这些参考只指导已经实现的那一部分，不表示和 AI SDK 的功能完全对等。请求格式的行为还参考了[阿里云的 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) 和 [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)。

### trace 事件的负载

这些事件使用标准的 SSE 信封，同时保存进 `trace_events`。它们由 runtime 的 `TurnEmitter`（`packages/runtime/src/trace/turn-emitter.ts`）发出，去两个地方：

- `trace_events`，供 `/api/traces` 读取接口和 `/debug` 检查器使用。
- 全局的 `EventBus`。`/api/actions` 的 SSE 路由再按 `FORWARDED_EVENT_TYPES`（由 `COVEL_EVENT_META[type].forwardToActionStream` 生成的集合）转发它们。

| Type                     | Payload                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool.calling`           | `{ runtimeId, pluginId, toolName, toolCallId, label, arguments, source, approvalStatus }`                                                                                                                                                                                                                                                                                                                                   |
| `tool.completed`         | `{ runtimeId, pluginId, toolName, toolCallId, label, result, parsedResult, durationMs, approvalStatus, success: true }`                                                                                                                                                                                                                                                                                                     |
| `tool.failed`            | `{ runtimeId, pluginId, toolName, toolCallId, label, code, error, details?, durationMs, approvalStatus, success: false }`                                                                                                                                                                                                                                                                                                   |
| `domain-event.previewed` | `{ runtimeId, pluginId, toolCallId, topic, data }`。`emit-event` 校验成功后的临时显示信号；持久的业务状态仍然由正常的事件链提交                                                                                                                                                                                                                                                                                             |
| `llm.calling`            | `{ runtimeId, pluginId, slot, model, provider?: string \| null, messages, tools, attempt, startedAt, queueWaitMs?, streaming? }`。`slot` 是 runtime 请求的用途；生产环境的 gateway 在调用之前把它解析成 `model` / `provider`。不支持用途解析的自定义 adapter 可以不给 `provider`                                                                                                                                            |
| `llm.responded`          | `{ runtimeId, pluginId, text?, reasoningContent?, toolCalls?, usage, finishReason, durationMs, attempt, error? }`。`usage` 是 `{ inputTokens, outputTokens, cachedInputTokens?, cacheWriteInputTokens? }`，其中 `inputTokens` 是包含缓存读写的总输入，后两项是服务商报告的子集。`finishReason` 为 `length` 只出现在 story runtime：正文在输出上限处被截断，但已经保留，客户端据此提示玩家；其他情况下被截断的调用按失败上报 |
| `gateway.responded`      | function-runtime gateway 的成功结果。文本和对象调用带 `{ runtimeId, pluginId, method, finishReason, usage, reasoningContent?, model?, provider?, durationMs }`，`model/provider` 是回退之后实际命中的目标。转写调用同样带可用的 `usage/model/provider`。旧的 trace，或者不支持这些元数据的自定义 gateway，可以没有它们                                                                                                      |
| `message.completed`      | `{ runtimeId, pluginId, content, len, deltaCount }`。`deltaCount` 是这个 runtime 产生的 `narrative.delta` 事件数，是保存下来的权威计数。前端汇总实时片段时用的是另一个合成字段 `_aggregated`，两者不能互换                                                                                                                                                                                                                  |
| `block.emitted`          | `{ runtimeId, pluginId, proposalId, source, block }`                                                                                                                                                                                                                                                                                                                                                                        |
| `ui.rendered`            | `{ runtimeId, pluginId, proposalId, source, render, block? }`。`/actions` SSE 会转发它，这样聊天区能实时显示已提交的 `ui.render` 块。较旧的、只进 trace 的负载可能没有 `block`，这时客户端从 `render` 合成它                                                                                                                                                                                                                |
| `state.patch.applied`    | `{ runtimeId, pluginId, proposalId, patch: { packageName, summary, ops } }`                                                                                                                                                                                                                                                                                                                                                 |
| `hook.fired`             | `{ event, hookName, pluginId, runtimeId?, targetId?, targetType, proposalType? }`                                                                                                                                                                                                                                                                                                                                           |
| `hook.rewrote`           | `{ event, hookName, pluginId, runtimeId?, targetId?, diff?, proposalType? }`                                                                                                                                                                                                                                                                                                                                                |
| `hook.aborted`           | `{ event, hookName, pluginId, runtimeId?, targetId?, reason, proposalType? }`                                                                                                                                                                                                                                                                                                                                               |
| `command.invoked`        | `{ invocationId, commandId, command, pluginId, action, source, canonical, raw, argv, args }`。输入框和 JSON-RENDER 使用同一个结构                                                                                                                                                                                                                                                                                           |
| `command.completed`      | `command.invoked` 的字段 + `{ durationMs, resultOk? }`                                                                                                                                                                                                                                                                                                                                                                      |
| `command.failed`         | `command.invoked` 的字段 + `{ durationMs, error }`                                                                                                                                                                                                                                                                                                                                                                          |

`tool.completed` 表示执行器已接受工具结果，不表示 proposal 已提交。接受前取消只报 `tool.failed`；接受后的取消不再为同一调用发失败事件。工具 trace 或领域事件预览发送失败只告警，不把工具成功改为失败。

叙事的片段继续通过 `narrative.delta` 实时发给界面。为了让 `trace_events` 保持精简，只保存 `message.completed`。

**`command.*`**

- 由 action 级的命令分发器的 TurnEmitter 写进 `trace_events`，并发布到 `trace` 订阅 topic。`forwardToActionStream: false`，所以它们不会出现在游戏的 `/api/actions` 流里。
- 三个事件共用 `invocationId` 作为 `traceId/turnId`。
- 日志不保存 handler 完整的返回值，只记录终态、耗时和可选的 `resultOk`。

> [!WARNING]
> `raw` / `args` 会按设计进入 trace。命令参数里不能放 API key、凭据或其他秘密。

**负载的补充说明**

读取接口 `/api/traces/*`：

- 它不修改原始的 `payload`，另外给每条事件补上三样：保存下来的 `id`、这次回答里单调递增的 `eventOrder`，以及统一的 `diagnostic` 摘要。客户端可以直接用 `diagnostic.error` 找到失败，用 `diagnostic.prompt` 找到提示词的规模和正文的路径，不用按事件类型去猜 `payload` 里的字段。
- `eventOrder` 从 0 开始。它只表示当前这次 API 回答（全量结果或单页）里按时间排的记录顺序。它不是全局的数据库序号，不能跨页比较。
- `diagnostic.severity` 是 `info` / `warning` / `error`，错误优先。成功的 `llm.responded`、`gateway.responded`、`utils.fetch.responded`、`tool.completed`、`runtime.completed`、`function.completed` 耗时达到 1000ms 时标为 `warning`，并带 `diagnostic.warning = { code: "slow", thresholdMs: 1000 }`。
- `tool.*` 事件带 `diagnostic.tool` 摘要：name、callId、参数和结果是否可用、`payload.arguments` / `payload.result` 等内容的路径、success、durationMs。原始的参数和结果仍然只在 `payload` 里。

`llm.calling` 的时间字段：

- `payload.startedAt`（同时出现在 `diagnostic.startedAt`）记录真正开始请求服务商的时间。事件自己的 `timestamp` 仍然是 trace 行保存的时间。有些 adapter 为了先确认最终的 provider/model，会晚一点才写 calling 事件。判断耗时要结合 `startedAt` 和 responded 的 `durationMs`。
- `queueWaitMs` 是这次尝试实际等待框架并发槽的毫秒数。模型调用的 `durationMs` 从拿到并发槽之后开始算，包含读取回答流的时间。历史数据或不经过重试层的调用可以没有队列指标，不能把“没有”理解成 0。

runtime 的终态：

- 新执行的 runtime 终态，在 `PostRuntime` 和输出 / 取消校验之后发布：最终失败用 `runtime.failed`，最终成功或暂停用 `runtime.completed`。action SSE 把“跳过”对应成 `runtime.skipped`。
- 终态的 payload 保留 `turnId` 和 `runId`。它不等于事务提交成功。
- 回合提交成功、但某个可选 runtime 的写入被单独丢弃时，主回合在 `execution.completed` 之前给它补发一条 `runtime.failed`（带丢弃的原因）。客户端用它覆盖之前的 `runtime.completed`。
- 历史数据里 `runtime.completed` 的 `status: "failed"`、`turn.completed` 的 `committed: false`，仍然属于诊断上的失败。
- 一次 LLM 尝试失败、重试之后成功，失败记录仍然保留。界面应该把“已恢复的尝试”和任务的最终状态分开显示。

`llm.calling` 里的请求内容：

- 可以附带 `responseFormat`、`defaults`、`maxOutputTokens`，描述 runtime 请求的结构化输出和生成限制。实际发给服务商的请求在可选的 `providerRequests` 数组里。只提供自定义 LLM adapter、又没有实现观察入口时，这个数组不存在；这时不应该从逻辑消息去猜最终的请求。
- `providerRequests[]` 的格式：`{ schemaVersion: 1, provider, protocol, body, complete, omittedFieldCount, startedAt, durationMs, transportAttempt, statusCode?, failed? }`。
  - `body` 来自 HTTP adapter 序列化之后的 JSON，包括 adapter 加上的结构化提示、消息和工具的转换，以及参数覆盖之后的值。
  - 数组的顺序保留了目标回退和 HTTP 重试的先后。`transportAttempt` 在每个协议请求里从 0 开始。
  - 关联靠外层的 trace / turn / runtime / attempt 标识。它不新增领域写入，也不是恢复时的依据。
- 同一个 `providerRequests` 数组里，完全相同的请求体只保存一次。重复的项使用 `schemaVersion: 2`，用 `bodyRef` 代替 `body`，其余的尝试元数据各自保留。
  - `bodyRef` 是同一个数组里更早的、带完整请求体的那一项的下标（从 0 开始）。不允许引用链、向后引用或跨 trace 引用。
  - HTTP 观察回调仍然返回完整的 v1 请求，只有 trace 序列化时才去重。
  - 调试页兼容历史上的完整项，在查看和复制时解析引用。无效的引用显示为“不可用”，不去猜正文。
  - 逻辑消息和实际的协议请求仍然分别保留。
- 观察入口在 HTTP 返回或失败时报告。所以 `statusCode: 200` 只代表 HTTP 被接受，流式输出之后仍然可能失败。以 `llm.responded` 和 runtime 的结算为准。
- 文本流发出第一个片段之前，对应的 HTTP 请求内容就已经保存了。进程在 HTTP 返回之前退出时可能没有记录。trace 是尽力而为的，不保证崩溃时审计完整。
- `llm.calling.tools` 是 `Array<{ name, description, jsonSchema }>`。它由 `LLMToolDefinition.parameters` 转换而来，保留逻辑上的 schema；`providerRequests` 里是最终按协议写出的样子。
- `llm.calling.provider` 在直接调用 `generate` / `generateStream`、拿不到解析后的 provider 字符串的地方是 `null`。按用途路由的调用会填上 provider 名（`openai`、`anthropic`、`deepseek`、`qwen`）。

隐私边界：

- 不收集认证头、API key、provider 的 base URL 或配置对象。
- 任意额外的 metadata 只记录被省略的字段数量。
- 带查询参数、凭据或片段的资源 URL 被隐去，并标记 `complete: false`。
- 遇到不支持的版本、`complete: false`，或者外部资源已经失效时，离线工具必须报告“无法完整重建”。
- `complete: true` 只说明 JSON 请求内容是完整的。它不保证资源永久有效、HTTP 头可以重建，或者真实的模型结果是确定的。
- 请求正文沿用现有 trace 的敏感内容访问和留存规则。它包含玩家的文字，不能当成可以公开导出的脱敏日志。
- function runtime 的 `gateway.*` 仍然只记录形状，不扩大正文的收集范围。

## Event bus lifecycle and client handler failures

**`flush()` 和 `close()`**

- `EventBus.flush()` 等有上限的审计持久化队列排空。它不等跨进程的投递，也不阻止新的事件。
- `EventBus.close()` 可以重复调用。它依次：停止本地的发出和远端的接收；在支持的地方取消订阅；清掉“等待缺口”的定时器；等没完成的持久化、有顺序的发布和已收到引用的读取结束；最后关闭它自己拥有的 transport。
- 关闭之后调用 `emit()` 会被忽略。
- transport 可以从 `subscribe()` 返回一个取消订阅的函数，并在自己持有资源时实现 `close()`。PostgreSQL 的实现通过这个生命周期释放它的 LISTEN/NOTIFY 客户端。
- 服务器的关闭顺序：先关 worker，再关 bus，最后关 bus 背后的存储。

**世界文件监听器**

- 世界文件监听器在 worker 关闭之前停止接收，并等已经接受的重新加载完成。
- 同一个物理世界目录的重新加载按顺序执行。所以一次较早的、较慢的加载，不会盖掉一次较晚的重新加载的结果。
- 如果某个生产者超过了排空的时间预算，关闭流程会让依赖保持打开，交给进程退出去处理。

**浏览器里的事件处理器**

- 动作流只暂停同一会话的后台订阅，暂停按会话计数。切换会话不会中止旧动作流或它的检查点提交；新会话的订阅可以立即连接。页面隐藏时暂停订阅，重新显示时恢复。
- 浏览器的订阅把每个事件处理器隔离开。
- 一个处理器同步抛错时，上报会话 id、事件 id / 类型和错误类型。它不记录事件的负载或异常消息，其他订阅者继续运行。
- 连接恢复和 `system.reset` 仍然从权威状态重建。只有一条处理器警告，不会改变补发的游标，也不会触发重试。

**批量通知**

- 批量的插件数据通知按 `(sessionId, pluginId)` 划分，即使一次 store 调用写了几个会话也一样。
- 事务里的通知先缓冲，到提交时才发出；回滚时丢弃。

**媒体解析的警告**

浏览器里媒体解析的警告写明会话、媒体 id，以及 HTTP 状态或错误类型。它不包含签名 URL 和异常消息，这样媒体访问令牌不会进入诊断日志。

### UI slot projection events

| 事件                                                      | 作用                                           |
| --------------------------------------------------------- | ---------------------------------------------- |
| `ui.slot.changed { slot, key?, value, revision }`         | 更新已提交的 UI 状态                           |
| `ui.slot.preview { slot, key?, value, revision, turnId }` | 暂时盖上某一回合的显示内容，不改变已提交的状态 |
| `ui.slot.cleared { turnId }`                              | 移除这一回合的预览                             |

- 这些事件同时转发到 action 流和后台订阅。
- 回合完成、失败和取消时，客户端也会清掉预览。离开会话或卸载会话宿主时，清掉该会话的整份 slot 缓存；回来时重读权威状态。同一会话内刷新不会清掉正在进行的预览。
- 给一个已经结束的回合迟到的预览会被忽略。明确地开始一次新的执行，允许同一个回合 ID 重试。
- 一个在更新的 SSE 事件之前发出的 GET，它的回答到达时不能覆盖那些更新。

## 来源执行快照

插件读“玩家这次输入了什么”时有两个值：

- `ctx.playerMessage`：当前这次执行的文本命令。
- `ctx.session.lastPlayerInput`：来源执行被接受之后记下的、最近一次结构化提交。形状是 `{ id, sessionId, turnId, formId, values, createdAt }`；没有提交时是 `null`。

关于 `lastPlayerInput`：

- “最近”按保存下来的 UTC `createdAt` 判断。时间戳相同时，按 `id` 的字典序决出先后，不依赖数据库的枚举顺序。
- `values` 只接受 JSON 数据。
- 表单可能来自更早的回合。使用它的插件要按来源标识来解释它，不要自动把旧的表单当成这一次的命令。

`turn-digest@1` 包含 `turnId/playerMessage/locale/narrativeText/toolCallSummaries/lastPlayerInput/runtimeResults`：

- `runtimeResults` 只列出记录那一刻、来源回合已经看到的 `runtimeId` 和状态（`success/failed/skipped/suspended`）。它不包含还没运行的使用者，也不包含其他回合的重试种子。
- 只有成功的故事和已接受的工具调用进入文本摘要。声明 `io.concealed: true` 的 runtime，其工具调用不进入 `toolCallSummaries`；`runtimeResults` 仍保留它的 ID 和状态。

快照怎样保存：

- 内核复制并冻结提交和摘要，在作业的事务里保存同一份来源快照。
- worker 恢复时用共享的 schema 校验它，不能重新去查最新的表单。
- 正常执行、manual 和 resume，各自在新的执行被接受之后记录一次。

> [!WARNING]
> 这份约定只支持当前格式。缺少新字段的旧作业和旧会话快照需要重建。

## 插件调用 trace

`plugin.service.completed` 是只进 trace 的事件，`forwardToActionStream: false`。

- payload 包含 `callId/parentCallId?/sessionId/turnId?/runtimeId?/callerPluginId/providerPluginId/name/contract/durationMs/outcome/errorCode?`。
- 扩展调用另外带宿主登记的元数据 `extension: { point, id, slot? }`。
- 不记录输入、输出、原始异常或私有的 `diagnosticScope`。

**怎样计数和计时**

- 输出的原始校验、归属处理 `attributeOutput` 和最终校验，都在同一次调用的完成边界里进行。失败记为一次 `output-validation`。
- 缓存命中不新增调用。
- 有真实 TurnEmitter 的执行复用它的 `traceId/retryScope/seq`，并等保存的尝试结束。`durationMs` 不包含 trace 的读写时间。
- 观察失败只发一条固定的警告，不改变插件的结果。
- 没有回合 emitter 的 UI 后台显示，只进入一个有上限的进程内窗口，不伪造回合的 trace。

**诊断事件不占补发缓存**

- 诊断用的 `trace` 事件在 event bus 上只实时发送。它们不占订阅的补发缓存，也不在 `events` 里重复保存负载。重连之后通过 trace API 读取诊断。
- 跨进程的大 trace 帧引用原来保存的 trace 行。普通的状态事件保留有顺序的补发和缺口检测。
- 一个只实时发送的 trace 引用丢失或读不出来，只记日志，不会让状态的补发失效。
- 状态事件的引用读取失败，仍然触发补发重置。原因：丢了它，使用者看到的已提交状态就不一样了。
