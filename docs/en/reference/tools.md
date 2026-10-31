# Tool registry

A tool is a function the model can call during a run. The model gives a name and arguments, the framework runs it, and the result goes back to the model. This page lists every tool, the arguments and return value of each one, how to write your own tool, and how a tool writes data to storage. Plugin authors who write runtime prompts or tools need it.

There are four kinds of tool:

- **builtin**: included with the framework. Any plugin can use it.
- **plugin**: registered by a plugin in its own `entry` module. Only that plugin can use it.
- **imported**: an agent imports another plugin's model-facing service in `agent.tools.services`, and the framework generates a tool for it when the runtime starts; see [Imported service tools](#imported-service-tools). It is not in the registry, so the overview table does not list it.
- **injected**: a tool the framework adds for a run because of the runtime's declaration, such as `search-tools`.

> [!NOTE]
> In the tables and approval rules below, `local` is an internal source label used by the executor. It means "a tool that a plugin's entry registered successfully." It is not a manifest field. The manifest has no `tools.local` field, and a manifest that sets one fails to load.

> [!NOTE]
> The DashScope and OpenAI image generation tools in the table come from the [official community plugin repository](https://github.com/covel-ai/covel-plugins). The matching tools and UI are registered only after you install the plugin and authorize it in a session.

## Overview

<!-- prettier-ignore -->
| Tool name | Source | Plugin | Approval policy | Description | annotations |
| --- | --- | --- | --- | --- | --- |
| create-form | builtin | — | auto-allow | Create a player form | defaults |
| create-choices | builtin | — | auto-allow | Create a list of choices | defaults |
| create-notification | builtin | — | auto-allow | Show a notification message | defaults |
| render-ui | builtin | — | auto-allow | Render a UI block with its own part states | defaults |
| plugin-data-set | builtin | — | auto-allow | Write one item of persistent plugin data | defaults |
| plugin-data-set-batch | builtin | — | auto-allow | Write several items of persistent plugin data at once | defaults |
| plugin-data-get | builtin | — | auto-allow | Read the current plugin's persistent data | `readOnly`, `idempotent`, `concurrencySafe` |
| plugin-data-list | builtin | — | auto-allow | List the current plugin's persistent data | `readOnly`, `idempotent`, `concurrencySafe` |
| **sync-characters** | builtin | — | auto-allow | Create or update characters in one atomic batch. Up to 5 new characters and up to 10 updated characters | defaults |
| **list-characters** | builtin | — | auto-allow | List all characters in this session (session scope, visible across plugins) | `readOnly`, `idempotent`, `concurrencySafe` |
| **get-character** | builtin | — | auto-allow | Find one character by id, name, or alias | `readOnly`, `idempotent`, `concurrencySafe` |
| **world-dimension-get** | builtin | — | auto-allow | Read current dimension values, frozen for the turn, by ID or path, with paging | `readOnly`, `idempotent`, `concurrencySafe` |
| **world-dimension-list** | builtin | — | auto-allow | List open dimensions with their ID, name, type, and version. Does not dump values or rules | `readOnly`, `idempotent`, `concurrencySafe` |
| **emit-event** | builtin | — | auto-allow | Emit a domain event that the current session has declared (one topic at a time). Advertises a topic enum and per-topic payload schemas | defaults |
| **suspend** | builtin | — | auto-allow | Describe answers with form fields and suspend the runtime to wait for player input. Writes to the `suspensions` table. Can be resumed through the resume API | defaults |
| **runtime-done** | builtin | — | auto-allow | The end signal for the agent tool loop. Call it after the business tool calls are done to end this runtime | defaults |
| **delegate** | builtin | — | auto-allow | Hand one job to a sub-agent and get its output back; the sub-agent writes nothing | `readOnly` |
| **search-tools** | injected | — | auto-allow | Deferred tool search. The framework injects it automatically when a manifest declares `tools.defer`. It uses BM25 search to find and activate tools that were not preloaded | — |
| **memory-search** | builtin | — | auto-allow | Search memory: conversation history and past summaries (recall), plus the long-term knowledge base (archival), which includes lorebook data, characters, and data that plugins declare as searchable | `readOnly`, `idempotent`, `concurrencySafe` |
| initialize-world | local | world-init | auto-allow | Initialize the world by combining the character attribute schema and the dimension declarations | defaults |
| create-character-form | local | char-creator | auto-allow | Create the opening character form. It collects only the character name and the declared string and enum attributes. Numeric and composite attributes keep their defaults | defaults |
| update-affinity | local | affinity | auto-allow | Apply this turn's affinity changes between the player and NPCs in one batch. An unknown name starts at 0. Scores add up across turns and are limited to [-100, 100] | defaults |
| advance-world-time | local | world-time | auto-allow | Settle a reached target time or a duration; the tool computes calendar differences. Random mode takes only a reason. Commits with the story | defaults |
| dimension-rule-get | local | world-init | auto-allow | During maintenance, read private rules or value schemas with paging | defaults |
| update-dimensions | local | world-init | auto-allow | Bind to this turn's narrative. Update the whole batch with compare-and-swap (CAS), or explicitly settle that nothing changed | defaults |
| submit-world-facts | local | world-ir | auto-allow | Submit and validate a complete `contract:world-ir@1` as function calling arguments | defaults |
| sync-codex-entries | local | codex | auto-allow | Submit this turn's codex changes at once. Creates or adds to entries by title | defaults |
| generate-guide | local | guide | auto-allow | Write a plot summary, the current decisions, and quick replies in the player's voice, atomically | defaults |
| upsert-npc-graph | local | npc-graph | auto-allow | Write NPC nodes and relationship edges in one batch. Refers to nodes by name. The tool removes duplicates and assigns short IDs | defaults |
| plan-story-events | local | story-events | auto-allow | Validate the hidden future story events the plot plans (up to 2 per call). Can withdraw planned events that have not happened yet | defaults |
| submit-dashscope-text-prompt | local | dashscope-image-gen | auto-allow | Submit a text scene prompt and emit the fixed DashScope image event | defaults |
| submit-dashscope-structured-prompt | local | dashscope-image-gen | auto-allow | Submit a structured scene prompt and emit the fixed DashScope image event | defaults |
| submit-openai-image-text-prompt | local | openai-image-gen | auto-allow | Submit a text scene prompt and emit the fixed OpenAI-compatible image event | defaults |
| submit-openai-image-structured-prompt | local | openai-image-gen | auto-allow | Submit a structured scene prompt and emit the fixed OpenAI-compatible image event | defaults |

Every tool of a bundled plugin must appear in this table. `apps/server/tests/lib/reference-tables.test.ts` checks this.

## Annotations and timeout

Use `tool({ annotations, timeoutMs, ... })` to describe a tool's side effects and per-call time limit. `tool()` resolves four booleans. Without annotations, a tool is treated as writing and unsafe for concurrent execution.

<!-- prettier-ignore -->
| Annotation | Default | Meaning |
| --- | --- | --- |
| `readOnly` | `false` | Only reads data; returns no write proposals or domain events |
| `stagesWrites` | `!readOnly` | Stages writes for the execution transaction to commit |
| `idempotent` | `false` | Repeating the call with identical arguments adds no side effects |
| `concurrencySafe` | `false` | Safe to execute concurrently with other reads; requires `readOnly: true` |

```js
tool({
  name: "lookup-note",
  description: "Read one saved note.",
  parameters: z.object({ key: z.string() }),
  annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
  timeoutMs: 5000,
  execute: async ({ key }, context) =>
    context.store.getPluginData("notes", key),
});
```

These definitions throw when `tool()` is called, with an error starting with `Tool "<name>":`: combining `readOnly: true` and `stagesWrites: true`; setting `concurrencySafe: true` without `readOnly: true`; or a `timeoutMs` that is not an integer in `[1, 600000]`. The registry also validates all four annotations and the timeout. Hand-built `ToolModule` objects must supply complete annotations; plugins using `tool()` receive the defaults automatically. Annotations and timeouts are framework metadata. Model definitions still contain only the name, description and parameter schema.

Omitting `timeoutMs` sets no per-tool limit; the runtime deadline still applies. A tool timeout returns `{error:{code:"timeout",message}}`, records a failed call and emits `tool.failed`. The tool loop can continue. The invocation's authority and signal are revoked; proposals, domain events and late results are discarded. The executor retains ownership of the callback and waits for it during shutdown. Parent cancellation from a runtime deadline, player stop or executor shutdown still produces `cancelled`.

If a `readOnly: true` tool returns proposals or domain events, the call fails with `internal` and a message containing `read-only tool returned writes`. This check runs before recording success or emitting `tool.completed`, and all writes are discarded. Other annotations are author declarations and do not imply that storage has committed.

In the overview table, “defaults” means the default combination above; `—` means the loop handles the call directly without module annotations. Character tools currently retain defaults too. The SDK's `FRAMEWORK_TOOL_NAMES` is the single source of reserved names. A test checks equality in both directions against the default registry, optional memory tools and `search-tools`.

If a declared `tools.plugin` tool is not registered, even when deferred by `tools.defer`, the runtime fails before calling the model: `runtime "<id>" declares plugin tool "<name>", but its plugin did not register it`. A builtin capability absent from the host is still omitted with a warning: `builtin tool "<name>" is not installed on this host — not offered`.

## Execution within one batch

One model reply can contain several agent tool calls. After `PreToolUse` rewrites a call, it joins the parallel pool only when the runtime authorizes its name and the tool declares both `readOnly: true` and `concurrencySafe: true`. Consecutive eligible calls form one pool, with at most 8 running at once. `concurrencySafe` is the author's promise that concurrent reads do not cause side effects through shared state. The kernel rejects writes and events returned by a read-only tool, but cannot inspect external side effects.

Every other call is a barrier and runs alone: it waits for the preceding pool to finish, and later calls wait for the barrier. Unknown tools, undeclared names and the loop-handled `search-tools`, `suspend` and `runtime-done` calls are barriers. `delegate` does not declare concurrency safety and always runs serially.

Tool messages, call records, proposals and events are collected in model order, regardless of completion order. A pooled call that exceeds its own `timeoutMs` returns `timeout` and counts as a failed call; its siblings and the loop continue. There is no default per-tool timeout. Omitting it keeps the runtime deadline as the limit; concurrent tools that wait on network reads should set `timeoutMs`.

Calls skipped by a hook, suspension or loop termination still receive tool results and trace events explaining the reason. They do not count as executed calls, failures or step tool statistics. Before another model request, including output repair, the loop answers every unanswered call without executing it again.

## How tool calls work

This page follows the implementation in these three places: `apps/server/src/routes/api/bootstrap/tools.ts`, `packages/tools/src/builtin/`, and `plugins/**/tools/`.

### Choosing an option

When a runtime needs a capability, choose in this order:

1. A general capability that repeats and that many plugins use: use an existing builtin tool, and list its name in the runtime's `tools.builtin`.
2. A capability specific to one plugin (its own schema, search, NPC relationship upkeep, codex upkeep, and so on): register it with `covel.registerTool()` in the plugin's `entry` module. Then list its name in the runtime manifest's `tools.plugin` so the model can see it.
3. A capability that several plugins use over the long term, with a stable agreement: promote it to a new builtin tool.

### A minimal plugin you can copy

The plugin below has one tool, `echo-value`, which returns the value it receives as it is. It uses three things: an `entry` module, `covel.toolkit.tool()`, and `agent.tools.plugin` in the manifest.

```text
~/.covel/plugins/echo-demo/
├── PLUGIN.md
└── server/index.js
```

The plugin ID is the folder name, `echo-demo`; the entry module is `server/index.js` by default; no `package.json` is needed. To make it a bundled plugin under `plugins/` in the repository, add a `package.json` for the workspace with `name`, `private` and `"type": "module"`.

```yaml
# PLUGIN.md
---
description: Echoes one short value for a smoke test.
contributes:
  tools: [echo-value]
runtime:
  schedule:
    trigger: { type: manual }
  agent:
    loop: { maxSteps: 2 }
    tools:
      plugin: [echo-value]
---
When manually triggered, read `payload.value` from the `<runtime-activation>`
block, call `echo-value` once, then call `runtime-done`.
```

```js
// server/index.js
export default function (covel) {
  covel.registerTool(
    covel.toolkit.tool({
      name: "echo-value",
      description: "Echo one short value.",
      parameters: covel.toolkit.z.object({
        value: covel.toolkit.z
          .string()
          .min(1)
          .max(80)
          .describe("Value to echo (1-80 characters)."),
      }),
      execute: async ({ value }) => ({ ok: true, value }),
    }),
  );
}
```

Key points:

- `description` is required. `id` comes from the directory name, and `kind` defaults to `plugin`. If `entry` is omitted, the loader uses `./server/index.js` when that file exists; an explicit path must be a relative `.js` path inside the plugin root.
- `tools.plugin` only lets the model see the tool. The tool itself must be registered first, by calling `registerTool()` from the entry.
- Use the framework's `covel.toolkit.tool` and `covel.toolkit.z`. This way the plugin does not need its own Zod dependency, and the parameter schema and the runtime `invalid-input` come from the same toolkit. Do not mix in a different copy of Zod that the plugin bundles itself in the same definition.

What happens at runtime:

- When the agent calls `echo-value` successfully, it gets `{ "data": { "ok": true, "value": "..." } }`: the returned content goes into `data` after `modelFacingJson`. Code, such as `ctx.tools.call`, still reads `{ ok, value }`. For the other shapes, see [Unified result format and error codes](#unified-result-format-and-error-codes).
- `tool()` turns the parameters into a JSON Schema for the model to see. When the tool runs, the same Zod schema checks the arguments. If `value` is missing, is an empty string, or is longer than 80 characters, the model gets `invalid-input`, and `execute` is not called.

Two related points:

- **To save data**: use the builtin `plugin-data-set` instead (list it in `tools.builtin`). It returns `{ namespace, key }`, and it hands the write to the end-of-turn commit flow as a `plugin.data` proposal, so the result the model reads carries the `staged` notice.
- **To let the UI or HTTP trigger one plugin action directly**: that is not a tool. Register it in the entry with `covel.registerRpc(action, handler)`, and call it through `POST /api/sessions/:id/plugin-rpc`. RPC is not given to the model, so do not put it in `tools.plugin`.

#### Malformed argument JSON from the model

The argument JSON a model writes often has a few typos that come up again and again. Each one has only one reasonable meaning. The framework fixes them while it parses, which saves a round where the model has to resend. The fixed content must still pass the tool's schema.

Repaired arguments are written back to model history as valid JSON, including tool names and arguments rewritten by `PreToolUse`. An unrepairable call still returns `invalid-input`; history preserves its original text as a JSON string rather than an empty object that appears to have been executed. The original response and tool-call traces retain diagnostic evidence. The framework does not resend an unchanged request after the provider rejects history arguments.

| Typo                                                   | Example                                                | How it is fixed                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extra closing brackets at the end                      | `{"updates":[{"id":1}]}]}`                             | When up to four extra `]` or `}` follow one complete JSON value, they are removed. The value before the brackets is complete, so removing the extra brackets changes none of its content.                                                                                                                                                                          |
| Quotes inside a string value not escaped               | `"note": "铭文把它叫作"锁"而不是灯。"`                 | A quote that ends a JSON string may be followed only by `,`, `}`, `]`, `:`, or the end of the text. A quote followed by other text is part of the value, and it is treated as `\"`. This happens only when the quotes come in pairs. Key names are never changed. An extra or missing quote (`"name": "Mira"", …`) is a structural error and is not in this group. |
| An array element starts before the previous one closes | `[{"id":"a","attributes":{"kind":"lamp"}, {"id":"b"}]` | When the last field of an element is an object, the model wrote only that field's closing bracket. Inside an object, after a comma only a key name may follow. A `{` there means it is the next element of the outer array, so the missing `}` is added before the comma.                                                                                          |
| Closing brackets do not match the open ones            | `[{"id":"a"},{"id":"b"}}]`, `[{"id":"a"},{"id":"b"}}`  | When there is an extra `}` where no object is open, it is removed. When the last bracket in the text is the wrong kind, it is replaced with the matching one. Neither case changes any value or adds text that was not there. Brackets of the wrong kind in the middle (`{"a":[1,2},"b":3}`) are not in this group.                                                |
| An object's opening written twice                      | `[{"id":"a"},{"{"id":"b"}]`                            | Valid JSON never has `{"{"` in front of a key name, so the repeated `{"` is removed.                                                                                                                                                                                                                                                                               |

A few limits:

- The last three rows are each tried on their own. They do not stack, and the corrected text must parse as it is.
- Why they do not stack: the third row has another reading, where the model left out a key name (`"summary":"…", {"role":"…"}}]`). Only one of the two readings makes the brackets balance. Stacking the fixes would read the text that "left out a key name" as two elements. So text written with the other reading still raises an error.
- These rules apply both to the whole call arguments and to JSON text inside a field.
- Other errors are not guessed at. A truncated output, a missing comma between two strings, and a quote inside a value followed directly by `,` or `:` are not fixed. If the whole argument is still not valid JSON, the call fails with `invalid-input`, and the model must give the arguments again.

**An array or object was written as a JSON text.** When the schema expects an array or object at some position, but the model gave a string, `tool()` first parses that text with the rules above, and then checks it again. The parsed content must still pass the same schema.

This kind of text field has one extra rule: **an open bracket left at the end of the text is closed** (`[{"id":"a"},{"id":"b"}`). The reason is that the outer arguments already parsed successfully, so the text was finished by the model itself and was not cut off. After closing it, the result must still parse as it is. A value that is not finished (`[{"id":"a"},{"id":`) still raises an error. This step is not done on the whole call arguments, because those may really be a cut-off output.

When the text cannot be parsed, `invalid-input` states the reason for the failure and the position, and asks the model to pass the array or object itself directly.

**Regular expressions with Unicode property escapes.** When `tool()` generates the JSON Schema for the model, it removes any `pattern` that uses forms such as `\p{Letter}`. The reason: a JSON Schema `pattern` has no regex flags, and these forms mean what the author intended only with the `u` flag. A provider that validates tool schemas rejects the whole request as "not a valid regex," and every call with that tool then fails. Zod still checks the argument values against the original regex. Write the rule itself in the field's `describe()` so the model can see it.

### Finding and checking failures

| Symptom                                   | Cause and check                                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The tool is not in the model's tool list  | Check whether the runtime lists the correct name in `tools.builtin` or `tools.plugin`. For a plugin tool, also confirm that the entry loaded successfully, that no name is duplicated inside the plugin, and that the name does not take a framework reserved name.  |
| `unavailable`                             | The final tool name is not in this runtime's allowed set, or a hook changed the name to a tool that is not allowed. Check the runtime manifest first, then the final tool name in the trace.                                                                         |
| `invalid-input`                           | The error line and `details` give the field path and the Zod message. Do not retry blindly with the same arguments.                                                                                                                                                  |
| RPC returns `401` / `403`                 | Check the session's owner or operator token.                                                                                                                                                                                                                         |
| RPC returns `202 approval-required`       | This is usually what a community plugin returns on its first run. Approve it, then retry the original request.                                                                                                                                                       |
| RPC returns `404`                         | Usually the session, the action, or the runtime does not exist.                                                                                                                                                                                                      |
| RPC returns `409`                         | Common when the session is not active, when there is a lock conflict, or when the approval scope has changed.                                                                                                                                                        |
| A write seems to succeed but is not saved | A successful tool result only means the proposal has been buffered. Check `execution.completed.committed`. When the runtime result is `failed` or `suspended`, the proposal is not committed. For a commit failure, look for `proposal.failed` in the action stream. |

Minimal verification commands (from the repository root):

```bash
pnpm validate:plugin plugins/echo-demo
pnpm --filter @covel/tools test
pnpm --filter @covel/runtime exec vitest run tests/proposal-type-contract.test.ts
```

`validate:plugin` checks only the manifest. Use the plugin's own Vitest tests to check the tool's arguments and return value. For the proposal commit convention, see `packages/runtime/tests/proposal-type-contract.test.ts`.

### What builtin tools are for

Builtin tools are system-level building blocks, suited to being reused directly by many plugins. For example:

- `plugin-data-*`
- `render-ui`
- `create-form`
- `create-choices`
- `sync-characters`
- `world-dimension-get` / `world-dimension-list`

### What plugin tools are for (internal source label: `local`)

A plugin tool wraps the plugin's own business logic. Its schema, text, and data structures are defined and maintained by the plugin package itself. For example:

- `generate-guide`
- `upsert-npc-graph`
- `sync-codex-entries`

### Directory and access boundaries

- A plugin tool is registered with `covel.registerTool()` in the plugin's `entry` module. `entry` is a field in the manifest frontmatter, and it is resolved from the plugin root.
- At startup, the entry path is checked, and only files inside the plugin directory are loaded.
- Tools are registered by `(pluginId, name)`. Different plugins can use the same name. If one plugin uses a duplicate name, or a framework reserved name, that whole batch of registrations fails and is rolled back.
- A declaration in `tools.plugin` does not register an implementation. A call passes two checks: the runtime's tool allow-list, and the calling plugin's own registry. A name that is not registered does not fall through to another plugin's tool with the same name.
- The model, `ctx.tools.call`, and `tools.defer` all use the tool's original name.
- To expose a capability across plugins, use a service. A running tool calls another plugin's services through `context.services`, with the same rules as a function runtime's `ctx.services`; an agent imports model-facing services as tools with `agent.tools.services`.

### Not a tool: framework features on `FunctionHandlerContext`

`ctx.gateway`, `ctx.media`, `ctx.images`, and `ctx.utils` are not tools. They are JavaScript APIs that the code of a function runtime's handler calls directly. They **do not go through** the tool registry or the approval flow, and the model cannot call them.

This is especially true for image generation. Do not declare a `generate-image` tool for the model to call. Write `await ctx.images.generate({...})` directly in `handler.js`.

For the full `ctx` capability table and the image generation conventions, see [Advanced § Background work and failures](../plugins/advanced.md#background-work-and-failures).

### A function runtime calls tools

A function runtime calls a tool with `await ctx.tools.call(name, args)`. It can call only the tools in the manifest's `tools.builtin` / `tools.plugin` allow-list. It goes through the same flow as a model tool call: argument validation, tool approval, `PreToolUse` / `PostToolUse` hooks, audit, and proposal commit.

Rules:

- Calls run in order. A later tool can read writes from earlier calls that are not yet committed.
- **If any one call fails, the whole runtime fails.** Even if the handler catches the exception, no partial writes are committed.
- Arguments that cannot be serialized (for example a BigInt or a circular reference) also make the whole runtime fail, and the call is rejected with a `ToolError` coded `invalid-input`. A call blocked by a `PreToolUse` hook is `refused`; a call queued after a `PostToolUse` hook terminated is `cancelled`; a host without a tool executor gives `unavailable`.
- After the runtime times out or ends, the call handle is no longer valid.
- Only a successful runtime hands its domain writes together with `ctx.pluginData` to the execution transaction.
- This interface is for function runtimes only. It is not available to an agent's guard.

When `PostToolUse` returns `terminate`, the result of the current call is kept, and any tool call the handler makes after that is rejected. The handler can still return the current result normally. But a rejected later call also makes the runtime fail.

The `logicalTurn` in the tool's `context` and the `ctx.logicalTurn` in the handler are the same value: the turn number fixed when this execution started. It does not change with the number of tool calls or messages, and it is not read again during the execution. When an independent lightweight host does not provide a turn number, this field can be left out.

### Current code status

- A plugin tool can read the `context.store` injected for each call. Persistent writes are handed to the commit flow through `withPendingProposals(...)`.
- A deterministic function handler calls the tools it declared with `ctx.tools.call()`, and writes its own data with `ctx.pluginData`.
- A community plugin's handler does not get a full writable `store`.

The stable agreements a plugin exposes to its runtime are best kept inside the plugin directory, with the plugin maintaining its own tests.

## Builtin tools

These are tools the framework includes. They are defined in `packages/tools/src/builtin/*.ts`. Any plugin can use one by writing its name in `tools.builtin`, with no code needed.

The public SDK exports `FRAMEWORK_TOOL_NAMES`. Tool registration and static plugin validation use the same list of names.

### create-form

Create a form that the player must fill in. The framework renders it. After the player submits it, the result goes into the context for the next turn.

A form that a manual runtime opens through the plugin's UI works the same way. The template is saved inside the transaction, so the player can keep filling it in after a refresh, and the server also validates it. A manual output with no interaction is not written to the conversation history.

Plugins can use the SDK's `fillNarrativeTemplate(template, values)` for a preview. The submitted `filledNarrative` uses this same function: missing values become empty strings, duplicate full stops at placeholder boundaries are merged, and field text is preserved. Within one agent execution, successful tool results with the same `interactionId` show only the last successful form or choice. A failed call does not replace it.

| Argument          | Type        | Required | Description                                               |
| ----------------- | ----------- | -------- | --------------------------------------------------------- |
| formId            | string      | ✓        | Unique ID of the form                                     |
| title             | string      | ✓        | Form title                                                |
| fields            | FormField[] | ✓        | List of form fields                                       |
| submitLabel       | string      | ✓        | Text on the submit button                                 |
| narrativeTemplate | string      | ✓        | Narrative template, with `{{fieldName}}` placeholders     |
| validation        | object      |          | `{ name, data? }`, see below                              |
| submitBehavior    | object      |          | `{ echoFilledNarrative? }`                                |
| notice            | string      |          | A note above the fields, see below                        |
| actionKind        | string      |          | Which action kind the answer is; default `act`, see below |

`actionKind` is the action kind the player's answer is submitted as: a base kind (such as `say` or `act`) or a plugin kind `<pluginId>/<name>`. The server checks the answering seat's role against it and refuses an answer submitted as another kind (`invalid_action`); see [API · player interactions](./api.md#player-interactions).

**FormField**: `{ type, name, label, placeholder?, options?, required?, defaultValue?, min?, max?, step? }`

- type: `text` | `textarea` | `select` | `checkbox` | `number`
- `name` is the required field identifier; `id` cannot replace it.

Rules for field values:

- The default value and the submitted value of a `number` field are finite numbers. A `checkbox` is a boolean. The other types are strings.
- A number field supports `min`, `max`, and a positive `step`. Steps count from `min ?? 0`.
- The front end keeps the value as a number. The server checks it again and turns any number string it receives into a number.
- When a number field is cleared, it does not become 0, and the default value is not applied again. If the field is required, the submission is rejected.
- A field that is not submitted uses its default value, including 0 and false. A text or select field that is submitted as an empty string also uses its default value.
- `placeholder` is for display only.
- The default value of a `select` field must be one of its options.
- Defaults for `number` and `checkbox` fields do not accept strings; write numbers and booleans directly.

#### Custom validation with `validation`

`validation: { name, data? }` points to a validation function in the plugin that emits the form. The function takes effect only when two things are true: it is declared in `contributes.forms` in the root `PLUGIN.md`, and it is registered with `covel.registerFormValidator(name, validator)`. It must be a synchronous pure function.

The function receives three arguments:

1. The normalized `values`.
2. The form's `data`. It cannot be changed at submit time.
3. `{ locale, messages }`: the session language, and the plugin's translations in that language. You can pass it directly to `translate`.

Return values:

| Return                                                             | Effect                                                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `undefined`                                                        | Passes.                                                                                                                        |
| A string                                                           | An error for the whole form.                                                                                                   |
| `{ field, message }`, or an array of them (type `PluginFormIssue`) | The message shows under the field named `field`. If `field` is not a form field, it is treated as an error for the whole form. |

Errors are shown to the player. Use `translate(context, "...")` to write them in the session language, saying what is wrong and how to fix it.

What happens on submit:

- The source plugin is set by the `sourcePluginId` of the submitted message. The client cannot choose it. The framework uses `findCommittedInteraction` to find the submitted form, and authorization and validation use the same source record.
- The whole submit batch is saved only after every field check and every cross-field check has passed.
- The plugin must still be enabled and authorized. A missing validator is not skipped quietly.

Responses a submit can get:

| Case                                                                           | Response                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The plugin's validator rejects the form                                        | 400, `code: "form_rejected"`. Nothing is written. The player can change the original form and submit again.                                                                                                                        |
| The framework's own field checks fail (required, number, range, step, options) | Also 400 and `form_rejected`. The error text uses the field's `label` and the session language, with one line per field with an error. The response's `details.issues` gives the field name for each one (see [api.md](./api.md)). |
| An unknown field, or the submitted form cannot be found                        | 400, with no `form_rejected` error code. The client should not send this request.                                                                                                                                                  |
| An interaction that was already answered is submitted again                    | 400, `code: "interaction_already_submitted"` (see [api.md](./api.md)).                                                                                                                                                             |
| The form refers to a validator that was not declared                           | 400, `form_validator_undeclared`. The form must be generated again. Authorization cannot fix this.                                                                                                                                 |
| The server has restarted, or the authorization was revoked                     | The submit endpoint first asks for the source plugin's server-code authorization (202). After authorizing, retry the original submit.                                                                                              |
| The plugin has been disabled or uninstalled                                    | 400.                                                                                                                                                                                                                               |

> [!WARNING]
> `validation.data` is part of the form block. It is sent to the player's client in SSE events and in the session view, and it is saved in the session messages (the checkpoints of the browser-private profile include it too). Do not put anything in it that the player should not see. When a value needs to stay private, store a salted digest instead of the original value. The `player-name` validator of `char-creator` compares character names this way.

#### Notice `notice`

`notice` is a string written in the session language. The client shows it above the fields to explain why this form has appeared again.

- A form sent for the first time does not have it.
- When an accepted submit can no longer be used and the form has to be sent again, the plugin sets `notice`, and it sets the previous value as the field's `defaultValue`.
- The `interaction` returned by a tool has a field with the same name. When a runtime emits a form directly through `effects.interactions`, `notice` is written on the form object too (SDK type `PluginFormInteraction`).

#### Character creation form

Character creation uses the dedicated `create-character-form` tool. It collects only the required name, and the string or enum attributes that the world declares.

The tool returns `filledNarrative` so the model can read each complete sentence before finishing, then revise the defaults or template if needed. Defaults should be short phrases that fit their slots, and `calling` should be a concrete calling from the world. The tool rejects repeated words at adjacent boundaries and explicit English or Chinese undecided placeholders, returning the preview and correction advice without emitting a form. These checks do not change earlier player answers. The undecided-value check also preserves enum choices explicitly declared by the world. The model reviews semantic repetition elsewhere in the sentence using the preview.

- When creating the player, declared string name attributes (`name`, `characterName`, `playerName`, `姓名`) use the character name submitted in the form, overriding the schema's default name.
- A model cannot set a validator for it. There is no `validation` argument, and if one is passed it is dropped. The tool attaches the `player-name` validator that `char-creator` registers itself, and it rejects a character name that is the same as the name or an alias of a character already in the world (see [World Model](./world-model.md)). The other field constraints are checked by the tool and by the submit endpoint.
- An accepted character form does not leave the session stuck in setup:
  - When a world attribute's default value does not match its own type, that default is not written when the character is created.
  - When the attribute type changes after the form was sent, so that the values the player submitted are no longer accepted, the next setup run sends the form again. Old answers that are still valid are already filled in, and the form carries a `notice`.

**Used by**: char-creator

### create-choices

Create a group of options for the player to choose from. Use it for decision points, branching story lines, and NPC dialogue options.

| Argument   | Type     | Required | Description                                                                     |
| ---------- | -------- | -------- | ------------------------------------------------------------------------------- |
| choiceId   | string   | ✓        | Unique ID of the group of choices                                               |
| prompt     | string   | ✓        | Guiding text (for example "What will you do?")                                  |
| choices    | Choice[] | ✓        | List of choices (at least 2)                                                    |
| actionKind | string   |          | Which action kind the answer is; default `say`, with the rules of `create-form` |

**Choice**: `{ id, label, description?, category? }`

- category: `safe` | `aggressive` | `creative` | `wild`, and so on

**Used by**: general interaction plugins. The bundled `guide` does not use it. `guide` uses the `generate-guide` plus `ui.message` path. It shows fuller content through its own plugin UI, and it passes the same short phrases to stage mode through `stage.choices@1`.

### create-notification

Show a notification in the front end. Use it for status changes, getting an item, a triggered event, and similar cases.

| Argument | Type   | Required | Description                              |
| -------- | ------ | -------- | ---------------------------------------- |
| level    | enum   | ✓        | `info` / `success` / `warning` / `error` |
| title    | string | ✓        | Notification title                       |
| message  | string | ✓        | Notification text                        |

The tool returns a `ui` block, whose content is the spec for an `Alert` component. It is submitted as a `ui.render` proposal and shows up in the message stream. The front-end `Alert` component renders only level, title, and message.

**Used by**: codex

### render-ui

Render a `ui.render` block. A block is made of several parts, and each part has its own state. It suits output that mixes story text, images, cards, and audio.

| Argument | Type           | Required | Description                    |
| -------- | -------------- | -------- | ------------------------------ |
| parts    | UIRenderPart[] | ✓        | List of UI parts               |
| layout   | enum           |          | `stream` / `split` / `overlay` |

**UIRenderPart**:

```typescript
type UIPartStatus = "pending" | "streaming" | "success" | "error" | "paused";

interface UIRenderPart {
  id: string;
  type: string;
  status: UIPartStatus;
  content: unknown;
  retry?: { count: number; lastError?: string };
}
```

The tool returns `{ ui: [{ parts, layout? }] }`, and the framework builds a `ui.render` proposal from it. Every UI block must include `parts`; blocks without `parts` are rejected.

### plugin-data-set

Write one item into the plugin's persistent storage. Data is isolated by `(sessionId, pluginId, namespace, key)`. Writing the same `(namespace, key)` again replaces the old value.

| Argument  | Type    | Required | Description                                            |
| --------- | ------- | -------- | ------------------------------------------------------ |
| namespace | string  | ✓        | Data namespace (such as `schema`, `entries`, `config`) |
| key       | string  | ✓        | Data key name                                          |
| value     | unknown | ✓        | JSON data to store                                     |

**Output**: `{ namespace, key }`

**Governance path**: the write is not saved right away. It is committed through the session kernel's commit flow, like any other write. It goes through `PreStateCommit` / `PostStateCommit`, the trace, and the storage transaction.

#### Size limit for one value

A value, once serialized to JSON, must not be larger than **256 KiB** (in UTF-8 bytes; `MAX_PLUGIN_DATA_VALUE_BYTES`, `packages/shared/src/utils/plugin-data-limits.ts`).

What happens when the limit is exceeded:

- `plugin-data-set` and `plugin-data-set-batch` report an error at call time: `The value for <namespace>/<key> is N bytes; the limit for one value is 262144 bytes. …`. In a batch, if one item is over the limit, the whole call fails. The model then writes less or splits the data, and it does not wait until commit, when the value would be dropped together with the runtime's other writes.
- Writes fail through the other entry points. The error gives the plugin ID, the `namespace/key`, the actual size in bytes, and the limit. The stored value stays as it was, and it is not cut short.

The same limit applies at every write entry point:

| Entry point                                                                      | When the limit is exceeded                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Tools `plugin-data-set` / `plugin-data-set-batch`                                | Error at call time                                                                                                |
| Commit of `plugin.data` / `plugin.data.batch`                                    | The commit fails                                                                                                  |
| Commit of `plugin.data.update` (the result after the operations)                 | The commit fails                                                                                                  |
| `ctx.pluginData.set` / `ctx.pluginData.update`, the store view of an RPC handler | The write fails                                                                                                   |
| REST `PUT /api/sessions/:id/plugin-data/...`                                     | Returns `413`                                                                                                     |
| World package import                                                             | The record gets an error diagnostic. The import fails and is not truncated. `pnpm validate:world` reports it too. |

For reference, the largest seed record in the bundled worlds is about 7 KB. To store more, split it into several keys, or keep only the part that later turns will read.

#### Reserved namespaces

A namespace that starts with `_` belongs to the framework's own bookkeeping, and plugins cannot write to it. For example: `_jobs` (old background jobs), `_runtime_jobs` (detached jobs), and `_logs` (the runtime log ring). Reading is not affected.

This rule is enforced in one place, by `reservedPluginDataNamespaceError()` (`packages/shared/src/utils/plugin-data-namespace.ts`). It covers every plugin-side write entry point:

- REST `PUT /api/sessions/:id/plugin-data/...`
- Commit of `plugin.data` / `plugin.data.batch`, including proposals normalized from a function runtime's output
- `ctx.pluginData` in a function runtime or an agent guard
- The store view of an RPC handler. Every plugin's RPC action, including those of bundled plugins, gets an immediate write capability bound to the session and the plugin through `createRpcHandlerStoreView()`

Neither kind of plugin handle exposes the host's transaction, session lifecycle, or store-closing methods. The framework's own privileged writers (the background job runner and the runtime log) call the store directly and do not use these entry points.

### plugin-data-set-batch

Write several items in one call. The model does not have to call once per item, which saves many round trips. It suits cases where a lot of entries must be written at once, such as world initialization.

| Argument | Type                           | Required | Description                             |
| -------- | ------------------------------ | -------- | --------------------------------------- |
| items    | Array<{namespace, key, value}> | ✓        | Array of data items to write in a batch |

Each item:

| Field     | Type    | Required | Description        |
| --------- | ------- | -------- | ------------------ |
| namespace | string  | ✓        | Data namespace     |
| key       | string  | ✓        | Data key name      |
| value     | unknown | ✓        | JSON data to store |

**Output**: `{ count, items: [{ namespace, key }] }`

**Governance path**: committed through the commit flow, the same as a single write. The whole batch is one proposal. Hooks, the trace, and the transaction are handled the same way as for a single write.

**Design principle**: this is a general batch write. For a specialized case, such as world initialization, it is better for the plugin to write its own tool. A more precise schema then guides the model to produce correctly structured data.

### plugin-data-get

Read one item from the **current plugin's** storage. Reading across plugins is not allowed.

| Argument  | Type   | Required | Description    |
| --------- | ------ | -------- | -------------- |
| namespace | string | ✓        | Data namespace |
| key       | string | ✓        | Data key name  |

**Output**: `{ found, namespace, key, value?, updatedAt? }`

`updatedAt` is the stored timestamp, even when pending writes change the visible value. Pending-only rows omit it. The scoped store view and plugin-data lists follow the same rule; `createdAt` is also omitted until a row has been stored.

**It can read what it just wrote.** A write is committed only when execution finishes. But a read adds in the uncommitted `plugin.data` / `plugin.data.batch` / `plugin.data.delete` / `plugin.data.update` operations from this execution:

- Only pending operations for the **current session and current plugin** are applied.
- For the same key, operations are applied in proposal order, and the last one wins. After a delete, the read returns `found: false`. A later write makes the read return the new value.
- Writing `null` stores a value. It is not the same as a delete.
- The operations of a `plugin.data.update` are applied on top of the stored value (or the pending writes before it), with the same `applyDataOps` the commit uses. An update whose operations fail on that value is skipped, because the commit rejects it too.
- The writes that completed upstream runtimes of the same plugin made in this execution are added in too, before this runtime's own writes and in commit order. Other plugins, siblings of the same level, and the upstream results a retry or a background job brings are not added. Rules: [In-execution plugin-data visibility](./plugins.md#in-execution-plugin-data-visibility).
- A runtime that read an upstream write depends on it: when the upstream is dropped at commit, an auxiliary runtime is dropped with it.
- When the tool context has `context.store`, both read tools read through it, so they see what a function handler's `ctx.store` sees and record read dependencies; a host without `context.store` adds only `context.pendingProposals`.

**What cannot be read.**

- Hidden world data (`_hidden.<namespace>`, from a source with `visibility: hidden`, or added by a plugin during the story) is not returned to the model. Reads always return `found: false`.
- Any kernel namespace that starts with `_` is never exposed to the model.
- `plugin-data-set` / `plugin-data-set-batch` reject any namespace that starts with `_`, so the model cannot use the general tools to write hidden data either.

### plugin-data-list

List all items in one namespace of the **current plugin**.

| Argument  | Type   | Required | Description                            |
| --------- | ------ | -------- | -------------------------------------- |
| namespace | string |          | Data namespace (if omitted, lists all) |

**Output**: `{ count, items: [{ namespace, key, value, updatedAt? }] }`

- As with `plugin-data-get`, pending writes and deletes from this execution are added in, including the writes of upstream runtimes of the same plugin. A deleted item does not appear in the list.
- A list with a `namespace` depends on every upstream runtime that wrote that namespace; without one, it depends on every upstream runtime that wrote plugin data.
- The `namespace` filter also applies to pending items. When it is omitted, all namespaces are merged.
- The namespaces of hidden world data do not appear in the results.

Reads and merges match the full `(namespace, key)` pair of strings exactly. They do not split on control characters, and they do not rewrite fields. The exported `overlayPluginDataRows()` uses `JSON.stringify([namespace, key])` as the Map key; its fourth parameter `baseRows` holds the stored rows that a `plugin.data.update` starts from. Buffered reads in a function runtime and in a guard follow the same rules.

### runtime-done

Only a successful `runtime-done` call returning its sentinel ends the loop. The same field in another tool’s result is ordinary data.

An agent uses it to tell the framework "I am done." Call it after all the business tools have been called. The runtime then ends, and the model does not have to write a closing message.

Call it last, only after every needed tool call has succeeded or when nothing needs doing. It records nothing. The run ends after this response; make no more calls or prose. The optional reason is kept in the trace.

| Argument | Type   | Required | Description                 |
| -------- | ------ | -------- | --------------------------- |
| reason   | string |          | Optional note for the trace |

A story runtime's tool list does not include it. See [ToolExecutor](#toolexecutor).

### memory-search

Search the session's memory. It looks in two sources:

- **recall**: the conversation history and past summaries.
- **archival**: the long-term knowledge base, including lorebook, characters, and data that plugins declare as searchable.

| Argument | Type   | Required | Description                                                       |
| -------- | ------ | -------- | ----------------------------------------------------------------- |
| query    | string | ✓        | Names and keywords to find. Several wordings can be given at once |
| scope    | enum   |          | `recall` / `archival` / `all`, default `all`                      |
| limit    | number |          | Maximum number of results, 1–20, default 5                        |

Both keyword and vector search return an excerpt around a query term: up to 500 source characters, plus ellipses and the recall role prefix. A semantic hit without a literal query term returns a prefix excerpt. The tool preserves the excerpt without truncating its ending. An archival result's `key` is a readable source identifier. When a lorebook entry has no first keyword, it may use a readable entry ID, but never a UUID. UUID keywords and plugin data keys are also omitted: the result keeps its content without a `key`. The next section describes retrieval.

### Plugin memory and vector search

This section explains how `memory-search` searches, and how plugin data gets into the search scope.

**No embedding model is needed.** When no embedding slot is configured, recall and archival rank results with BM25 (`rankTexts` from `@covel/plugin-handlers-utils`):

- Both the query and the texts are split into words. Chinese, Japanese, and Korean text is split into pairs of adjacent characters. English is split into words, and plurals and possessives are reduced to the base form.
- A word that appears in only a few texts (a person's name, an item's name) gets a high weight. A word that appears in almost every text gets a weight close to zero. A long text is not penalized just for being long.
- It matches only literal text, not paraphrases. So the tool description asks the caller to put the names involved in the query, and it can take several wordings at once.

When an embedding slot is configured and the store supports vectors, the search uses vector retrieval instead. If that fails, it falls back to BM25. When vector recall has too few results, keyword hits fill the remaining places and are deduplicated by message ID. Distinct messages with identical text in the same turn remain separate hits. Message IDs are internal and are not returned to the model by the tool.

**The recall scope** is the latest 500 messages, plus all the history summaries (the summary segments written by `history.compact@2`, whose result `role` is `summary`). So earlier turns can still be found through the summaries.

**The archival scope:**

- Lorebook entries. Entries with `enabled: false` are excluded from both the keyword and the vector paths.
- Characters. Character search is not affected by the lorebook switch.
- Plugin data. Only namespaces that a plugin declared with `contributes.data.<namespace>.search` go into archival, and they are read only while that plugin is enabled in the current session. The framework does not read a namespace that was not declared.

The vector index is updated asynchronously, so it can fall behind for a while. So vector results are checked against the current source data. Old items that are disabled, deleted, or whose content has changed are not returned. When needed, the search falls back to a filtered keyword search. When an entry is enabled again, keyword search works right away. The semantic index can be reused, or it is rebuilt by a later indexing job.

**How a query runs.** `memory-search` queries through `MemorySystem.search(sessionId, query, { scope, limit })`. The tool itself only handles the arguments and the output format.

- With `scope: "all"`, both sources are searched. The two sources share one query embedding (from the same model), and this cache lasts only until the query ends.
- When the embedding fails, each source falls back to keyword search on its own.

**The order of mixed results.**

- The two sources are interleaved by each one's own rank. At the same rank, recall comes first. When one source has too few results, the other source fills the rest.
- The returned `score` only means something inside its own source. It cannot be compared across sources, and it must not be used to re-sort the results. This is also true when one side uses vectors and the other falls back to keywords.
- When a single scope is given, the order of that source is kept as it is.

**Its relation to the `memory` plugin.** `memory-search` is the framework's search tool. The core memory blocks belong to the `memory` plugin:

- Memory blocks are saved in that plugin's `blocks` namespace. Background extraction is submitted through a normal `plugin.data` proposal, and `prompt.segment@1` provides the prompt fragments.
- The framework's tool does not read or write another plugin's block data directly.
- The `facts` namespace of that plugin declares `search`, so the facts it records are searched through archival.

**How other plugins take part.**

- Providing the read-only service `memory.block-definitions@1` lets a plugin contribute memory block definitions.
- A world package imports `{id:"world",blocks:[...]}` through `contract:memory.blocks@1`. A receiving plugin declares accepts in `contributes.data`.
- Tags use lowercase snake_case. The memory plugin manages content length and the extraction strategy.

### world-dimension-get

Read the current values of world dimensions. It is defined in `packages/tools/src/builtin/world-dimension-tools.ts`.

All plugins read the same public snapshot, `ctx.world.dimensions`, which is frozen during one execution. This tool:

- Does not read a provider's private namespace.
- Does not add in the caller's own writes that are not yet committed.
- Does not fall back to the world's initial values.

The model's `summary` comes from SDK `queryDimensionSnapshot`'s `text`, querying and paging dimension values after applying `modelFacingJson`. A direct query of a bookkeeping field cannot expose it; code still receives the full values in `results`.

| Argument  | Type                                       | Required | Description                       |
| --------- | ------------------------------------------ | -------- | --------------------------------- |
| `queries` | Array<{dimension, path?, offset?, limit?}> | ✓        | At least 1 item, at most 20 items |

`dimension` accepts any [valid author ID](./world-data.md#declaration-format), and there is no fixed allow-list of names.

**`path`** is relative to the dimension's **`value`**, not to its definition or its public entry. Supported forms:

| Form         | Example                                  |
| ------------ | ---------------------------------------- |
| Dot path     | `durability`                             |
| Array index  | `regions[0].name`                        |
| Root array   | `[0].name`                               |
| JSON Pointer | `/regions/0/name` (supports `~0` / `~1`) |

It reads only the object's own properties, not the prototype chain. When the path does not exist, it returns `found:false`. For a syntax error, it also returns `error`.

**Paging.** When a query includes `offset` or `limit`:

- Strings are paged by Unicode character, arrays by element, and objects by their own entries.
- `offset` defaults to 0. `limit` defaults to 100, with a range of 1–2000.
- The structured `results` keep the selected value, and they add `page:{value,total,nextOffset?}`.
- Paging only changes how much the model reads back at once. It does not change the snapshot.

For example, the query `{queries:[{dimension:"reputation"}]}`:

```json
{
  "results": [
    {
      "dimension": "reputation",
      "found": true,
      "value": 5,
      "name": "声望",
      "schema": { "type": "integer", "minimum": 0, "maximum": 100 },
      "version": 2
    }
  ],
  "text": "reputation (v2) = 5"
}
```

The model sees only the `summary` that fits its budget. The trace and debugging keep the full structured result. A long value that is not paged gets a truncation notice. In that case, query a narrower path or a smaller page. Do not treat truncated content as the full value.

The public result does not include `initialValue`, `updateRule`, or the tracing source.

### world-dimension-list

It is in the same module as `world-dimension-get`. The argument is `{}`, and it returns `{dimensions:[{id,name,type,version}]}`. `type` comes from the schema's `type`, and it can be missing when the schema does not set one.

Use this tool only to find out which dimensions exist and what versions they have. It does not return values, rules, or initial values. Use it first to find the IDs, then use `world-dimension-get` to read the paths you need. This way, you do not have to put a large amount of data into the prompt all at once.

### emit-event

Emit a domain event. The event must be declared in `events` by an enabled plugin (see [plugins.md § Runtime grouped fields](./plugins.md#runtime-field-groups)). It is declared in `packages/tools/src/builtin/emit-event.ts`.

| Argument | Type                    | Required | Description                                                                 |
| -------- | ----------------------- | -------- | --------------------------------------------------------------------------- |
| topic    | string                  | ✓        | Event topic. It must match an `events[].topic` declared by an active plugin |
| data     | Record<string, unknown> |          | Event payload, checked against the declared JSON Schema. Defaults to `{}`   |

**One topic per call**: one call emits one event. To emit several domain events, call `emit-event` several times.

Validation, and the list of available topics, are handled by an event directory (`EventDirectoryLike`; the server implementation is in `apps/server/src/routes/api/bootstrap/event-directory.ts`). It collects the declarations of the enabled plugins in the current session. In one session, a topic has only one plugin that declares it (see [plugins.md § Session plugin selection](./plugins.md#session-plugin-selection)). So the payload is always checked against that single schema.

The model-facing `topic` schema is an enum of this session's advertised topics. `data` carries the topic's payload schema, or an `anyOf` with one titled branch per topic when several topics are available. A single topic uses its schema directly under `data`; `$schema` and `$id` are omitted. Schemas containing `$ref` or `$defs`, and unreadable schemas, are advertised as plain objects. With no advertised topics, the generic definition is used.

Session preparation refreshes this definition every turn, including sessions without a character schema. Execution still accepts a string topic and delegates payload validation to the directory's Ajv validator: an unknown topic remains `refused`, not `invalid-input`. The prompt catalogue is unchanged.

#### The four results of a call

Checked in this order:

| No. | Case                                                               | Tool call | Text returned to the model                                                                                                                                                           |
| --- | ------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | This topic was already emitted in this turn                        | Succeeds  | `event "<topic>" was already emitted this turn and is recorded. Do not emit it again; continue with the task.` It does not produce a second event.                                   |
| 2   | The topic is not in the session's public directory                 | Fails     | `unknown topic "<topic>"; no active plugin consumes it, so it cannot be emitted. Do not retry it. Available topics: <comma-separated list, or "(none — no consumer plugin active)">` |
| 3   | The topic is known, but the payload does not match its JSON Schema | Fails     | `event payload rejected: <ajv error text>`                                                                                                                                           |
| 4   | Everything passes                                                  | Succeeds  | `event "<topic>" emitted and recorded for this turn. Do not emit it again.` The result includes `emittedEvents`.                                                                     |

The text of case 4 clearly says "do not emit again." If the reply were only "emitted," some models would emit the same event again to be safe, which wastes a round of calls.

Cases 2 and 3 are failed tool calls. The error text goes back to the model, and the call does not count as "a tool was used" (`requireToolUse`). It also does not count as completing the tool work. But they affect the runtime result differently:

- **An unknown topic (case 2) is not a runtime failure.** No enabled plugin declares this topic, so the model has no way to correct it, and the call did nothing. The tool rejects it with `ToolError("refused", …)` (from the public SDK). It does not count as business work (`requireToolUse` is still not met, and `completeAfterTools` is not triggered). It is also not treated as an unresolved failure. If an agent only made this one emit, and then ended with text or `runtime-done`, the result is a normal success with no event emitted. So removing the plugin that consumes an event does not make the runtime that emits it fail.
- **A payload that does not match the schema (case 3) is a failure.** The contract exists, but the data is wrong, and the model can resend based on the error text. A later successful call of the same tool cancels it out. A `system` runtime that ends without a successful resend and without any other output fails with `tool_failed_without_output`. A runtime that declares `requireExplicitCompletion` cannot end with `runtime-done` while this failure is unresolved.

**Internal topics.** A topic declared with `advertise: false` is not in the allow-list of `emit-event`. It can be emitted only by a **function runtime** of the plugin that declares it, through `output.events`. An agent cannot use `emit-event` to emit it directly, which would skip the generation step in between. The list of available topics echoed in case 2 also does not include the names of internal topics.

The record of "already emitted this turn" in case 1 is `context.emittedEventTopics`. The tool loop accumulates it and passes it in (`ToolExecutionContext.emittedEventTopics` in `packages/tools/src/types.ts`).

#### Which channel an event uses

When an emit succeeds, the event is carried out only through the `emittedEvents` channel in the tool result (`withEmittedEvents`, `packages/tools/src/result.ts`). The tool loop collects them, and `finalize-agent-output.ts` then merges them into `RuntimeResult.output.events`.

A tool **never** also returns a pending `event.emit` proposal. Otherwise the same event would be handled twice: once by in-turn event dispatch, and once by proposal normalization.

After being merged into `output.events`, the event follows the existing flow. It is dispatched to subscribers within the turn, normalized into an `event.emit` proposal, and finally sent to the client as an `event.emitted` SSE event (see [protocol.md](./protocol.md)).

Normalization only recognizes a `{ topic, data? }` envelope that has a `topic` field. A plugin's output schema can use a field with the same name, `events`, as its own data field (for example, the fact events of WorldIR). Entries of that kind do not produce an `event.emit` proposal.

#### The scope of de-duplication

De-duplication is scoped to **one tool loop**. When the same runtime emits the same topic again in the same turn, the second emit does nothing.

It does **not** cross runtimes. Two runtimes that run in parallel in the same layer can each emit the same topic. This is not a defect:

- Event dispatch groups events by topic during the collection phase, and the one emitted first in the same layer takes effect (see `collectEventsFrom`). So downstream subscribers are still triggered only once.
- The cost: a payload with the same topic that the second runtime in the same layer emits is not delivered. The scheduler reports it with `scheduling.hazard` (`code: "event-payload-dropped"`, including the topic and runtimeId). It is not dropped silently.

To pass several pieces of information, carry them as a batch in one event's `data` (for example, the batch convention of `check.resolved`), or use different topics for different sources.

#### Making receipts checkable on the spot

JSON Schema can check the shape of fields, but it cannot check "does this result match the dice." A runtime that consumes the event runs only after the whole turn has been written, so by then a wrong receipt is too late to correct in the story text. Two approaches avoid receipts that fail only after the fact:

- Put only what the model itself decides into the receipt. Do not have the model fill in fields that code can compute. If the model fills in both the difficulty name and the DC number, or both the die value and the total, there are several places where they can disagree.
- Put checks that need this turn's data in the `PreToolUse` hook of the plugin that declares the event, and run them at the moment the event is emitted. When the check fails, `abort`, and write the correct value into `reason`. `reason` is returned to the model as the result of this tool call, so it can resend before writing the story text.

`dice-check` is an example: the receipt has no die value, DC, or total. The recorder takes the dice in order and computes them. `hooks/verify-check-receipt.js` checks the dice when the narrative emits the receipt, and if the result does not match, it sends back the correct result for each check.

**Used by**: any agent runtime that declares `advertiseEvents: true` and lists `emit-event` in `tools.builtin`, for example `narrator` and `chat-mode-narrator`.

### suspend

Only a successful `suspend` call returning its sentinel suspends the runtime. A `_covelSuspend` field from another tool is ordinary data; an agent that needs suspension must declare and call `suspend`.

Pause the current runtime until the player gives input, then continue. It is declared in `packages/tools/src/builtin/suspend.ts`.

| Argument | Type        | Required | Description                                                                                        |
| -------- | ----------- | -------- | -------------------------------------------------------------------------------------------------- |
| reason   | string      | ✓        | Short explanation shown to the player                                                              |
| fields   | FormField[] | ✓        | At least one `create-form` field object; unique, non-empty names; selects need at least one option |

The field objects support `type`, `name`, `label`, `placeholder`, `options`, `required`, `defaultValue`, `min`, `max` and `step`. Select defaults must match an option value.

The player form initializes answers from defaults, including optional fields and `false`, `0` and `""`. Submitting without edits preserves those defaults; optional fields without defaults remain omitted.

| Field type      | Compiled property                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| text / textarea | `type: "string"`, `title: label`, `minLength: 1` when required                                        |
| number          | `type: "number"`, `title: label`, `minimum: min` / `maximum: max` when supplied; `step` is not stored |
| checkbox        | `type: "boolean"`, `title: label`                                                                     |
| select          | `type: "string"`, `title: label`, `enum` of option values; option labels are not stored               |
| Every type      | `defaultValue` becomes `default` when supplied                                                        |

The compiled schema is an object with `properties`, `additionalProperties: false` and a `required` list for required fields (omitted when empty). The answer is an object keyed by field name, for example `{ "name": "Alex", "age": 21 }`. Function runtimes still return a raw JSON Schema in `outcome: "suspended"`; the tool does not accept a raw-schema argument.

**Output**: a marker object `{ _covelSuspend: true, reason, resumeSchema }`. The framework intercepts it, and normally it does not return to the model as an ordinary tool result.

What happens after the call:

1. The agent calls `suspend({ reason, fields })`, and the tool returns the marker object above.
2. After each tool execution, the framework checks the result with `isSuspendSentinel()`. When it recognizes the marker, it writes the state of this run to the `suspensions` table: the identity of the execution, the proposals and events already buffered, the full conversation record with the model, and the state of the tool loop (see the notes below).
3. The framework emits a `turn.suspended` event, and the whole tool loop stops right away.
4. Afterwards, data that matches `resumeSchema` is submitted through `POST /api/sessions/:id/suspensions/:suspensionId/resume`, and this runtime continues from where it stopped (see [api.md](./api.md) for details).

When one model reply has several tool calls, `suspend` leaves a `summary` placeholder in the tool success envelope. Each later call that has not run receives an error envelope with `error.code: "cancelled"`. Resume replaces the placeholder by the same `toolCallId`, returning a `summary` and the player's answer in `data`; suspensions saved with older placeholder text are also replaced by ID. The player's `data` is preserved in full, including nested identifiers and timestamps, without `modelFacingJson` projection. The resumed transcript therefore still meets the provider's requirement that tool calls and results come in pairs.

**Things to note:**

- The compiled `resumeSchema` is the JSON Schema stored and validated on resume.
- A runtime has only one suspended item waiting to resume at a time: when it suspends again, the older item is voided at once. When the player played another turn, the plugin changed version, or a record the item would change was changed by another execution afterwards (for example a background job or a manual run), the suspended item is voided on resume; see [Out-of-date suspended items](./api.md#out-of-date-suspended-items). The resume endpoint looks it up by the suspended item's ID.
- `createDefaultToolRegistry` in `@covel/tools` registers it as a builtin tool. An agent still has to list `suspend` in `agent.tools.builtin` before it can call it.
- A runtime that runs in the background cannot suspend, because no player is waiting on it. A runtime that declares `schedule.background: true` or `schedule.detached` and lists `suspend` in `agent.tools.builtin` is rejected at load. If a runtime in a background job suspends anyway (a function handler returns a suspension, or an event runtime triggered by the background run calls `suspend`), the job is recorded as `failed` and nothing is committed.
- Resuming continues the execution that was suspended:
  - `ctx.locale`, `ctx.logicalTurn`, and `ctx.turnNumber` keep the values from the time of suspension. They do not change with the turn count of the session afterwards.
  - `ctx.world` is the World Model committed at resume time, with the writes buffered in the state added on top.
  - The tool loop continues from its state before the suspension: the corrections already spent (the four in `agent.loop.corrections`), the deferred tools activated with `search-tools`, the prose written from merged player interjections, the output of a completing tool that already succeeded, and this turn's prompt segments (`promptSegments` of `PreLLMCall`). An activated tool that is no longer deferred is skipped on resume.
  - The context is not assembled again: the saved conversation record is the context the runtime ran with, and `PostContextAssembly` does not fire again.
- A resumed runtime can call `suspend` again. The old suspended item is marked handled and the new one continues the same execution; see [Suspending again](./api.md#suspending-again). Sub-agents cannot suspend.
- `completion.require: tool-use` uses the same rule after resuming: with `afterTools`, only successful calls from that list count; without a list, successful business tool calls count. A tool that failed before the suspension, and was not cancelled out by a successful call of the same name, still counts as not completed. After resuming, it must be completed again.

### search-tools (injected by the framework, deferred tool loading)

When a runtime has many tools, putting every tool's schema into every model call takes up a lot of room. A runtime can declare `tools.defer` to "defer" some of its tools. Their schemas are not put into the initial tool list. When the model needs one, it finds it with `search-tools`.

- `tools.defer: true` defers the whole allow-list. `tools.defer: [name, …]` defers only the listed tools.
- When `tools.defer` is declared, the framework injects `search-tools` automatically. **You cannot declare it by hand in `tools.builtin`.**

| Argument | Type   | Required | Description                                                                                          |
| -------- | ------ | -------- | ---------------------------------------------------------------------------------------------------- |
| query    | string | ✓        | Capability keywords (Chinese or English both work), such as `切换场景背景` (switch scene background) |
| limit    | number | —        | Maximum number of tools to activate (default 8, maximum 20)                                          |

**Output**: `{summary}` listing the names and descriptions of the matching tools. The full schemas of the matching tools are added to the tool list from the next model call on, and they stay in effect for the rest of this turn's agent loop. In the next turn, the list resets to the short version.

**Things to note:**

- This call is handled directly by the agent loop. It **does not go through ToolExecutor**, and it is not in the tool registry. Its name is still a reserved framework name.
- The search is strictly limited to the deferred tools that this runtime declared itself. Schemas are obtained through `getToolInfo(name, context)`, and they follow the same builtin / local access boundaries. A tool the runtime has no permission for cannot be found, so it does not leak.
- Scoring uses BM25 with no dependencies (k1=1.2 / b=0.75). Chinese, Japanese, and Korean text is split into pairs of adjacent characters. The searched text is: the tool name, the description, and the field names and field descriptions in the parameter schema.
- The description of `search-tools` tells the model how many tools are in the deferred pool, and names the plugin that declared it. The pool can hold framework built-in tools too, so not all of them come from that plugin. The model uses this to know that there are tools it has not loaded yet that it can search for.
- When to use it: when a runtime's allow-list has more than about 10 tools, preloading every schema on every call starts to take up the prompt budget.

The contract is declared in `packages/tools/src/builtin/tool-search.ts`, and the execution logic is in `packages/runtime/src/agent-loop/tool-search.ts`. The approach follows openai/codex's `tool_search` (`ToolExposure::Deferred` + BM25).

### Sub-agents (delegate)

An agent runtime uses it to hand a job to a [sub-agent](./plugins.md#sub-agents): another agent runtime runs with the brief inside this execution and returns its output. List `delegate` in `agent.tools.builtin` to call it.

| Parameter | Type   | Required | Description                                                                                        |
| --------- | ------ | -------- | -------------------------------------------------------------------------------------------------- |
| target    | object | ✓        | `{ contract }` (the contract's provider, any package) or `{ runtimeId }` (own package), never both |
| brief     | string | ✓        | The task; the sub-agent sees only this and `data`. 1 to 20 000 characters                          |
| data      | object | —        | Facts the sub-agent needs, as a JSON object, at most 32 KB                                         |
| maxSteps  | number | —        | The sub-agent's step limit; it can only be lower than the provider's own                           |

**Output**: on success the model receives `{data: output}`, with output projected through `modelFacingJson`; code still reads the original output. `stopReason` and usage stay on `subagent.completed`. A completing `delegate` passes the original output to the caller's output gate. Failure uses `{error:{code,message,hint?}}`, with the same codes in `tool.failed`. All failures except `invalid-input` retain the `refused` accounting flag.

**Notes**:

- The kernel answers the call inside the agent loop; the tool itself never runs. It is traced like any tool: `tool.calling` / `tool.completed` / `tool.failed`, with `approvalStatus: auto-allowed`. The sub-agent's events point back to the call with `parentCallId`.
- Caps: one execution runs at most 8 sub-agents at a time, and a call over the cap gets `unavailable` at once. A sub-agent does not get `delegate`, so it cannot go one level deeper.
- The sub-agent can use read-only tools only; its write tools are taken away. It makes no proposals, and the caller's commit does not change because of it.
- It is annotated `readOnly`, but neither `idempotent` nor `concurrencySafe`: two runs give different answers.

The contract is declared in `packages/tools/src/builtin/delegate.ts`; the execution logic is in `packages/runtime/src/agent-loop/subagent-delegate.ts` and `subagent-runner.ts`.

## Character management tools

These are the framework's built-in character management tools. They are defined in `packages/tools/src/builtin/character-tools.ts`. Characters are written to the `characters` table. A character belongs to the session, and every plugin can see it.

<a id="text-first-convention"></a>

### Unified result format and error codes

Every tool result the model reads is a JSON object. Success keys appear in the order `summary`, `data`, `staged`. With no summary, data or effects, the result is `{"summary":"Done."}` (`完成。` for Chinese instructions). A failure has only `error`:

```json
{
  "summary": "Queued a note.",
  "data": { "key": "gate" },
  "staged": {
    "count": 1,
    "kinds": ["plugin.data"],
    "notice": "已暂存，回合结束时生效（可能被拒绝）。"
  }
}
```

```json
{
  "error": {
    "code": "invalid-input",
    "message": "The name is required.",
    "hint": "Fix these fields and call the tool again."
  }
}
```

- `summary` and `data` are optional. Without an explicit view, `data` is the tool content projected through `modelFacingJson`, with the top-level `ui` array removed.
- `withModelView(content, { summary?, data? })` selects what the model reads. With a view, only its specified fields are sent; a summary-only view omits the content. `data` still passes through `modelFacingJson`; `summary` is preserved verbatim.
- `withModelView`, `withPendingProposals` and `withEmittedEvents` compose in any order, retaining content, the view and both effect channels. Read the view with `getModelView`. `_text` has no special meaning.
- `parsedResult`, `ctx.tools.call` return values, completing-tool output, UI and interaction payloads remain the full content. The model envelope does not change them.
- Successful calls with pending proposals or domain events include `staged`. `count` totals both channels; `kinds` lists distinct proposal types in first-seen order, followed by `event` when there are events. Success means staged; commit can still reject the effects.
- `instructionLocaleFor(context.locale)` selects the notice and honors `COVEL_INSTRUCTION_LOCALE`: Chinese is “已暂存，回合结束时生效（可能被拒绝）。”; English is “Staged: it takes effect when the turn ends and may still be rejected.” Error messages and hints remain English.

Persisted tool-call audit input/output omits object properties whose value is `undefined`, including nested optional fields. Undefined roots or array elements, non-finite numbers, BigInt, functions, symbols, cycles and non-plain objects still produce a diagnostic. Strict JSON validation is unchanged. This audit conversion does not determine the model envelope and does not bypass `io.concealed`.

The SDK's `TOOL_ERROR_CODES` is the single error-code list. Authors throw `new ToolError(code, message, { hint? })` for readable failures. `isToolError` recognizes subclasses and Errors from another SDK copy. `ToolValidationError` extends it with code `invalid-input`.

<!-- prettier-ignore -->
| Identifier | Meaning | Producer | Sets `refused` |
| --- | --- | --- | --- |
| `invalid-input` | Arguments need correction | JSON parsing, Zod, tools or sub-agent request validation | No |
| `not-found` | Target not found | Tool lookup, tools or sub-agent resolution | No for thrown tool errors; yes for delegate |
| `ambiguous` | Target is not unique | Tools or sub-agent resolution | No for thrown tool errors; yes for delegate |
| `refused` | Call refused | Approval, PreToolUse or tools | Only when the tool itself throws it |
| `unavailable` | Not authorized or currently unavailable | Tool authorization, missing executor, tools or sub-agents | No for tools/executor; yes for delegate |
| `timeout` | Tool or sub-agent timed out | Executor, tools or sub-agents | No for tools/executor; yes for delegate |
| `conflict` | Write conflict, reserved | No builtin producer yet | No |
| `cancelled` | Call cancelled, including calls skipped within a batch | Executor, tool loop, tools or sub-agents | No for tools/executor or skipped batch calls; yes for delegate |
| `internal` | Unexpected execution failure | Executor, tools or sub-agents | No for tools/executor; yes for delegate |

The code and accounting flag are separate. Approval denial and undeclared calls still count as failed calls. A call skipped by `PreToolUse` in an agent loop appears only in history and trace, without failure accounting; a hook abort still fails a function-runtime call. For tools that execute, only a tool's own `ToolError("refused", …)` is excluded from runtime failure accounting. `delegate` keeps its own rule: every failure except `invalid-input` sets the flag.

`ToolCallResult.error` provides the same `{code,message,hint?}` for code. Failed calls have `parsedResult: null`; `delegate` retains its own failure result. A failed `ctx.tools.call` rejects with `ToolError`, whose message is plain text rather than JSON.

For `internal`, the model reads `Tool "<name>" failed: <text>`: only the first error line, UUIDs replaced by `<id>`, and at most 300 characters of error text. Author-thrown `ToolError.message` is limited to 2 000 characters. Non-concealed `tool.failed.error` retains the full message; unexpected exceptions are also logged server-side. Stack frames and cause chains are not sent to the model. Trace `code` uses the same vocabulary, with optional `hint` and validation `details`; `tool.completed.result` is the JSON text above. Concealed runtimes still strip these fields.

### sync-characters

Merge the new characters and the changes to existing characters found in one narrative turn into a single commit. Either everything succeeds, or nothing is written: if any create or update fails partway through, this call leaves no partial writes.

It handles duplicate checks, default value merging, schema warnings, and reads of buffered writes within the batch.

Agents receive the type enum and compact field constraints through the session variant of this tool. Function runtimes read the full schema from `ctx.world.characterSchema`.

| Argument  | Type              | Required | Description                                                   |
| --------- | ----------------- | -------- | ------------------------------------------------------------- |
| `creates` | CharacterCreate[] |          | New characters, default `[]`, up to 5 items                   |
| `updates` | CharacterUpdate[] |          | Patches for existing characters, default `[]`, up to 10 items |

The entry fields are listed below. Failures name the entry, such as `creates[1]` or `updates[0]`, and preserve the error code and correction text. Alias ownership, player-name collisions and unknown types use `invalid-input`; unresolved updates use `not-found` or `ambiguous`.

**Output (parsedResult)**: `{ created, updated, unchanged }`

Rules:

- Both lists can be empty at the same time. An empty batch means "no character changes this turn." The call succeeds and produces no proposal.
- A duplicate create with the same `(name, type)` in the same session is not an error. It returns `unchanged`, along with the id of the existing character. It does not overwrite the existing description and fields, and it does not block other valid operations in the batch. To change an existing character, you must explicitly put it in `updates`.
- Other validation failures make the whole batch fail. After fixing it, submit the full batch again.
- A create or update earlier in the same batch is visible to the items after it.

Host developers who write composite tools need to be careful here. When the host provides `context.world`, the composite tool adds only the proposals new in this batch on top of that snapshot. Outer upstream proposals and pending proposals that are already in the snapshot must not be added again. Otherwise the version would advance one extra time, or newer fields would be overwritten.

**Used by**: `char-creator/character-tracker`. It puts `sync-characters` in `completeAfterTools`, so the run ends right away after the tool succeeds, and the model is not asked to write a closing message. The configuration of this tracker:

- It declares `toolChoice: required`, so every reply must call a tool. When nothing has changed, it submits an empty batch.
- It uses the default budget of 20 steps for the tool loop, so it can first read characters, and it can also fix a failed batch. It ends right after a successful sync.
- The limit for each batch is still 5 new characters and 10 updates to existing characters.
- The `<existing-characters>` roster, which only this tracker sees, lists each character's id, name, aliases (only when there are any), type, and description. This section changes only when characters are added or rewritten.
- `<character-fields>` has one line per id. Within a 12000-character budget, it includes each character's current `fields`, and it is updated every turn. Usually one model call is enough to finish the sync. For a character that is over the budget, its line says `fieldsOmitted`, and the full fields are read with `get-character`.
- Reasoning is turned off, a single call times out after 30 seconds, and it retries once.

The tracker spends its detail-read budget only after a successful `get-character` result. A failed read remains available for correction; an explicit-completion runtime must resolve that failure with a successful read.

#### creates[]

Create a new character record: a player character, an NPC, or a companion.

| Argument    | Type                    | Required | Description                                                                      |
| ----------- | ----------------------- | -------- | -------------------------------------------------------------------------------- |
| name        | string                  | ✓        | Character name                                                                   |
| aliases     | string[]                |          | Other names for the same person (nicknames, titles, a name in another script)    |
| type        | enum                    | ✓        | `player` plus the world schema types                                             |
| description | string                  |          | Short description of the character                                               |
| fields      | Record<string, unknown> |          | Attribute key-value pairs (should match the world schema's character-attributes) |

Created entries appear in `created`; existing matches appear in `unchanged`, with `characterId`, `name` and `type`.

The id of a new character is made from its name, and it is a readable word form (see [short IDs](#short-ids-entity-references-the-llm-can-read)).

#### Duplicate check

- In the same session, a character with the same `(name, type)` is not created a second time. The tool returns the id of the existing character.
- Names are compared by the [normalization rules](./world-model.md#aliases-and-name-resolution). Differences in case, full-width and half-width characters, whitespace, and the middle dot do not count.
- When the name is an **alias** of any existing character, the tool returns that character and creates nothing, whatever the type.
- When creating `type: "player"`, if the name is the name or alias of another character, the tool reports an error and asks for a different name for the player. A player cannot be an NPC that already exists in the world.
- A session can have several players. A new player character is bound to the default seat automatically (see [seats](./world-model.md#seats)). The other types come from the schema's `types`.

**Example `summary` the model sees**:

```
Created npc "苏婉" as char-abc123. — 青萍宗外门首席弟子，冰灵根修士。
```

When the duplicate check matches:

```
Character "苏婉" (npc) already exists as char-abc123. No new record created. Use sync-characters updates to modify it.
```

When `aliases` contains the name or alias of another character, the call fails, and no proposal is produced. The error says which character it is, so the model can update that character instead:

```
"守灯人" is already a name of 守灯人伊索德 (aka 伊索德, 守灯人) [npc-keeper-ysolde]. If 老妇人 is that person, update npc-keeper-ysolde and create nothing. If the alias is wrong for 守灯人伊索德, remove it there first: update npc-keeper-ysolde with removeAliases. Otherwise leave this alias out.
```

#### How attributes are validated

- The model sees a compact `fields` object. The batch description shares one set of structural constraints across creates and updates, keeping large world attribute tables out of the parameter schema.
- The authoritative definition of each attribute (id, type, range, enum, default value, description) is stored in the session's world schema.
- The tool description adds a short list of field constraints: type, numeric upper and lower bounds, enum options, element types for arrays and maps, and nested structure. It does not repeat long descriptions or default values. The creates and updates of `sync-characters` share one constraint description.
- At execution time, the authoritative schema is read again: default values are merged in, and the declared fields are checked strictly. The check happens **before** the write proposal is produced. An invalid string, `null`, or a non-finite number cannot pass as a numeric attribute.
- Keys that are not declared are still kept, but a warning is returned.
- `creates` merges the default values first, and then validates. `updates` validates only the patch in this call, so it can fix old data one field at a time.
- A numeric patch writes the new absolute value, not a change.

Plugins can use the same rules: `mergeSchemaDefaults` and `assertCharacterFields`. On failure, they throw `CharacterFieldValidationError`.

#### Which data is read

Default value filling and character write validation all read the session's World Model. This view merges three things in execution order: the committed records, the domain proposals of upstream runtimes that succeeded, and the pending proposals of this runtime. An invalid schema or an invalid character write does not enter this view. Character records are not mirrored into plugin private data.

When reading, updates are applied in proposal order, using `materializeCharacterUpsert`, the same function the commit uses:

| Write                               | Effect                                                                                                                                                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An update with `expectedVersion`    | Shallow-merges object fields, keeps the fields that did not change, and adds one to the current version each time. An empty description string can clear the old description. A non-object field value is replaced as a whole. |
| `fields` is `null` as a whole       | Clears the attributes. Reading turns it into `undefined`. A `null` value inside an object stays as it is.                                                                                                                      |
| An upsert without `expectedVersion` | A full replacement. Old fields that are left out are not kept.                                                                                                                                                                 |

The lower-level `CharacterStore.upsertCharacter` saves the full snapshot, including the creation time that is passed in. Memory, SQLite, and PostgreSQL behave the same way.

Version and argument checks run again at commit time. Seeing a write in the pending view does not mean it was committed successfully.

`overlayCharacters(proposals, stored, sessionId)` takes the stored characters and the session ID, and it returns a `Map<string, CharacterRecord>` of the full character view for that session. The result shares no references with the input. `CharacterRecord` is defined in `@covel/shared`, and `@covel/store` exports a type with the same name.

#### Opening character form

`char-creator/player-init` wraps the general `create-form` with the plugin tool `create-character-form`:

Template/default checks in `create-character-form` return `invalid-input`, including a missing `{{characterName}}` placeholder. The model must correct the template before an interaction is published; unexpected downstream failures retain their original classification.

- It allows only the required `characterName`, plus the string and enum fields in the world schema. The submitted value of an enum must come from its original options.
- Numeric and composite attributes keep their default values. They cannot be turned into a select in the narrative.
- When the form has fields that cannot be collected, the tool lists all the rejected fields and the reason at once (not a world attribute, or a numeric or composite attribute). It also gives the list of attributes this world can collect. When the world has no string or enum attributes, it states clearly that the form has only one field, `characterName`.
- Validation uses the schema given by the same upstream round, and it happens before the form is shown. The general `create-form` is not affected by these character-specific rules.
- A submission that was accepted and later found not to meet the rules is kept as an audit record, and its values are not rewritten. In that case, character creation must start again in a new session. A normal setup retry does not clear this input.

The form submission of `player-init` is turned into a proposal directly by its guard.

> [!IMPORTANT]
> **Writes are buffered.** When `sync-characters` runs, it does not write to the `characters` table directly. It buffers the write as a [`character.upsert`](#characterupsert) proposal.
>
> - Within the same tool loop, you can read your own buffered writes: a create followed by an update, and the update can see the create just before it.
> - The actual table write happens at the end of the turn, in the **same transaction** as the other writes of this execution.
> - For a runtime whose result is `success` / `skipped`, the buffered proposals are committed. For `failed` / `suspended`, they are not committed.

This tool does not change the session's phase. Setup completion is signaled by the runtime output `preGameDone: true`. The framework uses that to update `session.setupRuntimes`, and it advances `session.phase` itself (`setup` / `playing`).

#### updates[]

Update an existing character. Use it for changes in state, changing equipment, injury, death, and when the story reveals another name for a character.

| Argument      | Type                    | Required | Description                                                                           |
| ------------- | ----------------------- | -------- | ------------------------------------------------------------------------------------- |
| id            | string                  | ✓        | The id of the character to update. The character's name or alias also works           |
| aliases       | string[]                |          | Aliases to add. Existing ones, and any that match the name, are skipped automatically |
| removeAliases | string[]                |          | Aliases to remove (see below)                                                         |
| description   | string                  |          | New description (if not passed, the old one is kept)                                  |
| fields        | Record<string, unknown> |          | Fields to merge                                                                       |

What each argument does:

- `fields` is a shallow merge: new keys overwrite old keys.
- `aliases` are added after the existing aliases.
- `removeAliases` removes existing aliases.
- `version` goes up by one automatically.

**How `id` is resolved.** `id` is resolved through [`resolveCharacter`](./world-model.md#aliases-and-name-resolution). It tries the id first, then the name, then the alias. So if the model writes a name or an alias, the update still goes to the same character, and it does not create a new one because the id did not match. Writes do not do partial matching.

**`removeAliases`** is used to undo an alias that was attached to the wrong character:

- Comparison follows the [normalization rules](./world-model.md#aliases-and-name-resolution).
- A name that is not an alias of this character changes nothing and reports no error.
- The character's own name is never removed.
- Within one call, removal happens before addition, so one call can replace an alias.
- In `sync-characters.updates[]`, an alias removed by an earlier item can be added to another character by a later item.

Each successful patch appears in `updated` as `{ characterId, version }`.

**Example `summary` the model sees**:

```
Updated npc "苏婉" (char-abc123) → v2.
  hp: 100 → 60
  status: alive → wounded
```

#### On failure

| Case                                               | Error                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The character is not found                         | Lists the closest known names. If there are no close names, lists the characters in the session, up to 30. For example: `Character "伊索尔德" not found. Closest known names: 守灯人伊索德 (aka 伊索德, 守灯人). If it is one of them, use that name. Nothing was updated.` |
| A name or alias belongs to more than one character | Lists each one's id: `"Maud" names 2 characters: Maud [npc-a]; maud [npc-b]. Pass the id of the one you mean. Nothing was updated.`                                                                                                                                         |
| An alias to add belongs to another character       | Fails, and states who the alias belongs to.                                                                                                                                                                                                                                 |

Missing characters throw `ToolError("not-found", …)`; non-unique names throw `ToolError("ambiguous", …)`. In the tool loop, the model receives:

```json
{
  "error": {
    "code": "not-found",
    "message": "Character not found. Nothing was updated."
  }
}
```

The executor records this call as failed. It does not satisfy the agent's `completeAfterTools`. Even if a function runtime catches this error, it does not commit the writes buffered before it.

### list-characters

List all the characters in this session. Characters belong to the session, and every plugin can see them.

The output is a **compact text list**, with one character per line: id, name (followed by `(aka …)` when there are aliases), type, version, and a short description. The model uses it to match known people quickly. When it needs the full attributes, it calls `get-character` separately.

| Argument | Type   | Required | Description                                          |
| -------- | ------ | -------- | ---------------------------------------------------- |
| type     | string |          | Optional non-empty type string from the world schema |

Omit `type` to read all types. `null` and the empty string fail validation; `"none"` and `"all"` are literal filters. An empty filtered result lists the types present in the session.

**Output (parsedResult)**: `{ count, characters: CharacterSnapshot[] }`

**Sorting**: first by `version` from high to low (a higher version means the character has been interacted with more often), then by `updatedAt` from newest to oldest.

**Maximum number of rows**: at most 50 characters are returned at a time, from the top of the list (bundled worlds come with 10 to 16 characters).

- `count` is still the total number that match.
- When there are more, one line is added at the end of `summary`. It says how many are not listed, and suggests filtering by `type` or finding a character by name with `get-character`.
- `characters` contains only the ones that are listed.

**Example `summary` the model sees**:

```
Characters in session (3 total, sorted by frequency then recency):
1. 苏婉 [npc] char-abc (v3) — 青萍宗外门首席弟子，冰灵根修士，知晓野生灵脉秘密
2. 柳娘 [npc] char-def (v2) — 药王谷谷主，三百年前见过碧鳞龙
3. 柳无痕 [player] char-xyz (v1) — 青萍宗外门弟子，水灵根中品
```

**Used by**: the narrative and chat narrative plugins declare this tool, to look up characters outside the current scene. Third-party plugins can also declare it. A plugin that already has the character roster from its context can use `get-character` to fill in the full attributes that the summary does not have.

### get-character

Look up the **full attributes** of one character by id, name, or alias: aliases, description, version, timestamps, and all fields. You must pass one of `id` or `name`.

A narrative plugin can declare only the two read-only tools `list-characters` and `get-character`, and it does not need to depend on a character management plugin. The read scope is always the current session, including characters who are inactive or have never appeared.

| Argument | Type   | Required | Description                                                                       |
| -------- | ------ | -------- | --------------------------------------------------------------------------------- |
| id       | string |          | Character id                                                                      |
| name     | string |          | Character name or alias. Part of a name also works (for example, without a title) |

**Loose matching.** The lookup uses [`resolveCharacter`](./world-model.md#aliases-and-name-resolution) with `partial` turned on. When there is no exact match, the character is still found if exactly one character's name or alias contains the query text (or is contained by it). This tool is read-only, so it allows this. Write tools do not allow it.

**Output (parsedResult)**:

- Found: `{ character: CharacterSnapshot }`, with no `found` key.
- Missing: `ToolError("not-found", …)` with the closest known names. Multiple matches: `ToolError("ambiguous", …)` with candidate names and IDs. The executor records a failed call and returns an error envelope; there is no successful miss result.

**Example `summary` the model sees**:

```
Character: 苏婉 [npc] char-abc123
Description: 青萍宗外门首席弟子，冰灵根修士。发现百灵沼泽深处一条野生灵脉...
Version: 3

Attributes:
  hp: 60
  mp: 80
  maxHp: 100
  maxMp: 100
  level: 4
  lingGen: 冰灵根
  status: wounded
```

## Plugin tools (internal source label: `local`)

These are the tools that plugins bring with them. The implementation files are usually in the plugin package's own `tools/` or `server/` directory. They are created with `tool()`, and the `entry` imports and registers them. Below are the tools of the bundled plugins.

### Recommended way to use a plugin tool

- Put the files in the plugin's own `tools/` directory, or in a runtime subdirectory.
- Register them in the `entry` module (`server/index.js`) with `covel.registerTool(makeMyTool(covel.toolkit))`. A runtime that uses the tool declares it by name in `agent.tools.plugin` or `function.tools.plugin` in its `RUNTIME.md`.
- Write a separate test for each plugin tool.
- A persistent write returns `withPendingProposals(...)`, so the commit flow saves it to the database.
- Use plugin tools to wrap the plugin's own data schema and batch write logic.

<a id="set-world-schema"></a>
<a id="set-world-dimensions"></a>

### initialize-world

**Owner**: world-init (`plugins/world-init/tools/initialize-world.js`)

At the start of a game, it does two things at once: it sets the character attribute schema, and it adopts the dimension declarations. It returns two proposals, `character.schema.set` and `dimension.initialize`, in one tool result. If any part fails, no half-finished writes are left. When execution succeeds, both are committed together.

| Argument      | Type            | Required | Description                                                                                                           |
| ------------- | --------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `types`       | string[]        |          | Default `["npc", "companion"]`                                                                                        |
| `attributes`  | AttributeDef[]  | ✓        | At least 15 items, covering `stats` / `bio` / `abilities` / `equipment` / `social`                                    |
| `definitions` | WorldDimensions |          | A generated definition map can be given when the author declared none. It is not used when the world has declarations |

**AttributeDef**:

| Field        | Type           | Required | Description                                                           |
| ------------ | -------------- | -------- | --------------------------------------------------------------------- |
| id           | string         | ✓        | Unique ID of the attribute                                            |
| name         | I18nText       | ✓        | Display name of the attribute (a string, or a locale → string record) |
| type         | enum           | ✓        | `string` / `number` / `array` / `enum` / `boolean` / `object` / `map` |
| category     | enum           | ✓        | `stats` / `bio` / `abilities` / `equipment` / `social`                |
| min/max      | number         |          | Range for a numeric type                                              |
| defaultValue | unknown        |          | Default value                                                         |
| itemType     | enum           |          | Element type of an array (`string` / `number`)                        |
| options      | string[]       |          | List of enum options                                                  |
| subSchema    | AttributeDef[] |          | Recursive sub-field definitions for an `object`                       |
| valueType    | enum           |          | Value type of a `map` (`string` / `number` / `boolean`)               |
| description  | I18nText       |          | Description of the attribute (a string, or a locale → string record)  |

**Output**: `{success, attributeCount, dimensionCount, worldSchema, preGameDone:true}`

Generated `defaultValue`s are starting values for every new player and NPC, not examples of a person from the lore. Name, role, background, and other identity fields belong in `bio`, with neutral or empty values. The tool clears generated `bio` string defaults to empty strings, arrays to empty arrays, and objects and maps to empty objects; it removes enum defaults. Nested biography fields follow the same rules. Numeric and boolean defaults remain. The guard adopts author-provided schemas unchanged, without this normalization.

Whose dimension definitions are used:

- When the world's author has declared dimensions, the author's definitions are used. The `definitions` the model also gives are not used, and the call still succeeds. The reason it does not reject them: the prompt cannot tell the model whether the world has declarations, so rejecting would only add one extra model call at the start of every game.
- Only a world that has setting text and no declarations uses the definitions the model generates.
- The tool does not turn resource structures into character fields, and it does not turn them into constant lorebook entries.

`worldSchema` is also the runtime output of `world-init/schema-gen`. It is passed to `char-creator/player-init` in the same setup execution. This way, the downstream runtime does not have to read storage that has not been committed yet.

This runtime declares `agent.completion: {require: tool-use, afterTools: [initialize-world]}` and `io.output.schema`. So the model needs to generate the tool arguments only once. After the tool succeeds, the framework checks the result directly against the output schema and ends.

**Used by**: `world-init/schema-gen`

### dimension-rule-get

**Owner**: world-init (`plugins/world-init/tools/dimension-rule-get.js`)

A tool that reads rules when maintaining dimensions. It reads only the effective definitions of this plugin, and it depends on the narrative source that is already bound. It is not a public entry point for other plugins to read rules.

When retrying, prefer the definitions frozen in the source receipt, and check that the current version matches the execution snapshot.

| Argument | Type              | Required | Description                                            |
| -------- | ----------------- | -------- | ------------------------------------------------------ |
| `id`     | string            | ✓        | A valid dimension ID                                   |
| `part`   | `rule` / `schema` | ✓        | The localized update rule, or the schema JSON          |
| `offset` | integer           |          | Default 0                                              |
| `limit`  | integer           |          | Default 6000, range 1–6000, paged by Unicode character |

It returns `{id,version,content,complete,nextOffset?}`. When `complete:false`, fetch the next page. Do not settle based on a rule preview that was cut short.

### update-dimensions

**Owner**: world-init (`plugins/world-init/tools/update-dimensions.js`)

After each narrative turn, update the current values of the world dimensions, or state explicitly that nothing changed this turn.

Arguments: `{followsClock:[id], updates:[{id, value|changes, reason?}]}`

It returns `{success,updateCount}` and a `dimension.update` proposal. When this source has already been settled, it returns `{success,alreadySettled:true}`, and it does not calculate again.

Dimension value validation failures (such as a string exceeding its declared maximum length) return `invalid-input` before any proposal is exposed. Version conflicts and unexpected exceptions are not reclassified as input errors.

#### `updates`

- At most 64 items, and IDs cannot be repeated.
- Each item gives either `value` or `changes`, not both:
  - `value` is the new full value.
  - `changes:[{path,value}]` (at most 32 items) sets fields or adds entries on the frozen current value, using dot paths. The tool merges them into a full value before committing, so a large dimension does not have to be rewritten as a whole.
- To delete a named record or a row in an array, you still have to submit the full `value`.
- A `dimension.update` proposal always holds the full value.
- `null` is a valid value only when the schema allows it. It does not mean deleting the dimension.
- If a path contains a `__proto__`, `constructor`, or `prototype` segment, the whole batch is rejected.
- The tool uses the same schema and version checks for its preflight and at commit time. The whole batch is written after a version comparison (compare-and-swap, CAS). If the versions do not match, it fails and does not reorder automatically.

#### What the model does not fill in, and cannot fill in

The narrative source, the logical turn number, the set of versions read, and the `expectedVersion` of each update are all taken by the tool from the authoritative narrative source, the receipts, and the frozen snapshot. The model cannot specify them.

Reason: the version is the one this execution read. If the model copied it, the only new failures would be "left out" and "copied an old version number from an earlier turn."

#### Forms the tool tidies up automatically

Before validation, the tool tidies several forms whose meaning is clear, without asking the model to resubmit:

| What the model wrote                                     | How it is handled                                                                                          |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A path separated by `/` (`call-0614/status`)             | Treated as a separator. Except when the current value already has a key that contains this slash.          |
| `reason` written on a single change, or beside `updates` | Removed.                                                                                                   |
| `expectedVersion` written                                | Removed (see above).                                                                                       |
| An entry with an empty `updates: []` of its own          | Removed.                                                                                                   |
| Several `changes` entries for the same dimension         | Merged into one, with the `reason` values joined in order.                                                 |
| Only one change, and its `path` is an empty string       | That is the full value, so it is handled as `value`. The model writes this for numeric or text dimensions. |
| An entry with no `value`, and `changes` empty or missing | Means this dimension did not change, so it is dropped.                                                     |

Still rejected:

- The same dimension has one entry that gives a full `value`, and another entry appears too: rejected as a duplicate ID.
- An `id` that is not a dimension, but the name of an entry inside a dimension's current value (for example, treating a room on a map as a dimension): the error states which dimension it belongs to and how the path should be written.

#### `followsClock`

`followsClock` lists the dimensions whose rules depend on world time or on "how much time has passed": countdowns, deadlines, and consumption per hour. The model decides this from the rule text. When it is left out, it is treated as `[]`. An ID that is not a dimension is ignored.

When this is checked: the runtime has the world clock settled for this turn bound (the input `worldTime`, see [World time](./world-time.md#runtime-and-state)), **and** the clock moved in this turn. In that case, each dimension in `followsClock` must have an entry in `updates`:

- Give the new value; or
- When the rule's result is the same as the current value, write only `{id, reason}`.

If any are missing, the whole call is rejected. The error message states the current time, the time elapsed in this turn and since the start, and which dimensions are missing. The model uses it to resubmit.

When no clock is bound, or the clock did not move in this turn, this check is not done.

#### Fields derived from the clock

A field in the schema with `x-derive` is calculated from the clock by `world-init/dimension-clock` (see [fields derived from the clock](./dynamic-dimensions.md#fields-derived-from-the-clock)). These fields are not in the schema given to the model or in the frozen values, and they are not part of `followsClock`.

A full `value` does not have to include these fields. When the model writes them (in `value` or `changes`), the tool does not send the call back for resubmission. What is written is still the current value.

#### Call it even when nothing changed

If nothing changed this turn, you must still call `update-dimensions({updates:[]})`. A "no change" receipt also verifies the versions that were read.

> [!IMPORTANT]
> A tool that successfully buffers its proposals, or a runtime that ends normally, does not mean the settlement succeeded. When maintenance fails, the runtime does not run, or there is a version conflict, the state stays `pending-settlement`.

Player edits and manual handling go through [the RPC of manual runtimes](./api.md#dimension-editing-and-recovery-of-pending-settlements). Do not use this tool given to the model to fill in the source.

### submit-world-facts

**Owner**: world-ir (`plugins/world-ir/tools/submit-world-facts.js`)

The model submits the complete facts of this turn through the tool arguments, as one `contract:world-ir@1`. For the full data shape, see [world-data.md · WorldIR and plugin projections](./world-data.md#worldir-and-plugin-projections).

| Argument                                           | Required | Description                                                                                                              |
| -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                                    | ✓        | Fixed at `1`                                                                                                             |
| `summary`                                          | ✓        | Summary of the facts of this turn                                                                                        |
| `entities` / `relations` / `events` / `statements` | ✓        | Four arrays of facts. Pass an empty array when there is nothing; put plugin extension fields in each item's `attributes` |

The argument schema extends `worldIRV1Schema` with tool-only assessments, and runs the `validateWorldIRV1` semantic checks inside Zod's `superRefine`. So errors such as duplicate global IDs, missing entity references, or going over the depth or node budget are all reported at the specific argument path. The model only has to fix the corresponding field.

The tool returns the filled-in and validated facts after removing assessments, and produces no persistent proposal. `world-ir` declares `completeAfterTools: [submit-world-facts]`. The framework takes the successful result directly as the runtime's typed output, and it checks it once more against the output schema of `contract:world-ir@1`.

#### Per-objective assessment

When vocabulary supplies open quest objectives, submit the tool-only `objectiveAssessments` array. Each entry contains `quest`, `objective`, `outcome` and `evidence`. Copy quest and objective text verbatim. Outcomes are `achieved`, `planned`, `partial`, `failed`, `unverified`, `not_addressed` or `superseded`. `superseded` means the story completed the whole quest this turn and the objective was no longer needed; it also needs a quote, must accompany a `status: completed` event for that quest, and never marks the objective done. Evidence is an exact contiguous quote within one segment's `text` in this turn's `narrative.value`, without joining segments, or an empty string for an unaddressed objective.

The tool checks coverage, duplicates, canonical names, quote provenance and consistency with `quest_change.completedObjectives`. An achieved assessment with only a generic interaction is rejected. Plans, partial work, failures and unverified claims cannot also finish an objective. A quest cannot be marked completed while a vocabulary objective is neither achieved nor superseded. Shortened quest names and objective paraphrases that could resolve to a supplied entry are rejected, including ambiguous objective matches. Use exact vocabulary text; this comparison never infers completion. Without open objectives, omit the array or submit `[]`. Vocabulary is bounded context, not the entire quest ledger. Coverage checks constrain supplied quests and objectives; unlisted content keeps the existing WorldIR and consumer validation.

Assessments are removed before returning the unchanged public `world-ir@1` shape. The tool does not write quest data. Whether the objective was achieved remains a model judgment; quotations and coverage checks cannot guarantee semantic correctness.

#### Mechanical mistakes fixed automatically

Before validation, the tool fixes the following without asking the model to resubmit:

- It drops extraction inputs (`narrative` / `characters` / `vocabulary`) that were copied into the arguments by mistake.
- Extra details written at the top level of a fact are moved into that item's `attributes`.
- A relation, event, or statement without an `id` gets one added (for example `event-3fa9c1d2`, taken from a hash of that fact's content). No place in the output refers to these IDs. But a consumer that saves facts across turns by ID must not see two different facts sharing one ID.
- An entity without an `id` still raises an error, because other facts refer to it by that ID.

#### Characters use short names instead of real IDs

The number of output tokens decides how long this step takes. So the session characters in the extraction input are not given real IDs (a UUID, or a long string with a session prefix). They are given word-form short names made from their names, for example `tomas-reed`. When two characters have the same name, `-2` is added in ID order.

- Before the tool returns, the short names are turned back into real IDs, including the `holder` of `inventory_change`.
- The prompt asks the model to refer to these characters directly, and not to register them again in `entities`. For known characters that relations, event participants, and statement subjects refer to, the tool registers them from the session's character roster (`type: character` and `name`).
- Small differences in how a short name is written are still accepted. When a reference is not the ID of any entity in this output, and its letters and digits match the short name of exactly one character, it is treated as that character. For example, `雷恩-修女` matches `雷恩修女`, or the written name `Sister Wren` matches `sister-wren`. When two characters have the same letters, it does not guess.

#### Three other kinds of reference

| What the reference says                                                                                                   | How it is handled                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The name of an entity in this output instead of its ID, and only one entity has this name                                 | Changed to that entity's ID.                                                                                                                                      |
| A name from the `world-ir.vocabulary@1` vocabulary (an item or quest the session is already tracking), but not registered | Registered with the type given by the vocabulary: `{ id: name, type: vocabulary type, name: name }`.                                                              |
| A statement's `subjectIds` holds the ID of an event, statement, or relation in this output                                | That ID is removed. The model uses it to mean "this statement is about that event," but a subject can only be an entity, and that event is already in the output. |

A reference to any other ID that is not registered still raises an error.

#### Two kinds of event with fixed fields

The tool checks the fields of these two kinds of event together. The `attributes` of other events stay free. The function runtimes of `inventory` and `core-quest` read only these fields, and they no longer call the model.

| `event.type`       | Required `attributes`                                                                                                                       | Optional `attributes`                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `inventory_change` | `item` (the ID of an entity with `type: item` in this output), `holder` (character ID), `operation` (`gain` / `lose` / `equip` / `unequip`) | `quantity` (positive integer)                                                     |
| `quest_change`     | `quest` (quest name), `status` (`accepted` / `progressed` / `completed` / `failed`)                                                         | `objectives`, `completedObjectives` (arrays of objective text), `giver`, `reward` |

> [!NOTE]
> The `events` here are the **fact array** of WorldIR, not domain events. Only an entry shaped like `{ topic, data? }`, whose `topic` is a string, is turned into `event.emit`. An ordinary WorldIR event does not trigger the error `event.emit: topic must be a non-empty string`.

### sync-codex-entries

**Owner**: codex (`plugins/codex/tools/sync-codex-entries.js`)

Submit all of this turn's codex changes at once. The model does not handle entry IDs, and it does not have to choose between "create" and "update" calls: the tool decides by title. A wrong guess at an ID does not make the call fail.

| Argument  | Type         | Required | Description                     |
| --------- | ------------ | -------- | ------------------------------- |
| `entries` | CodexEntry[] | ✓        | 1–8 items, sorted by importance |

**CodexEntry**:

| Field     | Type     | Required | Description                                                                                            |
| --------- | -------- | -------- | ------------------------------------------------------------------------------------------------------ |
| category  | enum     | ✓        | `monster` / `item` / `location` / `lore` / `character` / `skill`                                       |
| title     | string   | ✓        | Entry title. A title equal to an existing one adds to that entry                                       |
| content   | string   | ✓        | For a new entry, write 2–3 sentences. When adding to an existing entry, write only the new information |
| tags      | string[] |          | At most 5                                                                                              |
| rarity    | enum     |          | `common` (default for new entries) / `uncommon` / `rare` / `legendary`. When adding, it only goes up   |
| imageHint | string   |          | A visual description hint                                                                              |

Each record is matched to an existing entry by title. The comparison trims leading and trailing spaces and ignores case.

| Case                                | Handling                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| The title matches an existing entry | `content` is appended after the original content, tags are merged, rarity only goes up, and the category keeps its original value. |
| No match                            | A new entry is created.                                                                                                            |

- At most 3 new entries are created per turn. A new title over that limit is skipped, and it is listed in `skipped`.
- When the same title appears several times in one batch, the additions are appended in order.
- The key of a new entry is the title itself (`codex-west-herb-garden`, `codex-西侧旧药园`), with no random string. When another entry already uses this key, a suffix such as `-2` is added.
- All writes are combined into one `plugin.data.batch` proposal.

The output is `{ created, updated, skipped, ui }`. `created` and `updated` are the keys that were written.

When there are no new facts worth recording, the model calls `runtime-done`. `codex` lists this tool in `completeAfterTools`, so the run ends right after it succeeds.

### Image prompt submit tools

Each of the two image plugins registers a pair of tools. The model calls one of them, and the runtime then ends.

| Plugin              | `promptMode=text`                 | `promptMode=image-json`                 | Fixed event topic                 |
| ------------------- | --------------------------------- | --------------------------------------- | --------------------------------- |
| dashscope-image-gen | `submit-dashscope-text-prompt`    | `submit-dashscope-structured-prompt`    | `image.generate.requested`        |
| openai-image-gen    | `submit-openai-image-text-prompt` | `submit-openai-image-structured-prompt` | `openai-image.generate.requested` |

Arguments:

- The text tools take a non-empty `prompt: string`.
- The structured tools take a `prompt: Record<string, unknown>` with at least one field. The tool handles the serialization.
- Both require `composition: "single-scene" | "comic-strip"`.

The tool does two things: it writes the normalized `{ prompt, promptMode, composition }` into `plugin_data[prompts]`, and it emits the plugin's own fixed topic through `withEmittedEvents`.

The model does not have to write a `{ topic, data }` event envelope itself, so it cannot leave out the topic or write an empty one. The runtime's output schema checks only the trusted result that the tool produces.

Both prompt generators are agents that are triggered manually, and they declare `schedule.background: true`. Their `agent.completion.afterTools` lists the matching tool, so the run ends after one successful submit. The image generator that follows keeps running in the background.

## Imported service tools

An agent imports another plugin's model-facing services in `agent.tools.services` ([how to provide one](./plugin-extensions.md#model-facing-services)). Each import becomes a tool when the runtime starts: a read service's import is read-only, and a write service's import stages writes (see [Imported write services](#imported-write-services) below).

```yaml
agent:
  tools:
    services:
      - inventory.items@1
      - { contract: world.map@2, as: look-at-map }
```

- **Name**: by default the contract without its version, dots as dashes (`inventory.items@1` → `inventory-items`); `as` names it otherwise. A name has only letters, digits, `_` and `-`, at most 64; a derived name that is too long needs `as`. A name cannot repeat a framework tool, the runtime's `tools.builtin` / `tools.plugin`, the package's `contributes.tools` or another import, and one contract is imported once. Manifest validation reports a clash.
- **Description and parameters**: the description is the provider's registered `description`. The parameters' JSON Schema comes from the provider's Zod input (without `$schema`), or from the provider's explicit `inputSchema`. A Zod input (also one shown through an explicit `inputSchema`) is checked on the tool side first, with the usual field-by-field errors and repair of arrays or objects sent as JSON text. The provider receives the arguments the model sent, or their repair, and parses them once for its handler, so a `transform` applies once. An input that is not a Zod schema is checked by the provider only.
- **Annotations**: a read service gets `{ readOnly: true, stagesWrites: false, idempotent: true, concurrencySafe: true }` and can run together with other read-only tools. Write services are in [Imported write services](#imported-write-services). A sub-agent keeps its imports, write-service imports included.
- **Result**: the model gets `{ "data": … }` like any other tool, with IDs, UUIDs and timestamps removed by `modelFacingJson`. Approval, `PreToolUse` / `PostToolUse`, `tool_calls` records and `tool.*` traces work as usual; approval counts the source as `local`.
- **Time limit**: a call waits at most 15 seconds for the provider and answers `timeout` after that.
- **Deferred loading**: with `tools.defer: true`, or with an import's name in the `defer` list, the import is deferred like other tools and found through `search-tools`.
- **Cannot complete a runtime**: `finishWith` and `completion.afterTools` cannot name an imported tool. A runtime must not need another plugin to finish.

### Absent tools

Without exactly one active provider, the tool is absent: it is not in the model request's tool list, and `search-tools` does not find it. The runtime starts and the story commits as usual. When the model still calls it (a resumed transcript still holds it, or the model guessed the name), the call answers `unavailable` with the reason and no plugin ID:

- `The tool "inventory-items" is unavailable in this session: no active provider offers inventory.items@1.`
- `…: more than one plugin provides it.`
- `…: its provider is paused after repeated errors.`
- `…: its provider does not offer it to models.`

A write-service import is also absent from a run that cannot change data (an agent that can suspend, and executions without a stage, such as resumed and background ones), with the reason `not-allowed`:

- `The tool "inventory-change" is unavailable in this run: it changes data, which this runtime cannot do here.`

The server log has a line with the plugin IDs for the author.

### Imported write services

An imported [write service](./plugin-extensions.md#write-services) changes its provider's own data for the caller:

- **Annotations**: `{ readOnly: false, stagesWrites: true, idempotent: false, concurrencySafe: false }`. It never runs together with other tools, and calls of one caller to one provider run one after the other.
- **Result**: a successful call answers `{ "data": …, "staged": { "count": 1, "kinds": [...], "notice": "Staged: it takes effect when the turn ends and may still be rejected." } }`, where `kinds` are the kinds of the operation's writes. The writes commit with the caller's commit unit; see [Transactions · Write-service operations](./transactions.md#write-service-operations).
- **Conflict**: when the provider's update does not fit the current value, it throws `conflict`, and the model receives `conflict` with `refused: true`.
- **Taken back**: when the tool call or sub-agent that made the call fails afterwards, the operation is taken back, even though the model already saw a successful answer. A read-only tool (`readOnly: true`) that calls a write service fails ("read-only tool returned writes").

### How a service failure is answered

An imported tool, and any plugin tool that lets a service error through, answers the model by this table. Only an input error is the model's to fix; the other failures are the provider's, so the result carries `refused: true` and does not count as the caller's failed call. A function runtime that fails because of one is not counted as faulty either; the service call trace names the provider. These failures do not count toward pausing the provider.

<!-- prettier-ignore -->
| Service outcome | Tool error code | `refused` |
| --- | --- | --- |
| Provider unavailable, unapproved or revoked; a call cycle or the depth limit | `unavailable` | yes |
| Timed out waiting | `timeout` | yes |
| The call was cancelled | `cancelled` | no |
| The provider rejected the input | `invalid-input` (names the fields) | no |
| The provider's result fails its output schema | `internal`: "The service returned an invalid result." | yes |
| The provider threw a `ToolError` | Its own code, message and hint | yes (except `invalid-input` and `cancelled`) |
| The provider threw another error | `internal`, first line only, UUIDs as `<id>` | yes |

A tool's own timeout, the caller's cancellation, an approval denial and a `PreToolUse` block are unchanged.

## Short IDs (entity references the LLM can read)

The model reads these IDs in the data that is injected, and sometimes it has to write them back exactly. Every character takes up tokens, and a long random string is easy to copy wrong. So IDs are made of words where possible, and they stay within the `[a-z0-9-]` character set. The ID checks of blueprints, rules, and portable world data all require this character set.

There are two ways to generate them, both from `@covel/plugin-handlers-utils`:

| Function                       | When to use it                                           | Result                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `wordId(prefix, label, taken)` | The caller can see all the existing IDs in the namespace | The prefix plus the label's words (`npc-lin-yao`). When that is already taken, `-2`, `-3` is added. When the label has no ASCII letters or digits (Chinese, emoji), an 8-digit hexadecimal digest of the label is used (`char-3fa9c1d2`). The same label gets the same ID in every session, and when taken, `-2`, `-3` is added in the same way. |
| `shortId()` / `shortIdBatch()` | Does not read the namespace                              | The label's words (up to 32 characters) plus an 8-digit hexadecimal random string. Repeated labels and slugs that are the same after truncation do not collide. It does not depend on a counter in the process.                                                                                                                                  |

The nodes of `codex` and `npc-graph`, and player characters, use `wordId`.

The fourth argument of `shortId` must be the context's `random`; the random string comes from the host's random source (see [`ctx.random`](./plugins.md#random-numbers-ctxrandom)).

```js
export default function ({ tool, z, shortId, shortIdBatch }) {
  return tool({
    name: "my-tool",
    parameters: z.object({ name: z.string() }),
    execute: async (params, context) => {
      const id = shortId(
        "item",
        params.name,
        context.sessionId,
        context.random,
      );
      // Dragon Sword -> item-dragon-sword-<8 hex characters>
      // 龙息术 (dragon breath) -> item-<8 hex characters>
      return { id };
    },
  });
}
```

Rules for `shortId`:

- Uniqueness does not depend on the `sessionId` argument, and it does not depend on memory in the process.
- Calling it again with the same name, across batches, or after a restart gives a new ID each time. Removing duplicates by name is up to the caller, who must look up the existing entity. An update must use the saved ID, not recompute it from the name.
- `shortIdBatch(prefix, labels, sessionId, random?)` gives each item its own independent ID. Cleaning up English punctuation, slug truncation, and repeated labels do not make two items share one number.
- IDs that already exist (including counter-style numbers such as `npc-1`) stay valid. They are not migrated or renumbered.
- When writing a new entity, you should still check whether the target key is already in use. `npc-graph` rejects conflicts before it persists, including conflicts with nodes in the current execution that are not yet committed.

## ToolExecutor

Every tool call goes through `ToolExecutor`. It uses the injected `findTool(name, context)` to find the tool module, and then calls `module.execute(args, ctx)` directly. Builtin tools and plugin tools take the same path. Approval, the trace, and the result wrapping are all handled by `ToolExecutor`.

This section is mainly for host developers who embed the kernel. Plugin authors only need to know the two parts "Authorization" and "Cancellation."

### Authorization

The tool allow-list controls two things: which tools the model can see, and which tools can actually run.

- The agent loop passes the exact authorized set of the current runtime to the executor, in `ToolCallContext.authorizedToolNames`. The set includes every name declared by `tools.*`, plus `runtime-done` for runtimes whose completion contract uses it and for story runtimes. Runtimes that must finish through a completing tool no longer receive automatic authorization for it.
- Tools on the `defer` list are also in the authorized set. Deferring affects only whether the model can see the tool at the start. It does not affect authorization.
- Before resolving the tool and running approval, the executor first checks whether the final tool name is in the authorized set. "Final" means the name after session overrides and `PreToolUse` replacement. If it is not in the set, the executor returns the structured error `unavailable`.
- `search-tools` is intercepted inside the loop, so it never reaches the executor.
- `findTool` is strict for calls with no context: without a context, it can find only builtin tools, and it rejects all plugin tools.

**Story runtimes are an exception.** A story runtime (`io.visibility: story`) ends with the story text. Its tool list does not include `runtime-done`, and the `[COMPLETION]` section does not mention it either. But authorization is still kept. When the model calls it out of habit, the loop uses the remaining steps to ask for the story text, instead of returning `unavailable`. The reason `runtime-done` is not given to a story runtime: a model that follows the instructions literally would call only it and never write the story text.

### Cancellation

- The executor merges the caller's cancellation and the host's shutdown into `context.signal`.
- Cancellation revokes this call's read capabilities, and it ends the wait for the tool callback with `cancelled`. Late return values, proposals, and events are not accepted.
- Cancellation cannot forcibly stop JavaScript in the same process. The executor keeps tracking callbacks and reads that have not finished, including host capabilities held by builtin tools.
- On normal completion, the executor also waits for reads that a tool started but did not wait for itself to finish.

### Shutdown

`createToolExecutor` returns a `ManagedToolExecutor`. Its `close()` can be called more than once, and it does three things: it stops accepting new calls, it cancels existing calls, and it waits for all the work it is responsible for to finish.

An embedding host must wait for this to finish before it closes the Store, the plugin registrations, and the event infrastructure. The server connects it to the common shutdown flow through `bootstrapApi().closeTools()`. If the wait goes past the host's shutdown budget, the dependencies are kept until the process exits. They are not closed early while a callback is still running.

### Assembly

A host installs all the builtin tools at once with `createDefaultToolRegistry({ store, eventDirectory })` from `@covel/tools`. These are UI, suspend, runtime-done, plugin-data, emit-event, and character.

- The server passes in the real event directory, and it overrides the character write tools per session.
- `test-runtime` passes in an isolated directory that does not allow any topic.
- The two share the same registry set and the same default rules. A debugging host does not therefore get all the production services.

Plugin authors use `covel.toolkit.tool()` in `entry`. The common context, the result protocol, and helper functions come from the public `@covel/plugin-handlers-utils`. The registry and the constructors of the builtin tools are part of the host API.

## Approval policy

The host resolves a tool before `ApprovalPipeline` checks the static rules. The default rules are built by `createDefaultToolApprovalPipeline()` from `@covel/approval`, which the server and `test-runtime` share:

| Source category | Rule      | Notes                                                                                       |
| --------------- | --------- | ------------------------------------------------------------------------------------------- |
| `builtin:*`     | **allow** | Registered framework tools                                                                  |
| `local:*`       | **allow** | Registered plugin tools callable in the current session, including approved community tools |

A host can supply custom rules. The first matching rule wins, and exact tool-name rules apply regardless of source. To deny a tool, place its `deny` rule before the source wildcard. When no rule matches, the default is allow.

### How the source category is decided

After the executor resolves a tool, `ToolRegistry.source()` classifies it by registration:

- Framework tools registered with `registerBuiltin()` (including `builtinUITools`) → `builtin`
- Tools that a plugin's `entry` registered successfully with `registerTool()` → `local`

These are the only two sources. Missing tools and another plugin's private tools return `not-found` before the source check. Source categories do not represent plugin trust levels. The authorization flow below decides whether community code may run.

### The approval boundary for third-party plugin server code and plugin tools

A community plugin is one installed in a user directory such as `~/.covel/plugins/`. `getPluginTrustInfo` marks them as `community`. When the server starts, it **does not run these plugins' `entry`** (the `if (!trust.autoLoad) continue;` in `apps/server/src/routes/api/bootstrap/plugin-entry.ts`; the tool access table is built by `plugin-tool-access.ts`). Their code runs after player approval or an implicit server-code / `runtime:*` grant from instance [trusted-source policy](./plugin-installation.md#trusted-sources); per-action RPC approval remains separate.

Framework approval keys and plugin action names are separate: the [reserved-prefix rule](./plugins.md#contributes-fields) is checked in declarations, registration and requests, so ordinary operations cannot reuse an internal grant.

A community plugin goes through these stages:

<!-- prettier-ignore -->
| Stage | What happens |
| --- | --- |
| **discovered** | Dropped in as a zip and installed through `POST /api/install/plugin`. At install time it is checked that it does not pose as a built-in plugin: it cannot use a reserved built-in ID. |
| **approved** | The first time it needs to run its code, the fixed `covel:plugin-server-code` is approved first. After the real actions are loaded and validated, the action approval follows. Server-code and `runtime:*` grants can only be given per session. A normal action can be approved "this time only" or "for this session." Managed environments also require the operator token, because community code runs inside the server process. |
| **import** | After approval, `activatePluginServerCode` loads that plugin's server code on demand and runs its `entry` factory (`ensurePluginEntry`, triggered once at approval and once at RPC dispatch). |
| **active** | Tool calls at run time are allowed or refused by the approval rules in the table above. |
| **revoked** | `DELETE /api/sessions/:id/approvals[?pluginId=]` or disabling the plugin. Both replace the persisted grant generation inside the session lock, and clear the session grants, one-time grants, and pending approvals in this process. Old grants in other processes become invalid too, because their generation no longer matches. Explicit community grants are not restored by new sessions, branching or restart; instance source policy is evaluated again and is unaffected by session revocation. |
| **uninstalled** | `DELETE /api/plugins/:id` deletes the `~/.covel/plugins/<id>` directory. It refuses built-in IDs and returns `restartRequired:true`. In the UI, under "Settings → Install & manage," installed third-party plugins are listed, and an uninstall button is provided. |

What this means in practice:

- A third-party plugin can trigger a runtime through `/api/sessions/:id/plugin-rpc`, and the player approves it.
- After approval, the entry module runs right away and completes its registration. A session without a grant cannot trigger a community plugin's runtime or hooks.
- ESM inside the process is not a sandbox by itself. The `self` form treats the local user as the trust boundary. The managed form treats community server code as globally trusted at operator level. Truly multi-tenant third-party code needs a separate worker or process isolation.

What tools and guards can get:

- The toolkit for every entry factory provides only pure helper functions, and it does not inject a store. A tool reads the state of the current session and plugin through `context.store` in `execute(params, context)`. RPC and function runtimes each use their own scoped store.
- An agent guard gets the same context as a function handler: the read-only store, `ctx.world`, `ctx.inputs`, `pluginData`, logger, gateway, utils, media, and `recursiveCall`. Bundled and community plugins get the same, except that a community plugin's `utils` reaches only the addresses its `permissions.http` declares. Once the guard returns or times out, all of these stop working.
- The [same-package rule for `recursiveCall`](./plugins.md#nested-calls-ctxrecursivecall) also applies to guards. Use [services or events](./plugin-extensions.md#choose-a-way-to-communicate) across packages.

**Which language the text in a tool uses.** `context.locale` is the session's content language, and `context.messages` holds the translations in this plugin's `locales/` directory.

- When data stored by a tool is injected into a prompt, or when text a tool returns is shown to the player, write it in the session language using `translate(context, "English text")`.
- For a label drawn only by the UI, use `labelText(context, "English text")`.
- Do not write two hand-made `{ zh, en }` copies. Data injected into a prompt carries both languages to the model.

See [i18n](./i18n.md#2-localize-a-plugin) for details.

Rules for writing a third-party plugin:

- Prefer writing through a function runtime that returns proposals / `pluginData[]`.
- The entry factory only registers tools, hooks, RPCs, and wires. It does not read the session at the top level of the factory, and it produces no business side effects.
- Keep guards deterministic and read-only. Put network access, media, recursive execution, and persistence into a proper runtime handler.

### Tools for a new plugin

A new plugin registers its tools with `covel.registerTool()` in the `entry` module, and declares them in `tools.plugin` in the runtime manifest, so the model can see them. Builtin capabilities are listed directly in `tools.builtin`. The source is classified automatically by the startup process, so you do not need to edit the allow-list by hand.

Adding these three tests is recommended:

1. The tool declarations in the manifest load correctly.
2. The tool's argument validation and return shape stay stable.
3. The tool's writes to `plugin_data` / lorebook / `characters` behave consistently.

## Interaction protocol

A tool can add an `interaction` field to its return value, to say "the player needs to act here." After that, the framework takes over: it collects all the interactions, hands them to the front end, waits for the player's response, and turns the response into one natural-language sentence that becomes the player's message for the next turn.

### Protocol flow

```
Tool execute() returns { ..., interaction: InteractionPayload }
  ↓ turn-executor scans the interaction of every tool result (generic, no hard-coded tool names)
  ↓ aggregated into an array and stored in TurnMessage.pendingInput
  ↓ TurnResult.pendingInputs is returned (supports multiple plugins and multiple interactions)
  ↓ the front end renders the UI for all interactions
  ↓ the player submits POST /api/actions submit_actions { actions: [{ kind, interaction, fields }] }
  ↓ each answer is translated into natural language with its narrativeTemplate, as its action text
  ↓ the same request saves the answers and runs the following turns; the action texts are rendered as the player's message for that turn
    (plain text, which the LLM sees the same way as an ordinary message)
```

### Interaction types

| Type           | Use            | Template placeholders                                               |
| -------------- | -------------- | ------------------------------------------------------------------- |
| `form`         | Form filling   | `{{fieldName}}` — the value of a field the player filled in         |
| `choice`       | Option choice  | `{{selectedId}}`, `{{selectedLabel}}` — the option the player chose |
| `confirmation` | Confirm/cancel | `{{confirmed}}` — "Confirm" or "Cancel"                             |

### Return value examples

```typescript
// Form interaction
execute: async (params) => ({
  created: true,
  interaction: {
    type: "form",
    interactionId: params.formId,
    title: params.title,
    fields: params.fields,
    submitLabel: params.submitLabel,
    narrativeTemplate:
      "你的名字叫 {{characterName}}，拥有 {{spiritRoot}} 灵根。",
  },
});

// Choice interaction
execute: async (params) => ({
  created: true,
  interaction: {
    type: "choice",
    interactionId: params.choiceId,
    prompt: params.prompt,
    choices: params.choices,
    narrativeTemplate: "你思考片刻后决定：{{selectedLabel}}。",
  },
});
```

**`narrativeTemplate` is written by the plugin author.** It decides what one sentence of narrative text the interaction's result becomes. The framework only replaces the placeholders.

After submission, **only the filled-in narrative text is appended to the conversation history as a player message**. The framework does not add a separate message with the assistant role.

**No doubled full stop.** When a placeholder is followed directly by `.` or `。`, and the value that was filled in already ends with the same character, the rendered narrative text does not repeat that full stop. The saved form values do not change, and punctuation inside a value (including ellipses) does not change either.

### Submit API

```
POST /api/actions

{
  "requestId": "...",
  "type": "submit_actions",
  "sessionId": "...",
  "payload": {
    "actions": [
      { "kind": "act", "interaction": { "turnId": "...", "interactionId": "form-1", "type": "form" }, "fields": { "name": "林清风" } },
      { "kind": "say", "interaction": { "turnId": "...", "interactionId": "choice-1", "type": "choice" }, "fields": { "selectedId": "a", "selectedLabel": "跟随黑袍人" } }
    ]
  }
}
```

The response is an SSE stream: first `interaction.submitted`, then the events of the following turns. For requests, refusals, and resuming, see [api.md § Player interaction](./api.md#player-interaction).

## Create a new tool

### Option 1: factory function (recommended)

Write a plugin tool as a factory function. The factory's argument is `covel.toolkit`, and the framework puts `tool`, `z`, `shortId`, `shortIdBatch`, and `withPendingProposals` into it:

```javascript
// tools/my-tool.js
export default function ({ tool, z, shortId }) {
  return tool({
    name: "my-tool-name",
    description: "Create a short ID for one item.",
    parameters: z.object({
      param1: z.string().describe("Item label"),
    }),
    execute: async (params, context) => {
      // context: { sessionId, turnId, pluginId, runtimeId }
      const id = shortId(
        "item",
        params.param1,
        context.sessionId,
        context.random,
      );
      return { id, result: params.param1 };
    },
  });
}
```

**Injected objects**:

| Field                  | Type     | Description                                                                                                     |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `tool`                 | function | The `tool()` wrapper, which defines the tool's parameters and execution logic                                   |
| `z`                    | object   | The Zod schema library, used to validate parameters                                                             |
| `shortId`              | function | `shortId(prefix, label, sessionId, random?)` — generates a single short, meaningful ID                          |
| `shortIdBatch`         | function | `shortIdBatch(prefix, labels, sessionId, random?)` — generates short IDs in a batch                             |
| `withPendingProposals` | function | Binds the tool's return value to the pending proposals, and hands them to the commit chain to be saved together |

#### Reading data at run time: `context.store`

Production hosts and `test-runtime` inject `context.store` on every tool call. Its interface is the same as `FunctionStoreView`:

| Method                                                           | What it reads                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getPluginData(namespace, key)` / `listPluginData(namespace)`    | The data of the current session and the current plugin. The existing set, batch, and delete proposals from the same execution are merged in, in order.                                                                                                                                    |
| `getSession()`, `listPlayerInputs()`, `listTurnMessages(limit?)` | Read-only access to the current session. `getSession()` returns the [session view](./plugins.md#the-session-view-storegetsession). When a limit is given, it reads the latest messages. Messages include only committed turns; a turn that is running appears only after it is committed. |

Rules:

- Values read, inputs, existing proposals, and event topics are independent copies. Changing them does not change the database, and it does not change the caller's buffer. What a tool returns, and its proposals and events, are also copied before they are recorded asynchronously.
- A read handle becomes invalid after the tool returns, throws, or the call is cancelled. A read that started during cancellation does not hand its result back to the tool.
- A tool should wait for its own reads to finish before it returns. The host also waits for the reads that were started to end before it counts the tool call as finished.
- A standalone stateless executor with no DataStore configured does not provide `context.store`. A host or unit test that calls `tool.execute()` directly must supply the context itself. Plugin tests can use `bindToolStore` (from `@covel/plugin-test-utils`).

**Writes** still go through the returned `withPendingProposals(...)`. A domain state cannot be committed directly while a tool is running.

**Be careful with composite tools.** When one tool calls another tool directly inside it, the proposals the sub-tool newly produces are not yet in the executor's read snapshot. Such sub-calls must merge those local proposals themselves, using pure helper functions such as `overlayPluginDataValue`. The last parameter of `overlayPluginDataValue` is the key's stored value (`{ exists: false }` or `{ exists: true, value }`), so read the store first and merge after; it returns `{ hit, exists, value? }`. The codex sync tool is an example. Apart from that, do not merge again by hand the proposals the executor has already merged.

#### Cancellation

`context.signal` carries the caller's cancellation signal. Use it when sending requests to external services. A result that arrives after cancellation is not returned as a successful proposal. The framework cannot forcibly stop JavaScript in the same process, and it cannot undo external side effects that have already been sent.

### TypeScript entry

```typescript
import type { PluginEntryFactory } from "@covel/plugin-handlers-utils";

const register: PluginEntryFactory = (covel) => {
  covel.registerTool(
    covel.toolkit.tool({
      name: "my-tool-name",
      description: "Echo the supplied value.",
      parameters: covel.toolkit.z.object({ param1: covel.toolkit.z.string() }),
      execute: async ({ param1 }) => ({ result: param1 }),
    }),
  );
};
export default register;
```

- The parameter descriptions the model sees come from the Zod input schema.
- Full parsing still happens at run time, so `execute` receives the value after any transform.
- When the parameters cannot be converted to JSON Schema, an error is thrown when the tool is built, and the error includes the tool name. It does not fall back to a schema with no parameter descriptions.

### Results and writes

A tool that only computes can return its text directly. When it needs to write data, use `withPendingProposals(content, proposals)`. It always returns the public shape below, and it does not change the content. This is also true when the write list is empty, or when the object is frozen:

```typescript
interface PluginToolResult<T> {
  readonly kind: "covel.tool-result";
  readonly content: T;
  readonly model?: { readonly summary?: string; readonly data?: unknown };
  readonly pendingProposals: readonly PluginProposal[];
  readonly emittedEvents?: readonly {
    topic: string;
    data: Record<string, unknown>;
  }[];
}
```

To read this result, use the functions from the public SDK. Do not read the properties directly:

| Function                      | What it reads                  |
| ----------------------------- | ------------------------------ |
| `getToolContent(result)`      | The business content           |
| `getModelView(result)`        | Model-facing summary/data view |
| `getPendingProposals(result)` | The pending writes             |
| `getEmittedEvents(result)`    | The events emitted             |

For example, in a test write `getToolContent(result).someField`, not `result.someField`. After calling a helper function, you must use the object it returns.

`withPendingProposals()` and `withEmittedEvents()` can be combined in any order:

- They support plain objects, frozen objects, and scalar content.
- After combining, the same `content` and both side-effect channels are kept. Setting the same channel again replaces it.
- A combined result can be copied with object spread, `structuredClone`, or JSON, and the side effects are not lost.

`kind` does not grant write permission by itself. The host still checks the source, the permissions, and the data schema.

### Registration and declaration

When the player needs to act, add `interaction` to the return value (see the [interaction protocol](#interaction-protocol) above).

A tool is connected in two steps: **register it in the `entry` module**, and then **declare it in the manifest of the runtime that uses it**.

```js
// server/index.js — the default entry module; the root PLUGIN.md needs no `entry`
import makeMyTool from "../tools/my-tool.js";

export default function (covel) {
  covel.registerTool(makeMyTool(covel.toolkit));
}
```

```yaml
# RUNTIME.md; the root PLUGIN.md also declares contributes.tools: [my-tool-name]
agent:
  tools:
    plugin: [my-tool-name]
```

> [!IMPORTANT]
> `tools.plugin` is this runtime's tool allow-list. Execution also requires that this plugin registered the tool successfully. If a name is declared but never registered, the name fails to resolve, and it does not fall through to another plugin's tool with the same name.

## Proposal types

Tools and runtimes do not change storage directly. They produce **proposals**: records that ask for a write. The output of a runtime is eventually normalized into `Proposal[]` (defined in `packages/shared/src/types/proposal.ts`). The commit flow commits them in order, writes them to storage, and then broadcasts them as SessionEvents.

Types registered so far:

- `narrative.append`
- `event.emit`
- `interaction.request`
- `ui.render`
- `asset.generate`
- `plugin.data`, `plugin.data.batch`, `plugin.data.delete`, `plugin.data.update`
- `character.upsert`, `character.schema.set`
- `dimension.initialize`, `dimension.update`
- `lorebook.upsert`

Each type is defined in one place: `ProposalPayloadMap`. `ProposalType`, the registry of commit handlers (`satisfies CommitHandlerMap`), the payload schema of each type (`proposalPayloadSchemas`, in `@covel/shared`), and the public list (`PROPOSAL_TYPES`) are all aligned with it at compile time. To add a proposal type, change `ProposalPayloadMap`, then add its handler and its schema. If either is missing, compilation fails.

**The check before commit.** Every proposal passes the same check before its handler runs, whether it comes from a tool, a handler or a runtime's output:

- The payload must match the schema of its type and be writable as JSON. What is committed afterwards is its JSON copy: fields whose value is `undefined` are dropped, and a `Date` becomes an ISO string, so every store backend keeps the same value. A value JSON cannot hold, such as a BigInt or a circular reference, is rejected here.
- Every `MediaRef` in the payload is checked against this session (see [Media store](./media-store.md#checking-references-at-commit)).
- The handler then applies its own rules (reserved namespaces, size limits, character names, dimension providers, and so on).

A proposal that fails is not committed. Its error code is `proposal-invalid` or the rejection reason of the media check. It takes the commit-failure path: an optional runtime next to a committed story loses only its own writes, and an execution with no story (manual, background, setup) commits nothing. Never only part of the proposals lands.

Plugin data uses `plugin.data`, isolated by `(sessionId, pluginId, namespace, key)`.

### `ui.render`

Writes a generic UI block into the chat message, and emits a `ui.rendered` event. The payload uses the parts model:

```typescript
interface UIRenderInstruction {
  parts: readonly UIRenderPart[];
  layout?: "stream" | "split" | "overlay";
  status?: UIPartStatus;
}
```

The commit trace records `ui.rendered`, and it records one `ui.part.update` for each part. `status` is the display state of the UI, and it is unrelated to the runtime's `success` / `failed` execution state.

### `character.upsert`

Writes or updates one session-level character record. At commit time it is saved to the `characters` table, and it emits a `character.upserted` SessionEvent.

The HTTP `POST /api/sessions/:id/characters` also commits through this proposal internally.

**Payload (`CharacterUpsertPayload`):**

| Field           | Type    | Required | Description                                                                                                                                                |
| --------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id              | string  | ✓        | Character ID                                                                                                                                               |
| name            | string  | ✓        | Character name                                                                                                                                             |
| type            | string  |          | Character type, default `npc`                                                                                                                              |
| description     | string  |          | Character description                                                                                                                                      |
| fields          | unknown |          | Character attributes                                                                                                                                       |
| version         | number  |          | Version number, default `1`                                                                                                                                |
| expectedVersion | number  |          | The version the update proposal read. At commit time, `fields` is merged into the latest character as a shallow patch, and the live version is incremented |
| createdAt       | string  |          | Creation time, defaults to the commit time                                                                                                                 |

`sync-characters` fills in `expectedVersion` automatically.

**Parallel updates do not drop each other's fields.** Two runtimes running in parallel in the same stage, even if both start from v1, re-read the latest character in order at commit time, and then merge each one's fields patch. A later commit does not lose a new field from an earlier commit. If both changed the same field, the later patch overwrites the earlier one.

### `character.schema.set`

Replaces the session's character schema as a whole. The payload is `{types: string[], attributes: AttributeDef[]}`, and it does not accept `version`: the kernel increments the version from the current record and saves the timestamp.

The write must be compatible with the characters that already exist in the session. An unknown character type, or a character that does not meet the attribute constraints, makes the commit fail.

During execution, `ctx.world.characterSchema` and `ctx.world.characters` validate the upstream proposals that succeeded, and the runtime's own pending proposals, using the same rules as the commit.

After a successful commit, `character-schema.changed {schema}` is emitted, and the client uses it to refresh the character field definitions.

### `lorebook.upsert`

The payload is `{entries:[{id,keys,content,strategy,position?,insertionOrder?,enabled?,extra?}]}`. `strategy` is `constant` or `selective`.

**Who owns an entry.** The owner is fixed by the proposal's source as `{kind:"plugin",pluginId}`. A plugin cannot declare itself to be the world or player owner, and it cannot overwrite another plugin's entries.

**An entry's identity** is `(sessionId, owner, id)`:

- A world import writes the world owner. The player management API writes the player owner.
- The same id under different owners is a separate entry for each owner.
- When an entry is updated, its `createdAt` is kept.
