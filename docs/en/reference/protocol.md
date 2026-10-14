# SSE protocol

This page explains how a client and the Covel server talk to each other: what requests the client sends, what events the server pushes, what data each event carries, and how a client recovers after a dropped connection.

It is for three kinds of readers: people who write their own client, people who embed the Covel runtime in their own host, and people who change the bundled web app or the server. If you only write plugins, you rarely need this page. The events a plugin can emit are in the [tools reference](./tools.md). The full HTTP API is in [api.md](./api.md).

The type definitions are in `packages/shared/src/types/protocol.ts`.

## Architecture overview

All communication falls into three groups:

| Group   | Direction       | Form                                                                                                 |
| ------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| Command | client → server | A request such as `POST`. It changes state. The answer is JSON (returned at once) or SSE (streamed). |
| Event   | server → client | Two separate SSE streams, see the table below.                                                       |
| Query   | client → server | A `GET` request. It only reads. It returns a normal REST JSON answer.                                |

SSE is the way the server keeps pushing text over one HTTP connection. Covel has two SSE streams, and their formats differ:

|                       | Main channel `POST /api/actions`                             | Side channel `GET /api/events/stream`                                                                                                                                |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose               | Events during one player action (one turn)                   | Ongoing subscription outside a turn: background jobs, changes made elsewhere                                                                                         |
| Frame shape           | Only `data:` lines, **no `event:` header**                   | Named events: `event: <type>\ndata: ...`                                                                                                                             |
| Outer structure       | `SseEnvelope` (`requestId` / `traceId` / `flowId` / `seq` …) | `ProtocolEvent` (`id` / `source` …)                                                                                                                                  |
| How a client reads it | `fetch` + `ReadableStream`, reading `data:` lines one by one | `fetch` reads the stream and dispatches by the `event:` header                                                                                                       |
| Other                 | The stream ends when the action ends                         | Subscribed by topic. The server sends `system.connected` on connect and `system.heartbeat` every 30 seconds. A reconnect with `lastEventId` can replay missed events |

> [!WARNING]
> Frames on `/api/actions` have no `event:` header. So `EventSource.addEventListener('narrative.delta', …)` **never** fires on this stream. To read events inside a turn, use `sendAction` in `apps/web/src/services/api/actions.ts` (it parses a ReadableStream), or call `fetch()` yourself and read the `data:` lines. Subscribing by event name only works for `/api/events/stream`.

## Host execution and commit boundary

This section is for people who embed `@covel/runtime` in their own service. The core rule is one sentence: **a successful execution does not mean a successful commit**. An execution first works out its result. Then the host writes that result to storage. The result only counts once the write succeeds.

### Execution and commit are two steps

`@covel/runtime.executeTurn` and `resumeSuspendedRuntime` return `{ result, commit }`:

- `result` is the execution result you can use to answer the client.
- `commit` is the full commit plan, which stays in the host's hands. It holds the top-level and nested results, the pending commands, the conversation journal, the suspension records, a snapshot of the Hook settings, the responsibility for counting turns, and the output schemas loaded during execution.

The host completes the commit by calling `commitExecution({ execution, store, completion, ...services })`. The host does not collect these fields itself, and the commit does not load plugins again. The public execution entry points require `deps.store`.

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
> Send only `result` to the client. Never send `commit`, and never accept a `commit` from the client. Neither one carries a finishing function.

### What the host is responsible for

- Authentication, the session lock, request cancellation, and the claim for execution and resume are still the host's job. The calls above must follow the host's own locking policy.
- The player's identity for this turn is passed explicitly in `input.logicalTurnId`.
- While a suspension record exists, turn counting is deferred. The last successful resume of the same logical turn is counted once, through the ledger. A failed resume cannot confirm a continuation.
- A background execution re-checks the enabled plugin set under the commit lock. It narrows the Hook scope through `commitExecution.activePluginIds`. This parameter can only filter plugins already recorded during execution. It cannot add a plugin that was enabled later. Settings still use the snapshot taken during execution.

### When a commit does not happen

- The commit plan keeps the reason a TurnStart Hook vetoed the turn, and any cancellation seen during execution.
- For such an execution, `commitExecution` returns a failure. It stops before the domain transaction, does not allow the host's `extraInTx` writes, and produces no successful completion event or snapshot. Client input that was already saved stays.
- When an execution ends without a commit, the client removes the assistant content that this execution produced, and keeps the player's input.
- Local input echoes claim a `turnId` by the action’s `requestId`. Rejected input cannot be claimed by a later action; echoes cannot supply a history pagination cursor until replaced by authoritative messages.
- A successful result that declares `output.recordAs` must have the output schema recorded during execution. A missing dependency rolls back the whole commit. It does not quietly skip the export. The loaded schema still controls how each exported value is checked, how media is organized, and how revision conflicts are handled, as described in the [transactions contract](./transactions.md).

### Suspend and resume

- When a function runtime suspends, the continuation saves the commands not yet committed, the input, the exported bindings, and the activation.
- A resume uses these frozen snapshots. Commands not yet committed can still be read by the resumed run, and they are committed together, atomically, if the resume succeeds.
- A failed resume discards these domain writes.
- The continuation also records the number of player turns in the history and the plugin version at the moment of the suspension. If either has changed at resume time, the suspended item is voided and does not run; see [Out-of-date suspended items](./api.md#out-of-date-suspended-items).

> [!WARNING]
> After the continuation format changes, existing development-time suspension records must be rebuilt.

### Commands produced by tools

For the `PluginToolResult` that a tool author returns, see the [tool result protocol](./tools.md). After the kernel unpacks it, it puts the commands into `RuntimeResult.pendingProposals` and keeps the business content in `output`. Commands do not appear in the public execution result, and they do not appear in the saved turn history.

The return value of `executeTurn` is the `{ result, commit }` shown above, not `TurnResult`. `collectExecutionJournal` and `collectExecutionSuspensions` are not public APIs.

### A few rules for concurrency

- When a form is submitted during an execution, the mutual-exclusion check runs first, and only then does it try to take ownership of the stream. So it cannot take over the action stream that is in progress.
- An interjection that arrives after narration has ended is not accepted, because the model no longer has a chance to read it. The record saved for an interjection and the live message use the same identity.
- The SSE operations for generate, revise, and translate use a "only one running at a time" flag. The flag stays set until the stream callback finishes, including the cleanup phase.
- A background job that waits for the session lock keeps waiting after a timeout, and it responds to cancellation. An ordinary interactive request still returns "busy" when the lock times out.

## 1. Event types (CovelEvent)

Every event the server sends to the client is a member of **one union type**, `CovelEvent`, in `packages/shared/src/types/protocol.ts`. Each member has the shape `{ type; payload }`. The event names, the forwarding allowlist, and the frontend's exhaustiveness check all follow this type. The type of an event name is `CovelEventType`.

To add a new SSE event, change two places:

1. Add a member to `CovelEvent`.
2. Add a metadata entry in `COVEL_EVENT_META`.

The two are tied together by `satisfies Record<CovelEventType, CovelEventMeta>`. If you miss either one, the build fails.

The tables below list the stable event types. The two streams use the same set of `type` strings:

- `/api/events/stream` always sends them as named event frames (`event: <type>\ndata: ...`).
- `/api/actions` puts the type in `SseEnvelope.type`, and wraps it in a frame that has only `data:` lines.

`/api/actions` also forwards some runtime internal events and trace events (see "Forwarded runtime internal events" at the end of this chapter). They are also in `CovelEvent`. Whether they are forwarded is set by `COVEL_EVENT_META[type].forwardToActionStream`.

In the tables, "S→C" means sent from the server to the client.

### Narrative events

| Event type            | Dir. | Description                        | Payload                                             |
| --------------------- | ---- | ---------------------------------- | --------------------------------------------------- |
| `narrative.delta`     | S→C  | A streamed piece of narrative text | `{ runtimeId, pluginId, kind, delta }`              |
| `narrative.completed` | S→C  | The complete narrative message     | `{ content, kind, messageId, runtimeId, pluginId }` |

- `narrative.delta` can carry `reset: true`. In that case `delta` is an empty string. It means: the text this runtime already streamed was a preparation step before a tool call, or a draft that the review rejected, and it will not become the final narrative. The client should clear the part already shown, then take in the later pieces.
- The `content` of `narrative.completed` is always the final text after review has passed. It replaces what was shown while streaming.

### Interaction events

| Event type              | Dir. | Description                                               | Payload                                                    |
| ----------------------- | ---- | --------------------------------------------------------- | ---------------------------------------------------------- |
| `interaction.requested` | S→C  | Asks the player for input (form, choice, or confirmation) | `{ block: { id, type, data, meta }, runtimeId, pluginId }` |

### State events

| Event type               | Dir. | Description                                      | Payload                                            |
| ------------------------ | ---- | ------------------------------------------------ | -------------------------------------------------- |
| `state.changed`          | S→C  | A change to game state                           | `{ table, field, value, runtimeId, pluginId }`     |
| `event.emitted`          | S→C  | A committed game business event                  | `{ topic?, type?, eventType?, data?, pluginId? }`  |
| `domain-event.previewed` | S→C  | An instant preview of a validated business event | `{ runtimeId, pluginId, toolCallId, topic, data }` |

`domain-event.previewed` is a "preview", not "saved":

- It is sent right after the `emit-event` tool passes schema validation and produces `emittedEvents`. This is before the turn's event chain and the final transaction commit.
- It can only drive display effects that can be undone. It does not mean business state was saved, and it does not satisfy the runtime's bindings and gates.
- The web client does not store or read this event directly. The server projects it into `ui.slot.preview`; the client displays and clears previews through UI slot events.

This lets stage animations react while the narrative is still being generated, and the turn's transaction stays atomic.

### Execution lifecycle events

| Event type              | Dir. | Description                                                                                                            | Payload                                                                                                                 |
| ----------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `execution.started`     | S→C  | A turn execution starts                                                                                                | `{ runtimeCount }`                                                                                                      |
| `interaction.submitted` | S→C  | The answer to `submit_interaction` is saved and the next turn has started. Sent before that turn's `execution.started` | `{ interactionTurnId, results: [{ submissionId, interactionId, values, filledNarrative }], message?: { id, content } }` |
| `runtime.started`       | S→C  | One runtime starts                                                                                                     | `{ runtimeId, pluginId, turnId, runId, label }`                                                                         |
| `runtime.deferred`      | S→C  | A staged runtime was committed with the original turn and moved to the background                                      | `{ runtimeId, pluginId, jobId, sourceTurnId }`                                                                          |
| `runtime.completed`     | S→C  | One runtime completes                                                                                                  | `{ runtimeId, pluginId, turnId, runId, status, durationMs }`                                                            |
| `runtime.failed`        | S→C  | One runtime fails                                                                                                      | `{ runtimeId, pluginId, turnId, runId, status, durationMs, error }`                                                     |
| `execution.completed`   | S→C  | The final state of a turn execution                                                                                    | `{ runtimeCount, resultCount, durationMs, committed, error?, abortReason?, resync? }`, each field explained below       |

Fields of `execution.completed`:

| Field         | Meaning                                                                                                                                                                                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `committed`   | `true`: the proposals, the execution journal, and the session clock are all saved. `false`: nothing was saved, and the client removes the streamed content that was shown early for this turn                                                                                   |
| `error`       | Present when `committed: false`. It holds the proposal error or a general transaction error                                                                                                                                                                                     |
| `abortReason` | Appears only when the turn was stopped. When the player stops it, the value is `"aborted-by-player"`                                                                                                                                                                            |
| `resync`      | `true` only when `committed: true` and some events from this turn were not sent after the commit. The data is saved, so the client should read the saved state and not wait for those events. The subscription stream also gets `system.reset`, with `reason: "publish-failed"` |

> [!NOTE]
> **Opening handoff.** When a player action completes the last setup runtime, the same SSE stream of `POST /api/actions` automatically goes on to run one main-loop turn (see [api.md § POST /api/actions](./api.md)). In this case the stream shows **two** rounds of `execution.started` and runtime lifecycle events, and their outer `turnId` values differ (the setup turn and the handoff turn). But only **one** `execution.completed` closes the stream. The frontend uses it to end the "running" state, and it handles the early content according to `committed`. If the setup commit fails, no handoff starts, and the stream ends directly with `committed: false`.

**`runtime.deferred` is a "handoff notice"**

- It is sent only after the original turn and the queued record in `_runtime_jobs` have been committed atomically, and the session lock is released. So a rollback never shows a background job that does not exist.
- The server writes it into the current `/api/actions` stream, and sends it through the EventBus `runtime` topic to the subscribers of `/api/events/stream`. Its `forwardToActionStream` is `false`, so the EventBus does not forward it a second time, which would put two copies in the action stream.
- It is not the latest status of the job. It can arrive later than the worker's status events. The web app keeps any progress or final state it already saw for the same `jobId`, and a late notice does not turn it back into queued.

### Control during a turn (W4: steer / abort)

Control during a turn uses HTTP endpoints, not SSE events (see [api.md § Control during a turn](./api.md#mid-turn-control-w4)).

**steer: the player interjects during a turn** (`POST /api/sessions/:id/steer`)

- The message goes into the queue for this session on the server. Before the next model call, the story runtime merges the queued content into the live conversation record.
- If the interjection arrives while the final answer is still streaming, the story runtime makes one more model call to handle it before it finishes (limited by maxSteps).
- The interjection is also saved as a user message, so later turn history includes it naturally. If saving fails, the queued item is withdrawn and a 500 is returned, so the queue and the history stay consistent.
- The client shows the interjection locally itself. There is no new SSE event.

**abort: the player stops this turn** (`POST /api/sessions/:id/abort`)

- It fires the turn-level cancel signal. The retry layer immediately cuts off the model call and stream in progress. A player stop is not retried automatically, and a half-finished narrative is not committed as a result.
- The executor stops scheduling the remaining runtime groups, and skips the event chain.
- An aborted runtime is reported as a failure (`runtime.failed`), and its proposals are not produced. At the final commit the player's cancel signal is checked. If the cancel arrived before the commit, the whole turn is not committed.
- This `execution.completed` carries `abortReason: "aborted-by-player"` (the constant `PLAYER_ABORT_REASON`, defined in `@covel/shared`).

When the client receives this value, it treats the end as caused by the player, not as an error:

- It drops the streamed placeholder message for this turn that was not committed. The server never commits a half-finished narrative, and keeping it would make it disappear after a refresh.
- It shows "Stopped; turn not committed" and a clear retry action. It does not show the general error message.
- Other `abortReason` values (for example, a TurnStart hook aborted the turn) are still shown as errors.

### Session lifecycle events

There is no `phase.changed` event.

The real session progress values are `SessionRecord.phase` (`'setup' | 'playing'`), `completedPlayerTurns`, and `setupRuntimes`. When `phase` changes, no SSE is pushed on its own. The client reads these three fields from the session's answer or snapshot.

### System events

| Event type       | Dir. | Description        | Payload                        |
| ---------------- | ---- | ------------------ | ------------------------------ |
| `error.occurred` | S→C  | An execution error | `{ message, code?, details? }` |

- `code` is an optional, stable error code (such as `"session_busy"`). The client can use it to translate the message and to retry. Without `code`, the client shows `message`.
- `details` appears only with `code: "form_rejected"`. See [Interaction responses](#interaction-responses).

The world translation endpoint uses a different SSE event, `{ type: "error", message }`, with no `code` field:

- Once the stream is open, the HTTP status no longer changes.
- For an unknown production error, the message is always `Internal server error`, the same as JSON endpoints do.
- A lock timeout uses one fixed, safe "busy" message.
- The raw diagnostic information goes only to the server log.

This does not change the structure of `error.occurred` in the action stream.

### World events

| Event type                 | Dir. | Description                                             | Payload                      |
| -------------------------- | ---- | ------------------------------------------------------- | ---------------------------- |
| `world.dimensions.changed` | S→C  | The author's dimension declaration changed (hot update) | `{ worldId, changedKeys[] }` |

This is a notice that the world package's declaration changed. It is not an update to the session's current values. The client must not use it to replace the current progress with a new `initialValue`. Existing sessions need an explicit sync, and conflicts must be checked.

### Session dimension events

| Event type                      | Dir. | Trigger                                                                                    | Payload                                                                                   |
| ------------------------------- | ---- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `dimensions.changed`            | S→C  | Initialization, or a current or effective definition value is committed                    | `{providerPluginId, dimensions: DimensionSnapshot, settlement?}`                          |
| `dimensions.settlement.changed` | S→C  | A pending entry is registered, a settlement fails, or a final receipt with no value change | `{providerPluginId, source:{resultId,turnNumber}, sourceTurnId, version, status, error?}` |

**Payload details**

- `dimensions.changed.dimensions` contains only the public entries that changed. The client merges them by ID. It does not replace the whole set.
- Each entry is `{name,description?,schema,value,version}`.
- The optional `settlement` and the second event use a summary with the same shape (the owner is in the outer layer). Its `version` is the version of the receipt. The summary does not include the frozen definitions or readVersions, and it does not repeat the narrative text.
- `status` has five values: `pending-settlement` / `settled` / `no-change` / `manual` / `skipped`.

**When they are sent**

- Both events are sent after the transaction commits. On a rollback, a version conflict, or a metadata-only change, no false value-change event is sent.
- A change with no value change, a value-less edit with `manual` / `skipped`, and failures and pending states are visible separately through the receipt event. A value-change event can carry the receipt summary too.

> [!IMPORTANT]
> `execution.completed.committed: true` can mean "the narrative and the obligations waiting to be settled were committed". It does not mean the dimensions have been settled. The client must check the receipt. Do not infer `no-change` just because the runtime succeeded, the tool succeeded, or no change event arrived.

**Recovery and reconnect**

- Read `dimensions`, `dimensionSettlements`, the host-bound `dimensionProviderPluginId`, and the verified `dimensionRecovery:{editorRuntimeId,trackerRuntimeId}` from the session view.
- The public read is frozen during one execution. Committed snapshots are loaded only after the turn ends, or after a new manual edit execution completes. It never falls back to the world's initial values.
- While pending, the last usable values are kept, and the next narrative is blocked. Recovery goes through the [manual/runtime RPC](./api.md#dimension-editing-and-recovery-of-pending-settlements), without adding a new action type.

### Plugin data events

| Event type            | Dir. | Description                           | Payload                                                         |
| --------------------- | ---- | ------------------------------------- | --------------------------------------------------------------- |
| `plugin-data.changed` | S→C  | A change to a plugin's persisted data | `{ pluginId, changes: [{ namespace, key, value, operation }] }` |

**What triggers it**

- Every write path triggers it: `plugin-data-set`, `plugin-data-set-batch`, DELETE `/plugin-data/...`, and so on. A successful compare-and-set write also counts (runtime job state changes, dimension records).
- It is intercepted in one place, `wrapStoreWithPluginDataEvents`, at the store layer. So the frontend can see plugin state changes live.
- The final state of a background job is given by `job-status.updated`. Changes to `_runtime_jobs` rows are used only to sync data.

**Payload**

- `operation` is `'set'` or `'delete'`. On delete, `value` is `null`.
- The payload has only two fields, `pluginId` and `changes`. The event does not carry the source of the write, the runtime, or the turn identifier.
- The client writes each change directly into its own copy of the plugin data (`applyChanges`), and does not read the API again. So `value` carries the full public value of that row.

**Public scope**

Events and REST reads use the same public shape:

- Changes to hidden world data (`_hidden.*`) are not sent.
- `_runtime_jobs` and dimension records carry only their public parts. They do not include a job's `payload`, raw errors, or dimension rules.
- A task queued with `expectsBackgroundFollower` also carries `phase: "prompt"`.

### Job progress events (job-status, experimental)

| Event type           | Dir. | Description                                  | Payload (full `JobStatusRecord`)                                                                                                                                                                                   |
| -------------------- | ---- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `job-status.updated` | S→C  | Progress of a long-running job (append-only) | `{ sessionId, progressScopeId, pluginId, runtimeId, jobId, state, progress?, message?, data?, sequence, createdAt }`; the `data` of a staged detached job holds `{ originTurnId, durableStatus, reason?, error? }` |

**How a plugin reports progress**

A long-running function runtime (for example, one that generates media) can call this before its final commit:

```ts
ctx.progress.report({ jobId, state, progress?, message?, data?, sequence })
```

- The report is written to the kernel's job-status store. It is append-only, and it is de-duplicated by `(sessionId, progressScopeId, pluginId, runtimeId, jobId, sequence)`.
- The event is sent right after the write succeeds, and it is forwarded through the `/actions` SSE.
- The values of `state`: `queued | running | progress | waiting-input | succeeded | failed | cancelled`.
- The kernel fills in all identity fields. The plugin supplies only the job's business fields.

> [!NOTE]
> This is the **only live exception** to the rule that effects take effect only after commit. A progress report does not write game state, does not satisfy bindings and gates, and is not rolled back with the domain transaction.

**Cleanup at the end of an execution**

When an execution ends, the framework handles the jobs that this execution reported, based on the final saved result:

- A job that has not finished gets a final state that matches the runtime's result.
- If the plugin already reported `succeeded`, but this execution's domain writes were not committed (the whole execution rolled back, this runtime failed, or its writes were discarded on their own at commit time), the framework appends a `failed` entry and does not keep the success state.
- A `failed` or `cancelled` that the plugin reported itself is not rewritten.
- The jobs of a suspended runtime stay in `waiting-input`. They belong to the execution that suspended: they become `succeeded` once a resume commits, `cancelled` when the suspended item is abandoned, expires or is voided, and keep waiting while a failed resume can be retried.

**How background job states map**

The staged detached worker also reports its persistent state with this event:

| Persistent state (`data.durableStatus`)       | Public `state` |
| --------------------------------------------- | -------------- |
| `queued`                                      | `queued`       |
| `claimed` / `running`                         | `running`      |
| `committing`                                  | `progress`     |
| `succeeded`                                   | `succeeded`    |
| `cancelled`                                   | `cancelled`    |
| `failed` / `timed_out` / `stale` / `orphaned` | `failed`       |

`data.originTurnId` lets the web app attach a background job to the turn that created it, instead of to the background execution's own `backgroundTurnId`.

**Rules for client merging**

- For control events about the same persistent job, the web app compares `sequence`. A duplicate or older state does not overwrite a newer one. A final state read during recovery is also not undone by an old queued notice.
- In the control channel, `progressScopeId` and `jobId` are both the ID of this persistent job.
- A plugin's sub-progress is linked to its parent job through `data.runtimeJobId`, but it has its own separate sequence numbers. It cannot be compared with the parent's sequence, and it cannot undo the parent's final state.
- A retry with a different `jobId` can start over.
- If a plugin reports succeeded and then, because the commit failed, reports failed, the last event wins.
- A persistent record read during recovery has no control sequence number. When merging, the sequence numbers already seen are kept.
- The `queued → claimed → running → committing` order of one job cannot go backward. A recovery read can move the phase forward, or fill in a final state. If a control event arrives during recovery, the final merge follows these same rules.
- The web app uses the persistent job's `backgroundTurnId` to attach the reasoning of a recovered worker to the task of the turn it came from. The worker has its own trace ID. That ID must not create another turn the player can see, and it must not create a "job interrupted" notice. Trace and job recovery can arrive in either order. The state and failure details come from the persistent job. When recovery runs more than once, the reasoning is not duplicated.

> [!NOTE]
> This channel coexists with the framework's reserved namespace `_runtime_jobs`. Both manual / event `execution: background` and staged `turnCompletion: detached` are recorded there. `job-status.updated` is the live display and recovery mechanism for them. It cannot replace the transaction for domain results.

### Background tasks (reserved namespace `_runtime_jobs`)

Every background runtime uses `_runtime_jobs/<jobId>` as its reliable source of state. There are three origins:

| `origin.activation` | Origin                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `"stage"`           | A scheduled job with `turnCompletion.mode: detached`                                                                           |
| `"manual"`          | A plugin-rpc `execution: background`, or a manual activation with `expectsBackgroundFollower`                                  |
| `"event"`           | A follower with `execution: background` in an event chain, queued in the commit transaction of the execution that triggered it |

- Plugins cannot write to this namespace.
- The queued record is saved in the same transaction as the original turn's proposals, journal, and session clock.
- A worker claims a job and renews its lease through `compareAndSetPluginData`. This stops several pods from running the same job, and stops a late result from bringing a job back to life.

| Durable status        | Meaning                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued`              | Committed with the original turn, waiting for a worker. After `maxQueueMs` it becomes `timed_out`                                                                                                                                                                                                                                                                                       |
| `claimed` / `running` | A worker has the CAS lease, or is running it. The same session/plugin/runtime stays serial                                                                                                                                                                                                                                                                                              |
| `committing`          | It passed the owner CAS, and it is running the stale and effect guards and the domain commit inside the session lock                                                                                                                                                                                                                                                                    |
| `succeeded`           | The background proposals are committed, and `result` holds the summary of the background turn, execution, and runtime                                                                                                                                                                                                                                                                   |
| `failed`              | The execution, the effect guard, or the domain commit failed. `reason/error` is the authoritative cause. For a manual or event activation, when the runtime reports its own failure (`runtime-reported-failure`) or the expected follower is not emitted (`follower-not-emitted`), the domain writes of that execution and the failed final state are committed in the same transaction |
| `timed_out`           | Queued longer than `maxQueueMs`, or the runtime ran longer than `maxExecutionMs`. The time spent waiting for the session lock after the execution returns does not count. A late execution can no longer enter committing                                                                                                                                                               |
| `cancelled`           | A final state set by a control-plane cancel. It cannot go back to active or accept a late result                                                                                                                                                                                                                                                                                        |
| `stale`               | The session is inactive, or the session/plugin incarnation or version has changed. The commit barrier rejects the result with `reason: commit-barrier-rejected`                                                                                                                                                                                                                         |
| `orphaned`            | The owner in flight stopped renewing and the lease expired. If the owner itself keeps failing to renew until the lease expires, it immediately aborts the running execution and lands in this state                                                                                                                                                                                     |

**Recovery at startup**

- A `queued` job that has not passed its queue deadline and has never been claimed continues to run.
- A job whose queue time has run out ends as `timed_out`.
- A `claimed` / `running` / `committing` job whose lease has expired ends as `orphaned`.
- These final states are **never replayed automatically**. The reason: the provider may already have charged for the call, and only the answer was not saved. A replay would charge twice.

**Checks before the commit**

- Confirm again that the session is still active, and that the session generation, the plugin's authorization scope, and its version have not changed.
- Check the actual proposals against the isolated effects allowlist in the manifest.
- The domain result and `succeeded/result` are saved in the same transaction. If the transaction rolls back, no "successful" task is left behind.
- If a notification fails after the transaction, it does not change the task's success state, and it does not open a retry.

**Retention and maintenance**

- Each runtime in each session keeps only its latest 20 final jobs. The worker deletes older records during reconciliation.
- In a job description, only the upstream outputs this runtime declares as dependencies are kept in full. Other upstream entries keep only their identity and status, and do not copy tool call records.
- `_runtime_jobs` is not included in snapshots or forks, and the framework controls writes to it. The existing rules for how plugin stores read reserved namespaces still apply.
- Recovery scans handle only expired leases whose revision did not change during the scan.
- The worker recovers expired jobs when it first wakes up, and then in maintenance every 30 seconds. After a failure it retries after 1 second.
- A `committing` job must first take the non-blocking session commit lock. If the lock is busy, the job is deferred.
- Maintenance does not take up execution capacity. On shutdown it waits for the actual scan and lock callbacks to exit.

> [!NOTE]
> If you later extend the states, or add overlap or stalePolicy, you must upgrade the schema version, the legal state transition graph, the SSE state mapping, and the client recovery logic together. There is currently no way to express a new policy with an old value.

**What is removed when reading**

Every HTTP read path for background tasks uses one public shape. These paths are: the dedicated runtime-jobs endpoint, the general plugin-data reads (all, by namespace, by key), and state.

- Removed: the frozen input `payload` and the raw errors.
- Kept: the job, its origin, the IDs linking it to the background execution, the current state, and the business result.
- `job-status.updated` also sends only known reasons, and fixed, safe error text grouped by state. The raw text of a provider or handler exception is never sent out.
- A queue timeout that has only a reason still shows an understandable failure message after the page reloads.

These rules cover only the HTTP and SSE exits. Internal task errors, ordinary game results, direct reads by plugins, and other trace and log channels each have their own conventions. This does not mean that all logs and game content are redacted.

**What the client can do**

| Operation | Endpoint                             | Rules                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recover   | `GET /api/sessions/:id/runtime-jobs` | Returns the state and any successful result. The internal `payload`, which holds frozen input, settings, and approval identity, is removed from the answer                                                                                                                 |
| Cancel    | `POST .../:jobId/cancel`             | Accepts only `queued` / `claimed` / `running`, and writes `cancelled` with CAS. A job that is already in `committing` or a final state returns a conflict                                                                                                                  |
| Retry     | `POST .../:jobId/retry`              | Accepts only failure-type final states. It explicitly creates a new `jobId` and a queued record, using the current session generation, authorization scope, locale, and runtime model overrides. The old final state does not change, and it is not replayed automatically |

Subtask messages from a plugin that a detached runtime emits through `ctx.progress` are linked by the kernel, which appends an unforgeable `runtimeJobId` and `originTurnId` to `data`. The client uses these to fold the message under its parent task, so no separate orphan status line appears.

### Media asset events

When an image generation plugin finishes, it outputs the result as `assetGenerations[]`. The runtime turns each item into an `asset.generate` proposal, and after the commit it is written to the trace and sent over SSE.

```ts
type AssetGeneration = {
  ref: MediaRef;
  modality: string; // e.g. "image", "audio", "video", "file"
  meta?: Record<string, unknown>;
};
```

Progress during generation uses another event, `asset.progress`. A function runtime calls:

```ts
ctx.assetProgress({ phase, percent, assetId, modality, message, meta });
```

The server writes it to the trace, and forwards it over the `/actions` SSE. The range of `percent` is `0..100`. The asset that is finally saved still goes through the `asset.generate` commit path, via `assetGenerations[]`.

| Event type        | Dir. | Description                                                 | Payload                                                                                  |
| ----------------- | ---- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `asset.progress`  | S→C  | Progress of multimodal generation                           | `{ runtimeId, pluginId, turnId, assetId?, phase, percent?, modality?, message?, meta? }` |
| `asset.generated` | S→C  | An asset is complete and committed through `asset.generate` | `{ proposalId, runtimeId, pluginId, asset: AssetGenerateView }`                          |

**Rules**

- `ref` must come from `ctx.media.put()` or `ctx.media.ingestUrl()`.
- A provider's wire layer may briefly receive `b64_json`, a temporary remote URL, or raw bytes from an SDK. Before returning, the handler must store them in the MediaStore. After that, it exposes a `MediaRef` only through `assetGenerations[]` and its business index records.
- An image gallery plugin can still keep a query index in `plugin_data.images`. Index values look like `{ status, ref, prompt, ... }`. The `Image` and `Media` components take a `MediaRef`, and the framework resolves it to a URL for display.

**Two errors**

| Error code                                | When it appears                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `image.generate.asset_missing`            | An asset runtime declared by the enabled `media.image-flow@1` extension finishes without `assetGenerations[]` |
| `image.generate.plugin_data_inline_media` | A `url` / `base64` / `dataUrl` field appears in `plugin_data.images`                                          |

The framework does not build an `asset.generated` event from these inline fields.

### LLM content parts

`TextMessage.content` in `@covel/ai-provider` has three forms:

| Form            | Use                                                                                          | Lifetime       |
| --------------- | -------------------------------------------------------------------------------------------- | -------------- |
| `string`        | Fast path for plain text messages                                                            | Kept long-term |
| `null`          | Messages where the provider allows empty content, such as an assistant tool call             | Kept long-term |
| `ContentPart[]` | Multimodal message path: `{ type: "text", text }` and `{ type: "image", image, mediaType? }` | Kept long-term |

**Image part**

Its shape matches the part of the same name in the Vercel AI SDK:

- `image` is a string. It can be plain base64, a `data:` URL, or an `http(s)` URL.
- `mediaType` is the MIME type. When plain base64 does not set it, the type is detected from the file header (PNG, JPEG, GIF, WebP). If it cannot be detected, it defaults to `image/png`.
- The provider layer only encodes what it receives into each vendor's format. It does not download anything, and it does not read the MediaStore.
- When the framework sends an image itself (see [Prompt structure reference: shown images](./prompt-structure.md#images-that-have-been-shown)), the runtime reads the bytes from the MediaStore and passes them as plain base64 plus `mediaType`. Before that point, the kernel internally uses `{ type: "media", ref: MediaRef }`. This kind of part never reaches the provider layer.

**How each protocol sends images**

| Provider path                     | Inline data (base64 / data URL)                                     | `http(s)` URL                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Chat                       | `{ type: "image_url", image_url: { url: "data:<mime>;base64,…" } }` | Same shape, with `url` set to the original URL                                                                             |
| OpenAI Responses                  | `{ type: "input_image", image_url: "data:<mime>;base64,…" }`        | Same shape, with `image_url` set to the original URL                                                                       |
| Anthropic Messages                | `{ type: "image", source: { type: "base64", media_type, data } }`   | `{ type: "image", source: { type: "url", url } }`                                                                          |
| Gemini native                     | `{ inlineData: { mimeType, data } }`                                | Only an uploaded Google file URI, converted to `fileData` (needs `mediaType`). Other URLs are rejected with `CONFIG_ERROR` |
| Gemini OpenAI-compatible endpoint | Follows the OpenAI Chat shape                                       | Follows the OpenAI Chat shape                                                                                              |

[Google's native image input notes](https://ai.google.dev/gemini-api/docs/image-understanding) distinguish inline data from file references.

**When a model does not accept images**

- When the target model is known to accept only text (no `image` in the model table or in `input` of `llm.toml`), image parts in the request are removed before encoding. A message that held only an image becomes the text `[image]`.
- A model with unknown capabilities is left alone, and the provider decides whether it accepts images.
- There is one exception for fallback: the preferred model for the role is known to accept images (which is why the caller attached them), but this call fell back to another model. In that case the fallback model receives images only if it is known to accept them. A fallback model with unknown capabilities receives only text.
- When deciding whether a fallback model can fit the request, one image is counted as 1,600 tokens, not by its base64 length.
- In the request body recorded to the trace, inline image data longer than 4,096 characters is replaced with a sentence stating its length, and that request's `complete` is `false`.

### Gemini native text protocol

`google-generative-ai-v1` calls Google's `generateContent` / `streamGenerateContent`.

**Supported**

- Text, structured objects, and streamed text generation.
- Sending image input and function declarations.
- The built-in address of the `google` provider is `https://generativelanguage.googleapis.com/v1beta`, and the key is taken from `GOOGLE_API_KEY`. In the settings screen you can choose the "Google Gemini" protocol.
- `generateObject` uses `generationConfig.responseMimeType: "application/json"` and `generationConfig.responseJsonSchema`. After the response comes back, Covel's Zod schema still validates it.

**How usage is counted**

- Thinking tokens in the model's `usage` count toward output tokens.
- The reported cached tokens are part of the input tokens. They must not be added to the total input again.

**Not implemented**

Google's embedding, native image or audio generation, File API upload, and grounding tools. The model catalog says these capabilities are supported, but the text adapter does not get the matching wire automatically.

For Gemini native thinking effort, `providerOptions.google.thinkingConfig`, `cachedContent`, `seed`, and how it differs from the OpenAI-compatible endpoint, see [model role configuration](./slots.md#thinking-strength) and the [Google thinking docs](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

### Suspend / Resume events

| Event type       | Dir. | Description                                                                                                                                                                                                   | Payload                                                     |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `turn.suspended` | S→C  | The runtime creates a suspension artifact. It is sent only after `finalizeExecution` commits the record together with the writes of the same execution. On a rollback, no record is kept and no event is sent | `{ sessionId, turnId, suspensionId, reason, resumeSchema }` |
| `turn.resumed`   | S→C  | Sent by the route after the `resume` action on the suspension resource succeeds                                                                                                                               | `{ sessionId, turnId, suspensionId }`                       |

### Snapshot / Fork events

The server broadcasts all snapshot events through the eventBus (the topic is `session`). The SSE named event type comes from `_subType` in the payload.

| Event type               | Dir. | Description                                                                                                                                                                 | Payload                                                                         |
| ------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `state.snapshot.created` | S→C  | A new snapshot has been written. Sent by the turn executor (auto) and by the snapshots routes (manual / fork)                                                               | `{ turnId, snapshotId, kind: 'auto' \| 'manual' \| 'fork', parentSnapshotId? }` |
| `session.forked`         | S→C  | Sent by the snapshots route after `POST /api/sessions/:id/fork` successfully materializes the child session. The fork also sends one `state.snapshot.created` (kind='fork') | `{ parentSessionId, childSessionId, fromSnapshotId, forkSnapshotId }`           |

Where each event is emitted:

| Trigger path                             | Event sequence                                          | Source                                            |
| ---------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| Captured after `commitExecution` commits | `state.snapshot.created` (kind=auto)                    | `packages/runtime/src/commit/commit-execution.ts` |
| `POST /api/sessions/:id/snapshots`       | `state.snapshot.created` (kind=manual)                  | `apps/server/src/routes/api/snapshots.ts`         |
| `POST /api/sessions/:id/fork`            | `state.snapshot.created` (kind=fork) → `session.forked` | `apps/server/src/routes/api/snapshots.ts`         |

> [!NOTE]
> The bundled web app currently has no UI for snapshot or fork operations. External clients can receive the events above from the `session` topic.

**Committed interactions also go through the subscription channel**

A committed `interaction.requested` and `ui.rendered` are also pushed through the `state` topic, with `block` and `turnId`. So an interaction produced by a manual or background runtime shows up without a refresh.

- It is published only after the whole execution transaction succeeds. A rollback publishes nothing.
- The client merges by `block.id`, so the action SSE and the subscription (or event replay) do not produce duplicate messages.
- After a disconnect, recovery still relies on the session view.

### World model, plugin memory, and context compaction events

- `character-schema.changed` is sent after `character.schema.set` commits. Its payload is `{schema: CharacterSchemaRecord}`.
- `character.upserted` carries `{character}`.
- The client updates characters and field definitions from domain records. It does not read a plugin's data mirror.

**Plugin memory**

- Plugin memory, like other plugin data, sends `plugin-data.changed` after it commits. Which content is updated is decided by the owning plugin's namespace. There is no separate "working memory changed" event.
- The success and failure states of a detached extraction are recovered through the general job and execution records.
- Later executions read the committed snapshot after the `before-next-execution` barrier.

**Events that go only to the trace**

- `context.compacted` is written only to `trace_events`. It is written by the history compaction orchestration, and it is not in `CovelEvent`. The summary strategy is provided through the `history.compact@2` extension.
- `recursive.calling/completed/failed` are in `CovelEvent`, but they are delivered only through the `trace` subscription topic. They are not forwarded to `/api/actions`.

| Event                           | Trigger point                      | Payload                                                                                                                                 |
| ------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `character-schema.changed`      | Domain schema commit               | `{schema}`                                                                                                                              |
| `character.upserted`            | Domain character commit            | `{character}`                                                                                                                           |
| `dimensions.changed`            | Dimension batch commit             | `{providerPluginId, dimensions, settlement?}`                                                                                           |
| `dimensions.settlement.changed` | Receipt commit                     | `{providerPluginId, source, sourceTurnId, version, status, error?}`                                                                     |
| `plugin-data.changed`           | Commit of the owning plugin's data | pluginId, namespace, and the affected keys                                                                                              |
| `proposal.failed`               | Proposal commit failure            | `{proposalId,proposalType,runtimeId,pluginId,error}`                                                                                    |
| `context.compacted`             | Compaction summary saved           | `{summaryId,summaryIds,messagesCompacted,tokenSavings,focusSections,summariesMerged,summaryTokens,totalSummaryTokens,summaryTruncated}` |

A failed commit holds back the "execution completed" step, and the client shows the error as an execution failure. A background result cannot reopen an action stream that has already ended. On reconnect, the client restores from the saved session state.

### SSE frame format by channel

| Channel                  | Frame shape                                                    | How the client subscribes                                                                                                                                                                                                       | File                                               |
| ------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `POST /api/actions`      | data-only (`data: <SseEnvelope JSON>`, **no `event:` header**) | `fetch()` + `ReadableStream`. Scan the `data:` lines, parse the JSON, then check `envelope.type`                                                                                                                                | `apps/web/src/services/api/actions.ts: sendAction` |
| `GET /api/events/stream` | Named events (`event: <type>\ndata: <ProtocolEvent JSON>`)     | `fetch` reads the stream (`readSseStream`) and dispatches by the `event:` header. An event with no handler is silently dropped. `EventSource` with a query-string token is used only by clients that cannot set request headers | `apps/web/src/services/subscription.ts`            |

**How a subscription stream connects**

1. When the connection opens, the server first sends `system.connected`.
2. After that, it sends `system.heartbeat` every 30 seconds.
3. Send the reconnect cursor in the `lastEventId` query parameter or the standard `Last-Event-ID` request header. The query parameter takes precedence when both are present. If the cursor epoch is still valid, the server replays cached EventBus events with a sequence greater than the cursor seq before switching to live events. If replay cannot bridge the cursor, it sends `system.reset`.

The data of `system.connected` has a `cursor`. It is the latest event ID this session has emitted at this moment (`${epoch}:${seq}`. If no event has been sent yet, seq is 0).

- A client that has no cursor yet records it as its `lastEventId`. So even if the client received no event on this connection, the next connection (for example, resuming the subscription after an action ends) can catch up on the events it missed.
- A client that already has a cursor ignores it.

**Which topics you can subscribe to**

- The topics accepted by `/api/events/stream` are defined by `SUBSCRIPTION_TOPICS` in `@covel/shared`: `runtime / state / game / plugin / session / store / system / trace / hooks / job`. `VALID_TOPICS` in `subscribe.ts` is generated from it.
- `trace` (from TurnEmitter) and `hooks` (from the hook pipeline) are internal observation topics of the runtime. `job` carries `job-status.updated`.
- `apps/web/src/services/subscription.ts` subscribes by default to `runtime / state / game / plugin / session / system`. It does not include `store`. To recover background tasks, the session store subscribes to `job` explicitly as well.
- The client dispatches by `event.topic`. When you add a new topic or event, **you must update this file at the same time**.
- In-turn events on `/api/actions` (`narrative.delta` / `narrative.completed` / `interaction.requested` / `plugin-data.changed`, and so on) are handled by the callback of `sendAction`. They do not go through `subscription.ts`.

**Authentication**

- When `DEPLOYMENT_TIER=demo|commercial`, the subscription endpoint always requires the session owner's token.
- `self` (the default) usually does not enforce it. But when `NODE_ENV=production` and the storage backend actually in use is MemoryStore, it is enforced too. The check uses the backend that is really injected, not only the value of the `STORE_BACKEND` environment variable.
- The bundled web app uses fetch-based SSE and sends `X-Session-Token`. A native `EventSource` client can use `?session_token=<ownerToken>`.
- If the token is missing or wrong, the server returns `401 { code: "session_owner_required" }`.

For details, see the authentication section of [api.md](./api.md).

**Connection and write limits**

Each connection on `/api/actions` and `/api/events/stream` has a bounded queue that writes in order:

| Limit                                                                               | Value                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------- |
| Frames in the queue, being written plus waiting to be written                       | At most 256, with only one actual writer |
| Maximum wait for a single write, for draining the queue at the end, and for closing | 2 seconds each                           |
| Subscription connections per session                                                | 8                                        |
| Subscription connections for the whole process                                      | 512. Going over returns 429              |

- After a queue overflow, a write error, or a timeout: no new frames are accepted, writes that have not started are dropped, and the connection is aborted. The server does not start a replacement after a write gets stuck.
- The connected, replay, reset, and heartbeat frames of a subscription stream are subject to the same limits.
- Listeners, pins, heartbeats, and the connection quota are released during cleanup.

**The action stream and business execution do not slow each other down**

- For each frame in the action stream, the seq, the turn and trace identity, and the payload are fixed at the moment it is queued. Accepted frames are written out in queue order.
- The execution and commit callbacks inside the business lock only queue frames. They do not wait for the client to finish reading. The final drain happens outside business ownership.
- A closed or lost SSE is not treated as a business execution failure. It does not undo committed content, does not call the model again, and does not open a replay for recovery. The client should recover through read-only execution and session state.

**Recovery after the stream drops (web app)**

- After the web app gets a reset or reconnects, it refetches, checking revisions: the session snapshot, the plugin list, the data for every enabled plugin, unresolved suspensions, and the world. Live events that arrive during this are buffered first, and replayed afterwards.
- The streamed placeholder is replaced with the saved final narrative for the same `turnId/runtimeId` only when the access generation and execution ownership still match. The external text of that placeholder and its pending fragments are removed. A new, healthy POST stream still owns its own live output.
- After an error or stream loss, only authoritative recovery confirming a failed or interrupted turn without matching saved prose moves the displayed text to an “Unsaved” area and clears its placeholder and streaming buffers. This local copy lasts until leaving the session and never enters story history, stage content or plugin data. A retry appears beside it when recovery supplies an action. Unknown network state does not enable retry; saved prose still replaces placeholders as above. Player aborts and normal `committed: false` keep their existing removal behavior.
- If the most recent window of the recovered snapshot does not join up with the history already loaded, the client first fills in older messages through the existing message pagination endpoint, read-only, up to the old anchor, and then merges and publishes. It does not delete the old window, and it does not resend the action.

**For hosts that embed `@covel/events`**

`createEventBus(store?, options?)` needs only an optional `EventStore`. It has two async methods: `saveEvent(record)`, and `getEventById(sessionId, id)`, which is isolated per session.

- The record type `EventStoreRecord` is exported with the package. An existing DataStore can be passed in directly. A standalone host does not have to implement other database methods.
- Persistence is a bounded, best-effort audit queue. `flush()` waits for the queue to drain, but it does not guarantee that the transport has delivered.
- For a very large transport frame, after a successful save, only a reference is sent. The receiver reads the content from the same store.

Transport frames between processes require a nonempty `stream` identifying the sender generation. Frames without it are rejected; upgrade and restart all publishers together. Trace event payloads are read as flat objects: a nested `data` field is ordinary data and is never merged into the envelope. Old nested traces must be regenerated for the current debug view.

#### Event ID format: `${epoch}:${seq}` (H-05/H-06)

The `id` of each subscription event is `${epoch}:${seq}`. It is both the `id:` line of SSE and the `lastEventId` cursor used on reconnect.

- `seq`: a sequence number that increases monotonically within each session.
- `epoch`: a string generated **each time** the server's replay state for this session is (re)created. After a process restart, or after the state is cleared by LRU/TTL and rebuilt, the epoch is new. The client only checks whether it is **equal**, and does not parse its content. If the epoch has changed, the cursor is no longer valid and must be reset.

Parse it with `parseSubscriptionEventId(id) → { epoch, seq } | undefined` from `@covel/shared`. An ID that is only digits parses to `undefined`, and the server always answers it with `system.reset`.

**Pins and capacity**

- While a subscription is still connected, the replay state for this session is "pinned". It is not cleared, and its epoch does not change.
- The EventBus `MAX_TRACKED_SESSIONS` (currently 256) is the target capacity for replay state that can be cleared. It is not a hard limit on active subscriptions.
- A pin is registered before capacity cleanup. When every state has an active pin, the count may temporarily go over this target, including for a 257th different session.
- After the last pin is released, the state can be cleared by LRU/TTL again. Later access or capacity pressure triggers the cleanup. Releasing the pin does not clear it right away.
- The number of connections is still limited by the SSE quota above.

#### The `system.reset` control frame (H-05)

When a client reconnects with `lastEventId`, and the server cannot continue from that cursor, it **does not send a partial replay**. It sends a `system.reset` named event **without an `id:` header**. After receiving it, the client does two things before it continues to receive live events:

1. Replace its local cursor (`lastEventId`) with the `cursor` in the frame.
2. Fetch the authoritative state again.

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

When it is sent:

| `reason`           | When it happens                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"epoch-change"`   | The cursor's epoch differs from the current one. This includes a new epoch after the state was cleared or the process restarted, and an old-format cursor that cannot be parsed                                                |
| `"gap"`            | The epoch is the same, but the ring buffer has moved past the cursor (`afterSeq` is earlier than `oldestSeq`), or the cursor's seq is larger than `latestSeq`                                                                  |
| `"transport-gap"`  | Across pods, the transport finds that a range of sequence numbers is really missing, or a large event reference already received cannot be restored (the record does not exist, the read failed, or the receiver has no store) |
| `"publish-failed"` | The committer has already saved the data, but publishing the event after the commit failed                                                                                                                                     |

Details of `transport-gap`:

- Each `(origin, session, stream)` is checked starting from `seq=1`. If the first frame of a new stream is greater than `1`, or the first frame after the receiving state was evicted is greater than `1`, it is handled as a gap.
- After the events before the faulty frame are delivered, and before the events after it are delivered, the local replay buffer is cleared and gets a new epoch. Every connected client receives the reset and reconnects.
- The receiver keeps state only for the current stream of each `(origin, session)`. When the sender starts a new stream, the old stream's state is reclaimed; if events of the old stream are still waiting for an earlier frame, they are delivered first, with a reset.
- There are at most 1024 receiving states. When full, the state that has gone longest without a frame and has no waiting events is evicted first. If every state has waiting events, the one that has gone longest without a frame is evicted after its waiting events are delivered, with a reset.
- The sender holds at most 256 frames per session waiting to be sent. When the transport stops returning and that number is reached, new frames are dropped with a warning. When the receiver gets a later frame, it sees the missing range and resets as for a gap.

Details of `publish-failed`:

- After the transaction commits, `finalizeExecution` and the session commit pipeline run each buffered publish one by one. A failed publish does not roll back the data.
- The server writes the trace event `commit.fanout.failed` (`{ failedCount, totalCount, errors }`, `forwardToActionStream: false`, visible on `/debug`).
- Then it clears this session's replay state and gets a new epoch. Connected subscription streams receive the reset, reconnect, and read everything again.
- The `POST /api/actions` stream that triggered this turn still closes normally with `execution.completed`, and it carries `resync: true`.

Like `system.connected` and `system.heartbeat`, this frame **has no `id:` header**. So it does not change the `lastEventId` of `EventSource`.

### Forwarded runtime internal events (`/api/actions` forwards them, included in `CovelEvent`)

The events below are forwarded by the server through the actions SSE stream. They are used for debugging and tracing.

- They are members of `CovelEvent`, and `COVEL_EVENT_META` marks them `forwardToActionStream: true`.
- The server's forwarding allowlist, `FORWARDED_EVENT_TYPES`, is **generated** entirely from this metadata. It is not a hand-written set.
- The web app's actions handler explicitly does nothing with these types. They drive the `/debug` timeline through the subscription channel. Because they are in the union type, when you add a similar event, the frontend's exhaustiveness check forces you to decide whether to handle it or ignore it.

| Event                                                      | Source                                                                                       | Use                                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.skipped`                                          | `apps/server/src/routes/api/actions.ts`                                                      | A runtime was skipped because of cooldown / startTurn / maxTriggerCount                                                                                    |
| `character.upserted`                                       | `packages/runtime/src/commit/session-commit-emitter.ts` (`character.upsert` proposal commit) | Character snapshot event                                                                                                                                   |
| `tool.calling` / `tool.completed` / `tool.failed`          | TurnEmitter                                                                                  | LLM tool call trace                                                                                                                                        |
| `domain-event.previewed`                                   | ToolExecutor (after `emittedEvents` succeeds)                                                | Projected server-side into UI slot previews; not consumed directly by the frontend and not a domain commit |
| `llm.calling` / `llm.responded` / `message.completed`      | TurnEmitter                                                                                  | LLM call trace                                                                                                                                             |
| `block.emitted` / `state.patch.applied`                    | TurnEmitter                                                                                  | Trace of a block emitted / a state patch applied                                                                                                           |
| `hook.fired` / `hook.aborted`                              | TurnEmitter                                                                                  | Hook behavior trace                                                                                                                                        |
| `gateway.calling` / `gateway.responded` / `gateway.failed` | TurnEmitter (`withGatewayTrace`)                                                             | Trace of a function-runtime or extension-provider `ctx.gateway` provider call (equivalent to `llm.*`); a failure carries the `usage` the provider reported |

`runtime.skipped` is written into the stream by the actions route itself. Its `forwardToActionStream` in the metadata is `false`.

The other events described in this page are also marked as forwarded: `ui.rendered`, `asset.progress`, `world.dimensions.changed`, `plugin-data.changed`, `character-schema.changed`, `dimensions.changed`, `dimensions.settlement.changed`, `ui.slot.changed` / `ui.slot.preview` / `ui.slot.cleared`, `turn.suspended` / `turn.resumed`, and `job-status.updated`.

**Internal events not forwarded to `/api/actions`**

These are written only to `trace_events`, and are delivered through the subscription channel to drive `/debug`:

| Event                                                                  | Description                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hook.rewrote`                                                         | A hook rewrote the content                                                                                                                                                                                                                                                                                                                                                                              |
| `function.executing` / `function.completed`                            | The start and end of a function-runtime handler (TurnEmitter). Same kind as `recursive.*`                                                                                                                                                                                                                                                                                                               |
| `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` | HTTP calls to a provider made through a plugin's own wire (`ctx.utils.fetchWithRetry`, the path an image generation plugin takes. Wrapped by `withUtilsTrace` where function-runtime / agent-guard injects it). Polling can be very frequent, so these do not go into the action stream. The payload has only host / method / status / durationMs, and **never contains a full URL, query, or API key** |
| `context.pruned`                                                       | Emitted when the prompt is first assembled, after `PostContextAssembly` rewrites it, or when the actual request of one step of the tool loop triggers a hard budget trim. The payload is `{ runtimeId, pluginId, prunedMessageCount }`. The same runtime can emit it several times in one turn. It lets `/debug` show which step dropped history                                                        |
| `context.compaction.failed`                                            | Emitted when a history compaction attempt fails. The payload is `{ pluginId, extensionId, reason, consecutiveFailures }`                                                                                                                                                                                                                                                                                |
| `commit.fanout.failed`                                                 | See the section on the `system.reset` control frame above                                                                                                                                                                                                                                                                                                                                               |

Additional notes:

- Each time history compaction fails three times in a row, the same turn also sends one more `job-status.updated` (`state: "failed"`, with a `message` written for the player in the session's language). It reuses how the execution timeline shows failed tasks.
- If the protected tail, the compaction summary, the tool schemas, and the answer schema alone already do not fit the budget, the runtime fails clearly before it calls the provider.

**Runtimes with hidden content**

For a runtime that declares `io.concealed: true`, its TurnEmitter events keep only fields without content before they are saved and forwarded, and they carry `concealed: true`:

- Kept: `runtimeId`, `pluginId`, `toolName`, `toolCallId`, `status`, `durationMs`, `usage`, `finishReason`, `seq`, and so on.
- Removed: content fields such as `messages`, `text`, `toolCalls`, `arguments`, `result`, `parsedResult`, and `output`.

## 2. Command types (CommandType)

The names in the "Command" column of the tables below (`session.create`, `turn.submit`, and so on) are only labels this document gives to requests, to make them easier to refer to. The code has no identifiers with these names, and no `CommandType` type. A request is identified by its "method + endpoint" and its `type` field.

### Session management

| Command           | Method | Endpoint                 | Response                |
| ----------------- | ------ | ------------------------ | ----------------------- |
| `session.create`  | POST   | `/api/sessions`          | JSON: `SessionRecord`   |
| `session.restore` | GET    | `/api/sessions/:id/view` | JSON: `SessionSnapshot` |
| `session.delete`  | DELETE | `/api/sessions/:id`      | JSON: `{ deleted }`     |

The top-level `dimensions` of `SessionSnapshot` is the [public snapshot of current values](./world-model.md#dynamic-dimension-snapshot). The optional `dimensionSettlements` is a summary of receipts. The provider and recovery metadata is bound and validated by the host.

> [!WARNING]
> The old raw dimension format is not compatible. Affected development-time worlds, sessions, and snapshots must be rebuilt.

### Turn execution (SSE streamed response)

The `type` values `/api/actions` accepts form a closed set, defined by `actionRequestSchema` in `packages/shared/src/schemas/api-contract.ts` (the server validates them with `validateActionRequest`):

| Command          | Method | Endpoint                                       | Response                  |
| ---------------- | ------ | ---------------------------------------------- | ------------------------- |
| `turn.submit`    | POST   | `/api/actions` `type: "send_message"`          | SSE: ProtocolEvent stream |
| `turn.cmd`       | POST   | `/api/actions` `type: "execute_command"`       | SSE: ProtocolEvent stream |
| `turn.start`     | POST   | `/api/actions` `type: "start_session"`         | SSE: ProtocolEvent stream |
| `turn.retry`     | POST   | `/api/actions` `type: "retry_turn"`            | SSE: ProtocolEvent stream |
| `runtime.retry`  | POST   | `/api/actions` `type: "retry_runtime"`         | SSE: ProtocolEvent stream |
| `runtimes.retry` | POST   | `/api/actions` `type: "retry_failed_runtimes"` | SSE: ProtocolEvent stream |

Add `submit_interaction` from [Interaction responses](#interaction-responses) and there are seven in total. Any other value returns 400 `Unsupported action type`. To emit an event from a plugin, use the built-in `emit-event` tool.

Each frame in the stream is wrapped in a `SseEnvelope`. See "4. SSE envelope format" below.

**`start_session`**

It requires the session to already have a non-empty `activePlugins` (chosen when the session is created). An empty set returns 400 right away. It does not turn into "enable all registered plugins". See [api.md](./api.md#post-apiactions) for details.

**`retry_turn`**

- A normal request's payload is empty. It uses an empty player input and the current committed context to start a new main-loop turn. After the submission succeeds, the player's turn count goes up by one.
- It does not resume or regenerate historical turns.

**Recovering an unfinished turn**

- Each of the six actions in the table above can add `payload.recoverFromTurnId`. It must match the original action description the server returns.
- The client reads read-only state from `GET /api/sessions/:id/execution`. Refreshing the page does not resubmit the action. The new requestId is sent only after the player explicitly clicks retry.
- Recovery polls every 3 seconds after success. Failures wait 3, 6, 12, and 24 seconds, then at most once every 30 seconds; success resets the delay. Status requests do not add HTTP retries. Polling pauses while hidden and checks immediately on becoming visible, without overlapping reads for the same observation.
- The server checks the source turn inside the session lock. An opening recovery keeps the source of the continuation, and does not increase the player's turn count.
- Before it sends the answer, the execution-state query rechecks the authenticated session generation. If the session was deleted during the query, or rebuilt with the same ID, it returns `409 session_incarnation_changed`, instead of treating the new session's retry input as its own. This read-only check does not wait for a long turn that is running, and it does not resubmit the action automatically.

**`retry_runtime`**

- `payload.runtimeId` must be provided.
- An explicit `retryFromTurnId` must point to an original turn that is committed and still belongs to the current story. The target must still be in the failed state.
- Without a source, it is handled as an ordinary manual call.

**`retry_failed_runtimes`**

- The `retryFromTurnId` of the original turn must be provided, along with 1–20 distinct `runtimeIds`.
- After the lock merges the recovery attempts already committed for this source, only targets that are still failed and still active can be re-run.
- The same action runs by stage / DAG and is committed as one unit. It does not count a new turn.
- Both batch recovery and single-task recovery with a source run only the selected targets. Event subscribers, recursion, and background dispatch are not allowed to widen the scope. Ordinary manual / plugin-RPC behavior without a source does not change.
- The original story and the non-target results that were committed successfully are used only as context. They are not committed again.
- If one target fails and another is skipped because it depends on the first, both remain waiting for recovery.
- If the whole turn was interrupted and there is no committed source, the original action should be recovered first. A "success" in the trace must not be treated as committed data.

**Traces and summaries during recovery**

- The lifecycle trace and SSE payload of each recovery carry `sourceTurnId` and this attempt's `runtimeIds`. `turnId` keeps the identity of this attempt.
- The client updates a task's recovery state only after a turn or execution final state with `committed: true`, or after it confirms a committed artifact. It keeps the original failure record. A transaction rollback or an interruption does not clear the original failure.
- If a batch operation is interrupted, the `retry` description keeps the same set of targets. The validation of `recoverFromTurnId` does not allow this set to change.
- The new scope also carries `sourceCommitted: true` and `sourceFailedRuntimeIds`, which the server has verified. Older traces may not have these two fields.
- The failure summary fully includes the IDs that are still failing in the source ledger, including inactive ones. It is not cut down to the limit of the selected targets.
- A summary sent during execution reflects the state before it started. Committed final states are settled according to the real result: successful ones are removed, and failed and skipped ones are kept. On a rollback or an interruption, nothing changes. An empty array is also sent.
- The client replaces the old set with the latest summary. Within the same attempt, a committed final state takes priority over an in-execution summary. This way, a trace snapshot with a limit does not miss tasks that have not recovered, and old failures do not come back.
- An ID missing from the summary does not mean there is a success step that can be shown. A success step still needs real execution and commit evidence.

**`payload.inputMessageId`**

`send_message` and `execute_command` can provide it. The flow is: the browser saves the player's input first, then sends its ID along with the action.

| Case                                                                                             | Result                                                                                                               |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| An uncommitted user record with the same ID and the same content exists in the same session      | The server takes it over in the final commit transaction, keeps the original timestamp, and writes `metadata.turnId` |
| The same input is submitted again in the same turn                                               | The original record is kept                                                                                          |
| The ID is already linked to another turn, the content does not match, or another session owns it | The submission fails                                                                                                 |
| There is no local record                                                                         | Inserted with this ID                                                                                                |
| No ID is provided                                                                                | Generated by the server                                                                                              |

- Two inputs with different IDs but the same text are still two separate inputs.
- A failure recovery keeps the original `inputMessageId`, and does not make a copy of the input again.
- This field does not apply to steering requests.
- Duplicate records in existing development data are not merged automatically. The affected sessions must be created again.

**The difference between a chat turn and a plugin call**

- Natural language from the player goes through `send_message` on `/api/actions`. It triggers the main flow that writes the story.
- The input box first matches slash commands against the session command catalog returned by `GET /api/sessions/:id/plugins`.
  - A known command goes through `/api/sessions/:id/plugin-rpc` as `{ kind: "command", commandId, input }`. It does not go through the main story-writing flow.
  - An unknown command follows the input box's existing rules (during normal idle submission, it uses `execute_command`).
- A plugin UI button that declares a command uses JSON-RENDER's `invokeCommand`. It goes through `/api/sessions/:id/plugin-rpc` as `{ kind: "command", commandId, args }`. It does not go through the main story-writing flow. It shares argument validation, context, approval, handler, and trace with input-box commands.
- Other custom UI actions use `invokePluginAction`.

### Interaction responses

| Command        | Method | Endpoint       | Response                                                                                                      |
| -------------- | ------ | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `input.submit` | POST   | `/api/actions` | SSE stream for `type: "submit_interaction"`: `interaction.submitted`, followed by the events of the next turn |

Saving the answer and starting the next turn is one operation: the same session lock and the same transaction. See [api.md § Player interactions](./api.md#player-interaction).

- The `turnId` on the outer layer of `interaction.submitted` is the ID of the next turn.
- The client uses `results[].values` (the values the server saved) to mark the form as submitted.
- The client uses `message` to draw the player's bubble. `message.id` is the ID of the saved message, so refreshing after the turn ends does not add an extra line.

When the answer is not accepted, the stream contains only one `error.occurred`. Nothing is saved, and no turn starts:

| `code`                            | Meaning                                                                                                                                                         | What the client does                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"form_rejected"`                 | The values the player filled in did not pass validation. `message` is text for the player, in the session's language                                            | `details.issues` lists each reason by field (`{ field?, message }`. An entry with no `field` belongs to the whole form). Show each message under its field, and focus the first field with an error. Show the errors for the whole form above the fields. Keep what the player already filled in, and do not enter the "execution error" state |
| `"interaction_already_submitted"` | This interaction was already answered (in another tab, or a submission whose answer was lost)                                                                   | Do not resend. Mark the form from `submittedInteractions` in the session view, and use `GET /api/sessions/:id/execution` to watch the turn that the submission started                                                                                                                                                                         |
| `"form_validator_failed"`         | The source plugin's form validator threw an error. `message` is fixed text in the session's language. The raw text the plugin threw goes only to the server log | Show it as an ordinary error. The form can be submitted again                                                                                                                                                                                                                                                                                  |

If the connection drops after the stream has started, do not resend either. The turn keeps running on the server until it commits, and the client recovers by polling execution state and reading the session view.

The optional `notice` field of a form interaction is shown above the fields.

### Plugin management

| Command          | Method | Endpoint                              | Response                          |
| ---------------- | ------ | ------------------------------------- | --------------------------------- |
| `plugin.enable`  | PUT    | `/api/sessions/:id/plugins/:pluginId` | JSON: `{ ok, activePluginIds[] }` |
| `plugin.disable` | DELETE | `/api/sessions/:id/plugins/:pluginId` | JSON: `{ ok, activePluginIds[] }` |

### Plugin RPC

This is the single channel for sending "structured instructions" to a plugin. It carries three kinds of calls: action-level, runtime-level, and command-level.

- Action-level and command-level calls return one JSON answer.
- Runtime-level calls split into sync and background answers, depending on `manifest.execution`.

| Command      | Method | Endpoint                       | Response                 |
| ------------ | ------ | ------------------------------ | ------------------------ |
| `plugin.rpc` | POST   | `/api/sessions/:id/plugin-rpc` | JSON variants, see below |

**Request body (choose one of action / runtime / command):**

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

- `kind` is required. The server looks only at it to decide which branch to take, and does not guess from other fields.
- A command request must provide exactly one of `input` or `args`. Not both.
- The server normalizes the two forms into the same `RpcCommandInvocation`. So logs and later handlers identify the same business operation by `commandId + args`. Only `source` keeps the difference in entry point: `composer` (the input box) or `plugin-ui` (the plugin interface).

**Response branches:**

| Status code | Success `status` / error `code`                                                                      | Trigger                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200         | `ok`                                                                                                 | Action or command level succeeded, or runtime level succeeded in sync mode                                                                                                   |
| 202         | `approval-required`                                                                                  | First call by a community-trust plugin (action, command, or runtime level)                                                                                                   |
| 202         | `accepted`                                                                                           | Runtime level with `execution: background` or `expectsBackgroundFollower`. Includes `jobId` and `turnId`. The state follows through `job-status.updated` and `_runtime_jobs` |
| 400         | Generic error envelope                                                                               | Validation of the kind/field combination, the arguments, or the payload failed                                                                                               |
| 404         | `unknown_action` / `runtime_not_active` / `command_not_active`                                       | The action is not registered / the runtime is not active / the command is not in the current session catalog                                                                 |
| 409         | `approval_scope_changed` / `session_not_active` / `session_deleting` / `session_incarnation_changed` | While waiting for the lock, the authorization or session generation changed, or the session is paused, ended, or being deleted. The client should refresh and start again    |
| 429         | `queue_full`                                                                                         | Pending approvals exceed the cap                                                                                                                                             |
| 500         | `runtime_execution_failed` / `background_enqueue_failed` / `turn_commit_failed`                      | Sync execution threw / enqueuing failed. (In background mode, an internal runtime exception goes through SSE, not HTTP)                                                      |

Every non-2xx answer uses `{ error, code?, details? }`. It does not return a business `status`.

**Two authorizations**

A community plugin action with a deferred `entry` returns `approval-required` twice in a row:

1. First, authorize `covel:plugin-server-code` (running server code).
2. After the retry, authorize the actual action.

The client shows the approval one stage at a time, and retries the original request. When the same request asks again for the same `(pluginId, action)` authorization, the client stops, and it rejects approval answers that cross sessions.

A batch of answers in `submit_interaction` can involve several source plugins, and there is no limit on the number of stages. Only when the server-code authorization for every source is complete are the answers validated and saved atomically.

**Framework default actions:** see the "Framework default actions" section in [api.md](./api.md#post-apisessionsidplugin-rpc).

Resuming a suspended runtime also requests each missing grant. The client releases its session queue while asking for approval. Switching sessions or denying approval stops retries and leaves the suspension pending. See the [resume endpoint](./api.md#post-apisessionsidsuspensionssuspensionidresume).

### RPC Approval

Calls to community plugin RPCs need the player's explicit approval. After the framework returns 202, the frontend reads the pending items through the endpoints below, and submits a decision.

| Command           | Method | Endpoint                              | Response                                 |
| ----------------- | ------ | ------------------------------------- | ---------------------------------------- |
| `approval.list`   | GET    | `/api/sessions/:id/approvals`         | JSON: `{ items: RpcApprovalPending[] }`  |
| `approval.decide` | POST   | `/api/approvals/:approvalId/decision` | JSON: `{ ok, decision, scope, pending }` |

**Decision request body:**

```json
{
  "decision": "allow",
  "scope": "once"
}
```

| Field      | Values                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `decision` | `"allow"` or `"deny"`                                                                                     |
| `scope`    | `"once"` (the default, usable once within 60 seconds) or `"session"` (valid for the rest of this session) |

For the detailed flow chart, see [api.md](./api.md#rpc-approval-flow).

Each pending item and each approval is bound to the session generation saved on the server and to the plugin's revocation generation. After a revoke, disable, or delete, or after a rebuild with the same ID, an old decision returns `409 approval_scope_changed`. An authorization held in memory by an old pod cannot be used on the new generation either.

## 3. Query endpoints

Read-only data fetches, answered with normal REST GET responses:

| Query           | Endpoint                                          | Response                                                                                                                                                                             |
| --------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session list    | `GET /api/sessions?worldId=`                      | `{ items: SessionRecord[] }`                                                                                                                                                         |
| Session detail  | `GET /api/sessions/:id`                           | `SessionRecord`                                                                                                                                                                      |
| Session view    | `GET /api/sessions/:id/view`                      | `SessionSnapshot` (messages/steps are the most recent window plus an opaque `messagesCursor`. `submittedInteractions` lists the interactions already answered in the window's turns) |
| Message list    | `GET /api/sessions/:id/messages`                  | `FlatMessage[]` (all of them)                                                                                                                                                        |
| Message page    | `GET /api/sessions/:id/messages/page`             | `CursorPage<FlatMessage>` (cursor-based)                                                                                                                                             |
| Character list  | `GET /api/sessions/:id/characters`                | `{ items: CharacterRecord[] }`                                                                                                                                                       |
| Plugin list     | `GET /api/sessions/:id/plugins`                   | `{ active[], available[] }`                                                                                                                                                          |
| State query     | `GET /api/sessions/:id/state`                     | `{ tables }`                                                                                                                                                                         |
| State patches   | `GET /api/sessions/:id/state-patches`             | `Patch[]`                                                                                                                                                                            |
| Plugin data     | `GET /api/sessions/:id/plugin-data/:pluginId/:ns` | `{ items[] }`                                                                                                                                                                        |
| World list      | `GET /api/worlds`                                 | `{ items: WorldRecord[] }`                                                                                                                                                           |
| Execution trace | `GET /api/traces/:sessionId`                      | `{ events[], nextCursor }` (the latest 5000 events. Use the cursor to read older ones)                                                                                               |
| Trace pages     | `GET /api/traces/:sessionId/turns/page`           | `{ turns[], nextCursor }` (cursor-based)                                                                                                                                             |
| Service health  | `GET /api/health`                                 | `{ status, version, bootId, timestamp, storage, vector }`                                                                                                                            |

## 4. SSE envelope format

Every frame in the `/api/actions` stream uses the same outer structure (`packages/shared/src/types/api-contract.ts`):

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

Frames on `/api/events/stream` use a different structure, `ProtocolEvent`: `{ id, type, sessionId, turnId?, source?: { pluginId, runtimeId }, payload, timestamp }`.

## 5. Frontend event routing

`handleSseEvent` is the only handler for in-turn events. By event type, it passes each event to the matching state slice:

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

## 6. Transport layer (actual implementation)

This section describes the real implementation. **There is no unified transport abstraction layer**, and there is no swappable Transport implementation.

Communication is carried by these **concrete** paths (matching the three groups in the "Architecture overview"):

| Direction          | Actual implementation                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Command (upstream) | REST `POST`, with hard-coded `fetch('/api/...')` (`apps/web/src/services/`)                                                                                                         |
| In-turn Event      | Data-only SSE on `POST /api/actions`, parsed with `fetch` + `ReadableStream` (`apps/web/src/services/sse.ts` / `api/actions.ts`, envelope = `SseEnvelope`)                          |
| Side-channel Event | Named SSE on `GET /api/events/stream`, read with `fetch`, reconnecting with the `lastEventId` query parameter (`apps/web/src/services/subscription.ts`, envelope = `ProtocolEvent`) |
| Query (read-only)  | REST `GET`, standard JSON                                                                                                                                                           |

The only real deployment abstraction is in the **data layer**, not the transport layer. `DataService` in `apps/web/src/services/data-service.ts` distinguishes `local` (the browser's IndexedDB) and `remote` (the server API). But it **only handles create, read, update, and delete of data**. Turn execution and the two SSE streams above still connect directly to the server, even in `local` mode.

### WebSocket upgrade path

Moving to WebSocket is **not** as simple as "swap in another Transport implementation". Upstream and downstream are both written directly where the `fetch` calls above are. To adopt WebSocket, you need to add WS handling and frame encoding and decoding on both the server and the frontend.

## 7. Debug trace events

The diagnostic events of the built-in `TurnEmitter` are saved and broadcast on a "best effort" basis:

- If the storage interface throws synchronously or rejects asynchronously, the event is still broadcast.
- If the broadcast throws, the saves that have already started are still awaited.
- The fallback warning when delivery fails contains only the event type, sessionId, turnId, and traceId. It does not copy the raw exception or the trace body.
- If a hook trace fails to deliver, it does not change a policy result that was already accepted, and it does not trigger a duplicate runtime cleanup.
- A missing diagnostic record does not mean a domain commit failed.

### Thinking output and continuation

**Where thinking content goes**

`LLMResponse.reasoningContent` is the thinking text or summary the provider returns, kept separate from the narrative content. When the provider gives it, the adapter takes it from these places:

| Protocol      | Source                                                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Chat          | `reasoning_content` or `reasoning` (DeepSeek and DashScope use the former. groq, OpenRouter, and newer vLLM use the latter) |
| Responses     | `output[].summary[].text`                                                                                                   |
| Anthropic     | `thinking` block                                                                                                            |
| Gemini native | thought part                                                                                                                |

- Encrypted or redacted state and signatures are never treated as displayable text.
- When the provider returns no readable content, the thinking panel is not shown.

**`<think>…</think>` written inside the body**

Some models write their thinking directly into the answer (Qwen3, DeepSeek-R1 and their distilled versions, behind a gateway that passes it through as body text).

- This part is moved out of the Chat and Responses text and placed into `reasoningContent` and `reasoning-delta`. Streamed answers work the same way. The method is the same as the `extractReasoningMiddleware` of the AI SDK.
- A tag cut by a stream chunk is held back until it is complete, and only then processed.
- When an answer is cut off inside a thinking block, everything from there to the end counts as thinking.
- This kind of thinking is not sent back to the model. Its continuation record has the source `think`, and later requests to the same target send only the answer text. This is what these models expect.

**Which field is used to send thinking back on the Chat protocol**

The field used to send thinking back is determined by the endpoint address, so Covel does not keep a list of providers:

- An answer that arrives with a `reasoning` field carries a `providerContinuation` that records this field.
- When a request carries such a continuation, and the protocol, model, and address are all the same, the thinking for each assistant message is sent back as `reasoning`.
- Otherwise the generic `reasoning_content` is used. It is also the default of the AI SDK's openai-compatible provider.
- groq rejects `reasoning_content` on assistant messages.

**How it is shown in the interface**

- The session record and the DEBUG page put this text in an expandable section that is collapsed by default.
- Entries in the session are grouped by the source turn and the runtime, with one entry for each completed model call. This includes the gateway calls of function plugins.
- Live action events and content restored from a saved trace use the same identity (`turnId`, runtime, event type, `flowId`, `seq`). So a replay does not create duplicate entries.
- Reloading restores the locally available execution history, and the trace window kept by the server.
- When a detached task completes, it triggers a snapshot recovery.
- Thinking content is shown only after each call ends. Token-by-token streaming display in the interface is not part of this convention.

**`reasoning-delta` and timeouts**

`LLMStreamEvent.reasoning-delta` and narrative fragments are two separate kinds of events. It counts as "the provider is active":

- It counts toward the first-token timeout. After the first output, it also counts toward the idle timeout.
- Each text, thinking, and tool-call event restarts the idle wait. So a stream that keeps writing has no total time limit.
- Provider-required backoff time is not counted. After a transport attempt that was rate-limited or failed (HTTP 429 / 5xx, honoring `retry-after`), the first-token timeout is paused. When a later attempt gets an answer, the timer restarts.
- The runtime deadline and the request budget still apply.

**`providerContinuation`: passing native content back on tool continuation**

- It saves the provider's native answer entries in their original order, including signed and encrypted thinking. It is used for a tool continuation only when the protocol, model, and address are all the same.
- A native Gemini tool turn keeps its ordered parts, which carry `thoughtSignature`.
- When a native Gemini continuation arrives, and the protocol is unchanged but the model or address has changed, a continuation with a signature fails with `CONFIG_ERROR`.
- When switching to another protocol, the generic history is rebuilt, and Gemini's signatures are not replayed.
- The runtime carries this uninterpreted field through the stream completion, the assistant's tool-call message, and the suspended history. The trace payload used for display and answers uses only `reasoningContent`.
- The trace of a request may include replayed native entries, because it reflects the request that was actually sent.

**References**

This separation follows the [AI SDK reasoning stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) and [how each vendor's Responses continuation works](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/convert-to-openai-responses-input.ts). Covel keeps its own gateway and does not add an SDK dependency. The shape of native Gemini requests follows [Google generateContent](https://ai.google.dev/api/generate-content), [thought signatures](https://ai.google.dev/gemini-api/docs/thought-signatures), and [the AI SDK's Google language model](https://github.com/vercel/ai/blob/main/packages/google/src/google-language-model.ts). These references guide only the part that is already implemented. They do not mean full parity with the AI SDK's features. The request-format behavior also refers to [Alibaba Cloud's Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions), [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning), and [Anthropic thinking](https://platform.claude.com/docs/en/build-with-claude/thinking).

### Trace event payloads

These events use the standard SSE envelope, and they are saved to `trace_events` at the same time. The runtime's `TurnEmitter` (`packages/runtime/src/trace/turn-emitter.ts`) emits them, and they go to two places:

- `trace_events`, used by the `/api/traces` read endpoints and the `/debug` inspector.
- The global `EventBus`. The `/api/actions` SSE route then forwards them according to `FORWARDED_EVENT_TYPES` (the set generated from `COVEL_EVENT_META[type].forwardToActionStream`).

| Type                     | Payload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool.calling`           | `{ runtimeId, pluginId, toolName, toolCallId, label, arguments, source, approvalStatus }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `tool.completed`         | `{ runtimeId, pluginId, toolName, toolCallId, label, result, parsedResult, durationMs, approvalStatus, success: true }`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tool.failed`            | `{ runtimeId, pluginId, toolName, toolCallId, label, code, error, details?, durationMs, approvalStatus, success: false }`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `domain-event.previewed` | `{ runtimeId, pluginId, toolCallId, topic, data }`. A temporary display signal after `emit-event` passes validation. Persistent business state is still committed by the normal event chain                                                                                                                                                                                                                                                                                                                                                                  |
| `llm.calling`            | `{ runtimeId, pluginId, slot, model, provider?: string \| null, messages, tools, attempt, startedAt, queueWaitMs?, streaming? }`. `slot` is the role the runtime requests. In production, the gateway resolves it to `model` / `provider` before the call. A custom adapter that does not support role resolution can omit `provider`                                                                                                                                                                                                                        |
| `llm.responded`          | `{ runtimeId, pluginId, text?, reasoningContent?, toolCalls?, usage, finishReason, durationMs, attempt, error? }`. `usage` is `{ inputTokens, outputTokens, cachedInputTokens?, cacheWriteInputTokens? }`. `inputTokens` is the total input including cache reads and writes. The last two are subsets reported by the provider. `finishReason` of `length` appears only in the story runtime: the body was cut off at the output limit but was kept, and the client uses this to tell the player. In other cases, a truncated call is reported as a failure |
| `gateway.responded`      | The success result of a function-runtime gateway. Text and object calls carry `{ runtimeId, pluginId, method, finishReason, usage, reasoningContent?, model?, provider?, durationMs }`. `model/provider` is the target actually hit after fallback. Transcription calls also carry `usage/model/provider` when available. Old traces, or custom gateways that do not support this metadata, may lack them                                                                                                                                                    |
| `message.completed`      | `{ runtimeId, pluginId, content, len, deltaCount }`. `deltaCount` is the number of `narrative.delta` events this runtime produced. It is the saved, authoritative count. The frontend uses a different synthetic field, `_aggregated`, when it combines live fragments. The two cannot be swapped                                                                                                                                                                                                                                                            |
| `block.emitted`          | `{ runtimeId, pluginId, proposalId, source, block }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ui.rendered`            | `{ runtimeId, pluginId, proposalId, source, render, block? }`. The `/actions` SSE forwards it, so the chat area can show committed `ui.render` blocks live. Older trace-only payloads may not have `block`. In that case the client builds it from `render`                                                                                                                                                                                                                                                                                                  |
| `state.patch.applied`    | `{ runtimeId, pluginId, proposalId, patch: { packageName, summary, ops } }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `hook.fired`             | `{ event, hookName, pluginId, runtimeId?, targetId?, targetType, proposalType? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `hook.rewrote`           | `{ event, hookName, pluginId, runtimeId?, targetId?, diff?, proposalType? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `hook.aborted`           | `{ event, hookName, pluginId, runtimeId?, targetId?, reason, proposalType? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `command.invoked`        | `{ invocationId, commandId, command, pluginId, action, source, canonical, raw, argv, args }`. The input box and JSON-RENDER use the same structure                                                                                                                                                                                                                                                                                                                                                                                                           |
| `command.completed`      | The fields of `command.invoked` + `{ durationMs, resultOk? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `command.failed`         | The fields of `command.invoked` + `{ durationMs, error }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

`tool.completed` means the executor accepted the tool result; it does not mean its proposals were committed. Cancellation before acceptance emits only `tool.failed`; cancellation after acceptance does not emit a failure for the same call. Tool trace or domain-event preview delivery failures only warn and do not turn a successful tool result into a failure.

Narrative fragments are still sent live to the interface through `narrative.delta`. To keep `trace_events` lean, only `message.completed` is saved.

**`command.*`**

- The TurnEmitter of the action-level command dispatcher writes these to `trace_events`, and publishes them to the `trace` subscription topic. `forwardToActionStream: false`, so they do not appear in the game's `/api/actions` stream.
- The three events share `invocationId` as their `traceId/turnId`.
- The log does not save the handler's full return value. It records only the final state, the duration, and an optional `resultOk`.

> [!WARNING]
> `raw` / `args` go into the trace by design. Command arguments must not contain API keys, credentials, or other secrets.

**Additional notes on payloads**

Read endpoints `/api/traces/*`:

- They do not change the original `payload`. Instead they add three things to each event: the saved `id`, an `eventOrder` that increases monotonically within this answer, and a unified `diagnostic` summary. A client can find a failure directly with `diagnostic.error`, and find the size of a prompt and the path to its body with `diagnostic.prompt`. It does not need to guess payload fields by event type.
- `eventOrder` starts at 0. It only gives the order by time within the current API answer (the full result or one page). It is not a global database sequence number, and it cannot be compared across pages.
- `diagnostic.severity` is `info` / `warning` / `error`, with errors taking priority. A successful `llm.responded`, `gateway.responded`, `utils.fetch.responded`, `tool.completed`, `runtime.completed`, or `function.completed` that takes 1000ms or more is marked `warning`, and carries `diagnostic.warning = { code: "slow", thresholdMs: 1000 }`.
- `tool.*` events carry a `diagnostic.tool` summary: name, callId, whether arguments and results are available, the paths to content such as `payload.arguments` / `payload.result`, success, and durationMs. The raw arguments and results remain only in `payload`.

Time fields of `llm.calling`:

- `payload.startedAt` (also shown in `diagnostic.startedAt`) records when the request to the provider actually started. The event's own `timestamp` is still the time the trace row was saved. Some adapters write the calling event a bit later, so they can first confirm the final provider and model. To judge duration, use `startedAt` together with the `durationMs` of the responded event.
- `queueWaitMs` is the number of milliseconds this attempt actually waited for the framework's concurrency slot. The model call's `durationMs` starts counting once the slot is obtained, and includes the time spent reading the answer stream. Historical data, or calls that do not go through the retry layer, may have no queue metric. Do not read "missing" as 0.

Final states of runtimes:

- The final state of a newly executed runtime is published after `PostRuntime` and the output and cancel checks. A final failure uses `runtime.failed`, and a final success or pause uses `runtime.completed`. The action SSE turns a "skipped" into `runtime.skipped`.
- The final-state payload keeps `turnId` and `runId`. It does not mean the transaction commit succeeded.
- When the turn commit succeeds, but the writes of an optional runtime were discarded on their own, the main turn sends a `runtime.failed` for it before `execution.completed` (with the reason for the discard). The client uses it to override the earlier `runtime.completed`.
- In historical data, `runtime.completed` with `status: "failed"`, and `turn.completed` with `committed: false`, still count as diagnostic failures.
- When an LLM attempt fails and then succeeds on retry, the failure record is still kept. The interface should show "recovered attempts" separately from the task's final state.

Request content in `llm.calling`:

- It can include `responseFormat`, `defaults`, and `maxOutputTokens`, which describe the structured output and generation limits the runtime requested. The request actually sent to the provider is in the optional `providerRequests` array. This array does not exist when only a custom LLM adapter is provided and it has no observation hook. In that case, the final request should not be guessed from the logical messages.
- The format of `providerRequests[]`: `{ schemaVersion: 1, provider, protocol, body, complete, omittedFieldCount, startedAt, durationMs, transportAttempt, statusCode?, failed? }`.
  - `body` is the JSON after the HTTP adapter serializes it. It includes the structured prompt that the adapter adds, the conversion of messages and tools, and the values after parameter overrides.
  - The order of the array keeps the sequence of target fallbacks and HTTP retries. `transportAttempt` starts at 0 for each protocol request.
  - Correlation relies on the outer trace / turn / runtime / attempt identifiers. It does not add domain writes, and it is not a basis for recovery.
- Within one `providerRequests` array, an identical request body is saved only once. Duplicate items use `schemaVersion: 2`, with `bodyRef` in place of `body`. Their other attempt metadata is kept on each item.
  - `bodyRef` is the index (starting at 0) of an earlier item in the same array that carries the full request body. Reference chains, forward references, and cross-trace references are not allowed.
  - The HTTP observation callback still returns the full v1 request. Deduplication happens only when the trace is serialized.
  - The debug page supports the complete items from history, and resolves references when viewing and copying. An invalid reference is shown as "unavailable", and the body is not guessed.
  - Logical messages and the actual protocol request are still kept separately.
- The observation hook reports when the HTTP call returns or fails. So `statusCode: 200` only means HTTP accepted the request. It can still fail after streaming output. Use `llm.responded` and the runtime's settlement as the source of truth.
- The request content for the HTTP call is saved before the first fragment of the text stream is emitted. If the process exits before HTTP returns, there may be no record. The trace is best effort, and a complete audit at a crash is not guaranteed.
- `llm.calling.tools` is `Array<{ name, description, jsonSchema }>`. It is converted from `LLMToolDefinition.parameters`, and it keeps the logical schema. The final form written out per protocol is in `providerRequests`.
- `llm.calling.provider` is `null` where a call goes straight to `generate` / `generateStream` and no resolved provider string is available. Calls routed by role fill in the provider name (`openai`, `anthropic`, `deepseek`, `qwen`).

Privacy boundary:

- Authentication headers, API keys, the provider base URL, and configuration objects are not collected.
- For any extra metadata, only the number of omitted fields is recorded.
- A resource URL with query parameters, credentials, or a fragment is redacted, and marked `complete: false`.
- When an unsupported version, `complete: false`, or an external resource that has already expired is encountered, an offline tool must report that it "cannot fully rebuild" the call.
- `complete: true` only means the JSON request content is complete. It does not guarantee that the resource stays valid forever, that HTTP headers can be rebuilt, or that the real model result is deterministic.
- The request body follows the existing trace rules for access to and retention of sensitive content. It contains the player's text, and it must not be treated as a redacted log that can be exported publicly.
- The `gateway.*` events of a function runtime still record only the shape, and do not widen the range of body content collected.

## Event bus lifecycle and client handler failures

**`flush()` and `close()`**

- `EventBus.flush()` waits for the bounded audit persistence queue to drain. It does not wait for cross-process delivery, and it does not block new events.
- `EventBus.close()` can be called more than once. It does these things in order: stops local emitting and remote receiving; unsubscribes where supported; clears the timers that wait for gaps; waits for unfinished persistence, ordered publishing, and reads of received references to finish; and finally closes the transport it owns.
- After close, calls to `emit()` are ignored.
- A transport can return an unsubscribe function from `subscribe()`, and implement `close()` when it holds resources. The PostgreSQL implementation uses this lifecycle to release its LISTEN/NOTIFY client.
- The server's shutdown order: close the workers first, then the bus, and finally the storage behind the bus.

**World file watcher**

- The world file watcher stops receiving before the worker shuts down, and it waits for reloads it has already accepted to finish.
- Reloads of the same physical world directory run in order. So an earlier, slower load cannot overwrite the result of a later reload.
- If a producer goes over the time budget for draining, the shutdown process keeps its dependencies open and leaves cleanup to process exit.

**Event handlers in the browser**

- An action stream pauses only its own session’s background subscription, with pause counts per session. Switching sessions does not abort the old action stream or its checkpoint commit; the new session can connect immediately. Subscriptions pause while the page is hidden and resume when it becomes visible.
- The browser subscription isolates each event handler.
- When a handler throws synchronously, the report includes the session ID, the event ID and type, and the error type. It does not record the event payload or the exception message, and other subscribers keep running.
- Connection recovery and `system.reset` still rebuild from authoritative state. A single handler warning does not change the replay cursor, and it does not trigger a retry.

**Batched notifications**

- Batched plugin data notifications are grouped by `(sessionId, pluginId)`, even when one store call writes to several sessions.
- Notifications inside a transaction are buffered and sent only at commit. On rollback they are discarded.

**Warnings from media resolution**

Warnings from media resolution in the browser state the session, the media ID, and the HTTP status or error type. They do not include signed URLs or exception messages, so media access tokens do not enter diagnostic logs.

### UI slot projection events

| Event                                                     | Purpose                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ui.slot.changed { slot, key?, value, revision }`         | Updates committed UI state                                                    |
| `ui.slot.preview { slot, key?, value, revision, turnId }` | Temporarily covers the display for one turn, without changing committed state |
| `ui.slot.cleared { turnId }`                              | Removes the previews for this turn                                            |

- These events are forwarded to both the action stream and background subscriptions.
- When a turn completes, fails, or is cancelled, the client also clears its previews. Leaving a session or unmounting its host clears that session’s entire slot cache; revisiting reads authoritative state again. Refreshing the same session preserves its active previews.
- A preview that arrives late for a turn that has already ended is ignored. Explicitly starting a new execution allows the same turn ID to be retried.
- A GET that was sent before a newer SSE event must not overwrite those updates when its answer arrives.

## Source execution snapshot

A plugin that reads "what the player typed this time" has two values:

- `ctx.playerMessage`: the text command of the current execution.
- `ctx.session.lastPlayerInput`: the most recent structured submission, recorded after the source execution is accepted. Its shape is `{ id, sessionId, turnId, formId, values, createdAt }`. It is `null` when nothing has been submitted.

About `lastPlayerInput`:

- "Most recent" is judged by the saved UTC `createdAt`. When timestamps are equal, the order is decided by the lexicographic order of `id`. It does not depend on the database's enumeration order.
- `values` accepts only JSON data.
- A form may come from an earlier turn. A plugin that uses it must interpret it through the source identifier. It must not automatically treat an old form as a command for this time.

`turn-digest@1` contains `turnId/playerMessage/locale/narrativeText/toolCallSummaries/lastPlayerInput/runtimeResults`:

- `runtimeResults` lists only the `runtimeId` and status (`success/failed/skipped/suspended`) that the source turn had already seen at the moment of recording. It does not include consumers that have not run yet, and it does not include retry seeds from other turns.
- Only successful story text and accepted tool calls go into the text summary. Tool calls from a runtime declaring `io.concealed: true` are excluded from `toolCallSummaries`; `runtimeResults` still includes its ID and status.

How snapshots are saved:

- The kernel copies and freezes the commit and the digest, and saves the same source snapshot in the job's transaction.
- When a worker recovers, it validates the snapshot against the shared schema, and it does not look up the latest form again.
- Normal execution, manual, and resume each record it once, after the new execution is accepted.

> [!WARNING]
> This convention supports only the current format. Old jobs and old session snapshots that lack the new fields must be rebuilt.

## Plugin call trace

`plugin.service.completed` is a trace-only event, with `forwardToActionStream: false`.

- The payload includes `callId/parentCallId?/sessionId/turnId?/runtimeId?/callerPluginId/providerPluginId/name/contract/durationMs/outcome/errorCode?`.
- Extension calls also carry the metadata the host registers: `extension: { point, id, slot? }`.
- The input, the output, the raw exception, and the private `diagnosticScope` are not recorded.

**How calls are counted and timed**

- The raw validation of the output, the ownership handling `attributeOutput`, and the final validation all happen at the completion boundary of the same call. A failure is counted as one `output-validation`.
- A cache hit does not add a call.
- An execution with a real TurnEmitter reuses its `traceId/retryScope/seq`, and waits for the saved attempt to finish. `durationMs` does not include the time spent reading and writing the trace.
- When observation fails, only one fixed warning is sent. It does not change the plugin's result.
- A UI background display with no turn emitter goes only into a bounded in-process window, and does not fabricate a turn trace.

**Diagnostic events do not take up replay buffer space**

- Diagnostic `trace` events are sent live only on the event bus. They do not take up the subscription replay buffer, and their payloads are not saved again in `events`. After reconnecting, diagnostics are read through the trace API.
- Across processes, a large trace frame references the trace row that was saved originally. Ordinary state events keep ordered replay and gap detection.
- If a live-only trace reference is lost or cannot be read, only a log entry is written. The state replay is not invalidated.
- If reading a reference for a state event fails, it still triggers a replay reset. The reason: if the event is lost, the committed state the consumer sees would differ.
