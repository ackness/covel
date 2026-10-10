# Hooks

A hook is plugin code that the kernel calls at a fixed point of a session, a turn, a runtime, a model call, a tool call or a commit. A hook guards (stops the operation), rewrites (changes what the operation receives or returns) or audits (observes). It carries no gameplay logic: a mechanic belongs in a runtime or a tool.

The event names are defined once, in `HOOK_EVENTS` (`packages/shared/src/types/hooks.ts`). How each event runs is in `HOOK_SEMANTICS` and `GUARD_HOOK_EVENTS` (`packages/runtime/src/hooks/types.ts`), and the payloads are built in `packages/runtime/src/hooks/wire-helpers.ts`. `packages/runtime/tests/hooks-reference-doc.test.ts` fails when this page and those tables disagree.

## Declaring and registering

The root `PLUGIN.md` lists each event, and the `entry` module registers the handler. The two must match, or the plugin fails to load. One declaration can have several handlers: call `covel.on()` once for each.

```yaml
entry: ./server/index.js
contributes:
  hooks:
    - event: PreToolUse
      enforce: normal
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

`covel.on(event, handler, options?)` takes these options:

| Option      | Meaning                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `match`     | `(payload) => boolean`. The handler runs only when it returns `true`. It receives its own copy of the payload.                                                                                                                                                          |
| `timeoutMs` | Time limit of one call of the handler. Default 5000.                                                                                                                                                                                                                    |
| `enforce`   | `pre`, `normal` (default) or `post`: the ordering group, which must be the one declared in `contributes.hooks`. Within a group the framework's own hooks run first, then plugin handlers in the order of registration; the order between two plugins is not a contract. |

A hook of a plugin runs only in a session where the plugin is active. A hook of a community plugin also needs the player's approval of the plugin's server code for that session; without it the handler is skipped.

## The handler

```ts
type Handler = (ctx: PluginHookContext, payload: Payload) => Promise<Result>;
```

### Context

Every handler of every event receives the same context shape.

| Field             | Value                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `event`           | The event name.                                                                                                                                                                                  |
| `sessionId`       | The session.                                                                                                                                                                                     |
| `turnId`          | The execution the event belongs to. An empty string for `SessionStart` and `SessionEnd`.                                                                                                         |
| `locale`          | The session's content locale, fixed when the session was created. Use it for text the hook adds: `instructionLocaleFor(ctx.locale)` gives the language of the prompt body (`en` or `zh`).        |
| `pluginId`        | The plugin of the runtime the event is about. It is not the plugin that registered the handler. Present for the events marked "runtime" in the table below, absent for the others.               |
| `runtimeId`       | The runtime the event is about, for example `world-init/dimension-tracker`. Present and absent together with `pluginId`. For the two commit events it is the runtime that produced the proposal. |
| `activePluginIds` | The plugins that are active in the session.                                                                                                                                                      |
| `getOwnSettings`  | Returns the resolved settings of the handler's own plugin (manifest defaults, world presets and the player's values), frozen. Call it as `ctx.getOwnSettings?.() ?? {}`.                         |
| `signal`          | An `AbortSignal` that fires when the execution is cancelled or the handler's time limit passes. Hand it to any call that can wait.                                                               |

The runtime's identity is in the context only. No payload repeats `pluginId` or `runtimeId`, so one check (`ctx.runtimeId === "..."`) works for every event.

### Payload

The payload is a private copy. Changing it in place has no effect: return the change in `replace`.

### Result

| Result                                   | Effect                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ action: "continue" }`, or no value    | Nothing changes.                                                                                                                                                    |
| `{ action: "continue", replace: {...} }` | A rewrite. `replace` is merged over the payload field by field, and the next handler receives the merged payload. Each event honours only the fields listed for it. |
| `{ action: "abort", reason }`            | A guard. On a guard event the operation is stopped and `reason` is reported. On any other event it means "no change".                                               |

## How an event runs

- **sequential**: handlers run one after another in order. A `replace` reaches the next handler. An `abort` ends the chain.
- **parallel**: handlers run at the same time. The event has already happened, so a result changes nothing: these events are for auditing and cleanup.

A handler that throws, exceeds its time limit or returns a malformed result is a failed handler. On a **guard** event a failed handler counts as `abort`: a broken policy must not let the guarded operation through. On every other event a failed handler is skipped, the replacements of the handlers before it are kept, and the failure is recorded in the trace (`hook.error`).

## Events

"Scope" says what the event is about. For a runtime event, `ctx.pluginId` and `ctx.runtimeId` name that runtime.

| Event                 | Scope   | Runs       | Guard | A handler may                                        |
| --------------------- | ------- | ---------- | ----- | ---------------------------------------------------- |
| `SessionStart`        | session | parallel   | no    | audit                                                |
| `TurnStart`           | turn    | sequential | yes   | abort the turn                                       |
| `PreCompaction`       | turn    | sequential | yes   | abort this turn's history compaction                 |
| `PostCompaction`      | turn    | parallel   | no    | audit                                                |
| `PreSchedule`         | turn    | sequential | no    | drop or reorder the runtimes selected for the turn   |
| `PreRuntime`          | runtime | sequential | yes   | abort the runtime (it is recorded as skipped)        |
| `PostContextAssembly` | runtime | sequential | no    | rewrite the system prompt and the history            |
| `PreLLMCall`          | runtime | sequential | no    | rewrite the messages, model and tools of one call    |
| `PostLLMResponse`     | runtime | sequential | no    | rewrite the response or ask for a correction         |
| `PostRuntime`         | runtime | sequential | no    | rewrite the runtime's result                         |
| `PreToolUse`          | runtime | sequential | yes   | abort the tool call or rewrite its name or arguments |
| `PostToolUse`         | runtime | sequential | no    | rewrite the tool result or end the tool loop         |
| `PreStateCommit`      | runtime | sequential | yes   | abort a proposal or rewrite its payload              |
| `PostStateCommit`     | runtime | parallel   | no    | audit                                                |
| `TurnStop`            | turn    | parallel   | no    | audit                                                |
| `SessionEnd`          | session | parallel   | no    | audit                                                |

### `SessionStart`

Fires once, after a new session and its imported world data are stored. The session exists already, so a handler cannot stop its creation.

Payload: `{ sessionId, worldId? }`.

### `TurnStart`

Fires at the start of every execution (a player turn, a manual run, a background job), before any runtime is selected.

Payload: `{ playerMessage, activeRuntimes }`, where `activeRuntimes` is the list of runtime IDs of the session.

`abort` ends the execution with no runtime run; the reason is returned to the client as the turn's abort reason.

### `PreCompaction`

Fires before history compaction, in a turn where compaction is due.

Payload: `{ messageCount }`: the number of stored messages that can be compacted.

`abort` leaves the history as it is for this turn.

### `PostCompaction`

Fires after a compaction attempt that `PreCompaction` did not stop.

Payload: `{ compacted, summaryId? }`.

### `PreSchedule`

Fires after trigger selection and before scheduling.

Payload: `{ triggered }`: the manifests of the runtimes selected for this execution.

`replace.triggered` narrows or reorders the set. Entries are matched to the selected runtimes by `name`; an entry that was not selected is dropped, and the kernel keeps its own manifest objects, so a handler cannot add a runtime or change a manifest. `replace: { triggered: [] }` schedules nothing. `abort` means "no change".

### `PreRuntime`

Fires once before a runtime's guard, agent loop or function handler.

Payload: `{ manifest, input }`: the runtime's manifest and the turn input.

`abort` skips the runtime: its result has the status `skipped` and the reason. `replace` is not read.

### `PostContextAssembly`

Fires once for an agent runtime, after its context is assembled and before its first model call.

Payload: `{ systemPrompt, messages, outputKind?, promptTemplate?, inputSlots?, characters? }`. `outputKind` is `story`, `plugin` or `system`. `promptTemplate` is the runtime's prompt body before rendering. `inputSlots` holds the resolved `io.inputs` values. `characters` lists the session's characters (`id`, `name`, `type`, `description`).

`replace.systemPrompt` and `replace.messages` are honoured. The framework's own opening of the system prompt (the runtime frame, the output-language directive and the completion contract) is put back in front of a replaced system prompt, so a handler does not have to carry it over.

### `PreLLMCall`

Fires before every model call of an agent runtime, the calls after tool results included.

Payload: `{ messages, model, tools, stream? }`.

`replace.messages`, `replace.model` and `replace.tools` change this call only; the runtime's own transcript is not changed. `replace.stream: false` makes the call unstreamed. `abort` means "no change".

### `PostLLMResponse`

Fires after every model response, before its tool calls are run.

Payload: `{ response, messages }`: the response and the exact messages that were sent.

`replace.response` replaces the response. `replace.correction` (a non-empty string) rejects the draft: its tool calls are not run, the text is sent to the model as a correction, and the model answers again. A third correction in one run fails the runtime.

### `PostRuntime`

Fires once after a runtime finished, with any status.

Payload: `{ result }`: the `RuntimeResult`.

`replace.result` replaces the result. The kernel keeps `pluginId`, `runtimeId`, `runId` and `turnId` of the original, and the suspension fields of a suspended result. When a handler changes `output` and leaves `canonicalValue` as it was, the kernel discards the old `canonicalValue`, so the value other runtimes read cannot disagree with the rewritten output. The rewritten result is checked against the runtime's `output.schema` again: a function runtime's `canonicalValue`, and an agent's `output` when the hook changed it. A mismatch fails the runtime with `output-schema-invalid` and commits nothing.

### `PreToolUse`

Fires before every tool call of an agent runtime.

Payload: `{ toolCall: { id, name, arguments } }`, with `arguments` as a JSON string.

`abort` skips the call; the reason goes back to the model as the tool's error. `replace.toolCall` changes `name` or `arguments`; `id` is kept.

### `PostToolUse`

Fires after every tool call that ran.

Payload: `{ toolCall, result }`.

`replace.result` replaces the result the model reads. `replace.terminate: true` ends the tool loop after this result is recorded.

### `PreStateCommit`

Fires once for each proposal of an execution, before it is committed. `ctx.pluginId` and `ctx.runtimeId` are the proposal's source.

Payload: `{ proposal }`.

`abort` rejects the proposal with the reason. `replace.proposal.payload` replaces the payload; the type, the source and the IDs of the proposal are kept.

### `PostStateCommit`

Fires after a proposal was committed.

Payload: `{ proposal, result }`.

### `TurnStop`

Fires when an execution finished running its runtimes.

Payload: `{ runtimeResults, durationMs }`.

### `SessionEnd`

Fires when a session is ended or deleted.

Payload: `{ sessionId, reason }`, where `reason` is `ended` or `deleted`.

## Limits

- A hook has no write path of its own. It changes state only through what it returns; a plugin's data is written by its runtimes and tools.
- A handler must not depend on the order of other plugins' handlers, apart from its `enforce` group.
- `io.concealed` runtimes have their prompts and replies removed from traces and the live stream, but a hook of an active plugin still receives them in its payload. A community hook runs only after the player approved the plugin's server code.
