# Hooks

A hook is a piece of plugin code. The kernel calls it at fixed moments: when a session starts or ends, when a turn starts or ends, before and after a runtime runs, before and after each model call, before and after each tool call, and before and after each write is committed. This page lists all 17 events, and what each one gives its handler and what the handler can return. Plugin authors who write hooks need it.

A hook does only one of three things:

- **Intercept**: block the operation.
- **Rewrite**: change what the operation receives or what it returns.
- **Observe**: only watch, without changing anything. Use this for logging and cleanup.

A hook does not hold gameplay. A gameplay rule belongs in a runtime or a tool.

> [!NOTE]
> Event names are defined in only one place: `HOOK_EVENTS` (`packages/shared/src/types/hooks.ts`). How each event runs is written in `HOOK_SEMANTICS` and `GUARD_HOOK_EVENTS` (`packages/runtime/src/hooks/types.ts`). The payloads are built in `packages/runtime/src/hooks/wire-helpers.ts`. If this page and those tables disagree, `packages/runtime/tests/hooks-reference-doc.test.ts` fails.

## Declaring and registering

There are two steps. The root `PLUGIN.md` lists the events you use, and the `entry` module (`server/index.js` by default) registers the handlers. The two must match, or the plugin fails to load. One declaration can correspond to several handlers. Each handler is added with one call to `covel.on()`.

```yaml
contributes:
  hooks: [PreToolUse]
```

```js
export default function (covel) {
  covel.on("PreToolUse", async (ctx, payload) => {
    if (ctx.runtimeId !== "my-plugin/tracker") return { action: "continue" };
    if (payload.toolCall.name !== "delete-note") return { action: "continue" };
    return { action: "abort", reason: "This runtime may not delete notes." };
  });
}
```

The `options` for `covel.on(event, handler, options?)` have three items:

| Option      | Meaning                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`     | `(payload) => boolean`. The handler runs only when this returns `true`. It receives its own separate copy of the payload.                            |
| `timeoutMs` | The time limit for one call of the handler. The default is 5000 milliseconds.                                                                        |
| `enforce`   | The ordering group: `pre`, `normal` (the default), or `post`. It must match the group declared in `contributes.hooks`. The ordering rules are below. |

The handlers for one event run group by group: `pre`, then `normal`, then `post`. Inside one group, the framework's own hooks run first, followed by plugin handlers, in registration order. The order between two plugins is not something you can rely on.

When a hook runs:

- The plugin is enabled in this session.
- For a community plugin, the player must also have approved its server code in this session. If it has not been approved, the handler is skipped.

## The handler

```ts
type Handler = (ctx: PluginHookContext, payload: Payload) => Promise<Result>;
```

A handler receives two arguments: the context `ctx` and the payload `payload`. It returns a result that tells the kernel whether to continue, rewrite, or stop.

### Context

Every handler for every event receives a context with the same shape.

| Field             | Value                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `event`           | The event name.                                                                                                                                                                                                                                                                                   |
| `sessionId`       | The session.                                                                                                                                                                                                                                                                                      |
| `turnId`          | The execution this event belongs to. It is an empty string for `SessionStart` and `SessionEnd`.                                                                                                                                                                                                   |
| `locale`          | The session's content language, set when the session is created. A hook uses it when it adds text itself: `instructionLocaleFor(ctx.locale)` gives the language of the prompt body (`en` or `zh`).                                                                                                |
| `pluginId`        | The plugin of the runtime the event is about. It is not the plugin that registered the handler. Only events whose scope is `runtime` (see the table below) have this field. The others do not.                                                                                                    |
| `runtimeId`       | The runtime the event is about, for example `world-init/dimension-tracker`. It appears together with `pluginId`, and it is absent together with it. For the two commit events, it is the runtime that produced the proposal.                                                                      |
| `activePluginIds` | The plugins enabled in the session.                                                                                                                                                                                                                                                               |
| `getOwnSettings`  | Returns the resolved settings of the plugin that owns the handler (the manifest defaults, the world presets, and the values the player filled in). Read-only. Usage: `ctx.getOwnSettings?.() ?? {}`.                                                                                              |
| `signal`          | An `AbortSignal`. It fires when this execution is cancelled, or when the handler goes over its time limit. Pass it to any call that might wait. `SessionStart`, `SessionEnd`, `PostStateCommit` and `TurnStop` are not cancelled with the execution: their `signal` fires only on the time limit. |

A runtime's identity is only in the context. The payload does not repeat `pluginId` or `runtimeId`, so a line such as `ctx.runtimeId === "..."` applies to every event.

### Payload

The payload is a private copy. Changing it directly has no effect. To change the content, put the change in the `replace` of the returned value.

### Result

| Return value                             | Effect                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ action: "continue" }`, or no value    | Nothing changes.                                                                                                                                              |
| `{ action: "continue", replace: {...} }` | Rewrite. `replace` overwrites fields on the payload, and the next handler receives the merged payload. Each event recognizes only the fields it lists itself. |
| `{ action: "abort", reason }`            | Intercept. On events that can be intercepted, the operation is blocked, and `reason` is reported. On other events, it is the same as "nothing changes".       |

## How an event runs

The event tables below use two English terms to describe how a handler runs:

- **sequential**: the handlers run one after another, in order. The `replace` of one is passed to the next. One `abort` ends the whole chain.
- **parallel**: the handlers run at the same time. The event has already happened, so a changed return value cannot change anything. These events are for logging and cleanup.

Events whose Guard column says `yes` are the "events that can be intercepted".

If a handler throws an error, times out, or returns a result in the wrong format, that counts as a failure of that handler. What happens next depends on the event:

- **Events that can be intercepted**: a failure is treated as `abort`. A broken rule cannot let through an operation that it was supposed to block.
- **Other events**: the handler is skipped. Any rewrites made by earlier handlers are kept, and the failure is recorded in the trace (`hook.error`).

Throws, timeouts and malformed results count toward the registering plugin's [fault latch](./protocol.md#plugin-fault-latch). A deliberate `abort` / veto is not a Hook fault; a deliberate `PreStateCommit` veto is a rejection of the proposal owner. Parent cancellation is not a Hook fault.

## Events

The "Scope" column says what the event is about: `session` (the whole session), `turn` (one execution), or `runtime` (one runtime). For events with scope `runtime`, `ctx.pluginId` and `ctx.runtimeId` are that runtime.

The table follows the order in `HOOK_EVENTS`. Tool events repeat inside the agent loop; they do not occur after `PostRuntime`.

| Event                 | Scope   | How it runs | Guard | What the handler can do                                                                 |
| --------------------- | ------- | ----------- | ----- | --------------------------------------------------------------------------------------- |
| `SessionStart`        | session | parallel    | no    | Observe                                                                                 |
| `TurnStart`           | turn    | sequential  | yes   | Stop this turn                                                                          |
| `PreCompaction`       | turn    | sequential  | yes   | Stop the history compression for this turn                                              |
| `PostCompaction`      | turn    | parallel    | no    | Observe                                                                                 |
| `PreSchedule`         | turn    | sequential  | no    | Remove or reorder the runtimes selected for this turn                                   |
| `PreRuntime`          | runtime | sequential  | yes   | Stop this runtime (recorded as skipped)                                                 |
| `PostContextAssembly` | runtime | sequential  | no    | Rewrite the system prompt and the history                                               |
| `PreStep`             | runtime | sequential  | no    | Narrow this step's tools, change its tool choice, lower the steps left, or end the loop |
| `PreLLMCall`          | runtime | sequential  | no    | Rewrite one call's messages, model, and tools                                           |
| `PostLLMResponse`     | runtime | sequential  | no    | Rewrite the reply, or ask the model to correct it                                       |
| `PostRuntime`         | runtime | sequential  | no    | Rewrite the runtime's result                                                            |
| `PreToolUse`          | runtime | sequential  | yes   | Stop the tool call, or rewrite its name or arguments                                    |
| `PostToolUse`         | runtime | sequential  | no    | Rewrite the tool result, or end the tool loop                                           |
| `PreStateCommit`      | runtime | sequential  | yes   | Stop one proposal, or rewrite its payload                                               |
| `PostStateCommit`     | runtime | parallel    | no    | Observe                                                                                 |
| `TurnStop`            | turn    | parallel    | no    | Observe                                                                                 |
| `SessionEnd`          | session | parallel    | no    | Observe                                                                                 |

Each event has its own section below, which describes in order: when it fires, what the payload holds, and what the return value does.

### `SessionStart`

Fires once, after the new session and the world data it imports have been saved. At this point the session already exists, so the handler cannot prevent it from being created.

Payload: `{ sessionId, worldId? }`.

### `TurnStart`

Fires at the start of each execution, before any runtime is selected. A player turn, a manual run, and a background job each count as one execution.

Payload: `{ playerMessage, actions, activeRuntimes }`. `playerMessage` is the text the kernel renders from the player's actions; `actions` is the resolved actions (each `{ seatId, kind, actorId?, text?, fields?, interaction?, source }`), an empty array for an execution without player input; `activeRuntimes` is the list of runtime IDs for this session.

`abort` ends this execution, and no runtime runs. `reason` is returned to the client as the reason the turn was stopped.

### `PreCompaction`

Fires before history compression, and only on turns that need compression.

Payload: `{ messageCount }`, the number of stored messages that can be compressed.

`abort` keeps this turn's history as it is.

### `PostCompaction`

Fires after a compression attempt. Compression that was stopped by `PreCompaction` does not fire it.

Payload: `{ compacted, summaryId? }`.

### `PreSchedule`

Fires after the runtimes to run have been selected, and before their order is set.

Payload: `{ triggered }`, the list of manifests of the runtimes selected for this execution.

`replace.triggered` can shrink this set or reorder it:

- Entries match the selected runtimes by `name`. Entries that were not selected are dropped.
- The kernel always uses its own manifest objects. So a handler cannot add a runtime, and it cannot change a manifest.
- `replace: { triggered: [] }` means nothing is scheduled.
- `abort` is the same as "nothing changes".

### `PreRuntime`

Fires once before a runtime starts, before its guard, its agent loop, or its function handler. It fires once per logical runtime: a run resumed from a suspended state does not fire it, however many times it suspended. To stop an agent from suspending, use `PreToolUse` on the `suspend` tool.

Payload: `{ manifest, input }`, the manifest of this runtime and the turn input.

`abort` skips this runtime. Its result status is `skipped`, with the reason. This event does not read `replace`.

### `PostContextAssembly`

Fires once for an agent runtime, after its context has been assembled and before the first model call. A run resumed from a suspended state does not assemble its context again and does not fire it: the saved conversation record already carries the result of this step.

Payload: `{ systemPrompt, messages, outputKind?, promptTemplate?, inputSlots?, characters?, currentCharacterId?, promptSegments? }`.

| Field                | Contents                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outputKind`         | `story` or `system`.                                                                                                                                                                                                                                                                                    |
| `promptTemplate`     | The prompt body of this runtime, as it is before rendering.                                                                                                                                                                                                                                             |
| `inputSlots`         | The resolved `io.inputs` values.                                                                                                                                                                                                                                                                        |
| `characters`         | The characters in the session (`id`, `name`, `type`, `description`).                                                                                                                                                                                                                                    |
| `currentCharacterId` | The `id` of the character the player plays now: the current character of the primary seat (see [seats](./world-model.md#seats)), one of `characters`. Absent when no seat binds a character. Find the player character by it, not by `type === "player"`: a session can have several player characters. |
| `promptSegments`     | The [`prompt.segment@1`](./extension-points.md) fragments used in this runtime's prompt. Each entry is `{ pluginId, id }`: the plugin that provides the fragment, and the `id` it gave the fragment. Fragments whose `audience` does not include this runtime are not listed.                           |

To find out what your plugin put into the prompt, read `promptSegments`. Do not search the prompt text. When a hook needs to tell several states apart, give each state's fragment a different `id`. The built-in `world-init` is an example. When all the rules fit, its rule fragment is called `dimension-rules`. When some rules were cut off, it is called `dimension-rules-truncated`. Its `PreLLMCall` handler provides the read tool only in the second case.

`replace.systemPrompt` and `replace.messages` take effect. Content the framework writes at the start of the system prompt (the runtime framework notes, the output language instruction, and the completion convention) is placed again in front of the replaced system prompt. The handler does not need to include it.

### `PreStep`

Fires once per step of an agent runtime's tool loop, before the model call: after the player's interjections join the conversation, and before `PreLLMCall`. The finalizer step after the step limit (see [stop reasons](./protocol.md#stop-reasons)) does not fire it. A run resumed from a suspended state fires it on every step, like any other run.

Payload: `{ step, stepsRemaining, maxSteps, toolNames, toolChoice }`.

| Field            | Content                                                                    |
| ---------------- | -------------------------------------------------------------------------- |
| `step`           | The number of this step, starting at 1.                                    |
| `stepsRemaining` | How many steps are left, this one included.                                |
| `maxSteps`       | The step limit in force.                                                   |
| `toolNames`      | The names of the tools offered to the model this step.                     |
| `toolChoice`     | The tool choice the loop would send: `"auto"`, `"required"` or `{ name }`. |

`replace` accepts these four fields. Invalid parts are dropped; they do not fail the runtime:

- `replace.tools`: offer only these tools to the model. It can only be a subset of `toolNames`. Names outside it are ignored and recorded in this step's `step.completed`. The narrowing applies to this step only; the next step starts from the full tool set again. It also does not change which tools may run: if the model calls a tool the hook removed, the call still runs as long as the manifest declares the tool.
- `replace.toolChoice`: this step's tool choice, replacing the manifest's `agent.toolChoice`. `"auto"` means no choice is sent; `{ name }` must be a tool offered this step. On a step where the runtime asked the model to correct itself and call a tool, `"auto"` does not lift that requirement.
- `replace.stepsRemaining`: lower the steps left to this integer (at least 1, this step included). A value larger than the current one is ignored: steps can only go down. When they run out, the loop ends with `max-steps`.
- `replace.stop: { reason, message? }`: end the loop before this step's model call. `reason` can only be one of these two:
  - `"tool-finished"`: end as a success, the same as `PostToolUse`'s `terminate`. The runtime's completion conditions (`agent.completion`) are still checked.
  - `"cancelled"`: the runtime fails with the error `Runtime "<id>" was stopped by a PreStep hook`, followed by `message`. The tool calls already made stay in the failed result.

`abort` is the same as "nothing changes". `PreStep` runs first and `PreLLMCall` then rewrites the call: `PreLLMCall`'s `replace.tools` overrides the tools `PreStep` narrowed.

### `PreLLMCall`

Fires before each model call of an agent runtime. This includes calls made after tool results and the finalizer step. Within one step, `PreStep` runs first.

Payload: `{ messages, model, tools, stream?, promptSegments? }`. `promptSegments` is the same list as in `PostContextAssembly`. A run resumed from a suspended state carries the same list, saved before the suspension.

- `replace.messages`, `replace.model`, and `replace.tools` change only this one call. The runtime's own conversation record is not changed.
- Output repair requests keep tools off after hook processing; `replace.tools` cannot re-enable tools for repair steps.
- `replace.stream: false` makes this call not stream.
- `abort` is the same as "nothing changes".

### `PostLLMResponse`

Fires after each model reply, before the tool calls in the reply are run.

Payload: `{ response, messages }`, the reply, and the messages actually sent.

For a story runtime that asks for segments (`io.output.schema: contract:narrative-engine@2`), `response.content` is the JSON the model wrote, not the story text; a text review reads each segment's `text` (see [Story output](./plugins.md#story-output)).

- `replace.response` replaces the reply.
- `replace.correction` (a non-empty string) sends this draft back: its tool calls are not run, and this text is sent to the model as a correction request, so the model answers again. Each rejection consumes one `agent.loop.corrections.review` unit, allowing two corrections by default. A further rejection after that budget is exhausted fails the runtime with `invalid-output`. See [the loop profile](./plugins.md#loop-profile-agentloopprofile) for configuration.

### `PostRuntime`

Fires once after a runtime finishes, whether it succeeds, fails or is skipped. It does not fire when a runtime suspends; it fires when the resumed runtime really finishes, once per logical runtime.

Payload: `{ result, resumed? }`. `result` is the `RuntimeResult`. `resumed` is `true` when the run that finishes was resumed from a suspended state; otherwise the field is absent.

`replace.result` replaces the result. The kernel does these things with the replaced result:

- It keeps the original result's `pluginId`, `runtimeId`, `runId`, and `turnId`.
- Writes come only from the runtime itself: `pendingProposals`, `effects` and `completion` always take the original result's values, and whatever a hook adds is dropped. To stop a write, use `PreStateCommit`.
- When a hook changes `status` (for example from failed to success), the run's `pendingProposals`, `effects`, and `completion` are all discarded. A failed function handler's writes buffered before it failed are not committed either. A setup runtime changed from failed to success by a hook is not marked complete; it remains pending.
- If the handler changed `output` but did not change `canonicalValue`, the kernel discards the old `canonicalValue`. This way, the values other runtimes read do not disagree with the rewritten output.
- It then checks again against the runtime's `output.schema`. A function runtime checks `canonicalValue`. An agent checks `output` when a hook changed `output`. A result changed from failed or skipped to success has no `canonicalValue`, so its `output` is checked, the same check a normal success passes. If the check fails, the runtime fails with `output-schema-invalid`, and nothing is committed.

### `PreToolUse`

Fires before each tool call of an agent runtime, and before each call a function runtime makes through `ctx.tools.call`.

Payload: `{ toolCall: { id, name, arguments } }`, where `arguments` is a JSON string.

- `abort` skips this call and sends `reason` to the model as a `refused` error. The agent loop also records `tool.calling` / `tool.failed` with `skipped: true` and `skipReason: "hook-aborted"`; it does not count as an executed call or a failure.
- `replace.toolCall` can change `name` or `arguments`. `id` stays the same.

Within an agent tool batch, `PreToolUse` runs exactly once per call, in model order. For a run of eligible concurrent reads, all members' hooks run in order before any tool starts. A call whose original name is not poolable is never looked ahead to; its hook waits for the preceding step to finish. If a look-ahead call is rewritten into a barrier, it runs alone in the next step, retaining its hook outcome without firing the hook again. See [the tool execution rules](./tools.md#execution-within-one-batch).

### `PostToolUse`

Fires after each tool call that was actually executed. All members of a parallel pool settle before their `PostToolUse` hooks run in model order. A barrier's hook runs after that single call finishes.

Payload: `{ toolCall, result }`.

`result.result` is the tool envelope JSON text. `result.error` contains `{code,message,hint?}` on failure and is pinned along with effects, `success`, `refused` and approval status. A hook can rewrite the model text or `parsedResult`; it cannot change failure accounting or the structured error.

- `replace.result` replaces the result the model reads (in a function runtime, the value `ctx.tools.call` returns). The writes and events the tool produced, whether it succeeded, and its approval status stay as they were.
- `replace.terminate: true` ends the tool loop after the current step. Every already-started pool member is recorded normally and runs `PostToolUse`; a termination from any member skips later steps. A terminating barrier skips every later call. Skipped calls are closed with `cancelled` tool results and traced with `skipReason: "terminated"`.

### `PreStateCommit`

Fires once for each proposal of an execution, before it is committed. `ctx.pluginId` and `ctx.runtimeId` are the source of this proposal.

Payload: `{ proposal }`.

- `abort` rejects this proposal, with the reason.
- `replace.proposal.payload` replaces the payload. The proposal's type, source, and ID stay the same.

### `PostStateCommit`

Fires after a proposal is committed. To do something after the data is actually written, use this event.

Payload: `{ proposal, result }`.

### `TurnStop`

Fires when an execution has finished running all of its runtimes. At this point the writes are not yet committed, and they can still be rejected at commit time.

Payload: `{ runtimeResults, durationMs }`.

### `SessionEnd`

Fires when a session is ended or deleted.

Payload: `{ sessionId, reason }`, where `reason` is `ended` or `deleted`.

## Limits

- A hook has no write path of its own. A plugin's data is written by its runtimes and tools. A hook's return value can rewrite a result and a proposal's payload, but it cannot add a write.
- A handler cannot depend on the order of other plugins' handlers. Its own `enforce` group is the exception.
- For a runtime that declares `io.concealed`, the prompt and the reply do not appear in the trace or the live stream. However, the hooks of enabled plugins still receive them in the payload. A community plugin's hooks run only after the player has approved its server code.

- A plugin paused by faults runs no Hooks from the next execution; the current execution keeps its frozen admission set.
