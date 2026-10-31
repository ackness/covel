# Plugin Extension Points

Some work is not done by the kernel itself. Instead, it is handed to plugins: adding a passage to the prompt, compressing the history, or filling a slot in the interface. For each such job, the kernel defines a versioned contract called an **extension point**. A plugin that implements it is called a **provider**.

This page explains how to declare and register a provider, how the kernel combines several providers, and the inputs and outputs of two extension points: session world context and history compression. Plugin authors who write providers need it.

For requests or follow-up work between packages, choose a service or event from the [communication guide](./plugin-extensions.md#choose-a-way-to-communicate); [nested calls with `ctx.recursiveCall`](./plugins.md#nested-calls-ctxrecursivecall) stay within one package. Function runtimes and tools call services, and an agent can import a model-facing service as a tool; see [How tools and agents use services](./plugin-extensions.md#how-tools-and-agents-use-services).

To have another agent answer a brief, no extension point is needed: the provider is an agent runtime that declares `schedule.subagentOnly` and `io.output.contract`, and the caller runs it as a [sub-agent](./plugins.md#sub-agents) with `ctx.agents.run` or the `delegate` tool. A sub-agent runs inside the caller's execution, can be found by contract in another package, and returns output only, with no writes.

## Declaring and registering

There are two steps, just as with tools and hooks:

1. In the root `PLUGIN.md`, declare `{point, id}` under `contributes.extensions`.
2. In the `entry` module (`server/index.js` by default), call `covel.provideExtension()` with the same `{point, id}`.

The loader checks both sides. If something is declared but not registered, or registered but not declared, the plugin fails to load.

```yaml
contributes:
  extensions:
    - point: prompt.segment@1
      id: direction
```

```js
export default function (covel) {
  covel.provideExtension("prompt.segment@1", "direction", {
    handler: (_input, ctx) => [
      {
        id: "direction",
        content: `Locale: ${ctx.locale}`,
        position: "system",
        audience: "story",
        volatility: "stable",
      },
    ],
  });
}
```

The example above shows only the shape of a declaration and a registration. For real prompt content and caching rules, see [Prompt structure](./prompt-structure.md) and the [memory plugin implementation](../../../plugins/memory/PLUGIN.md).

A provider is called only if it is enabled in the current session and has the authorization it needs.

## Combination modes

An extension point can have several providers. The kernel decides how to use them based on the extension point's mode:

| Mode       | How they are combined                                                                    | Current examples                                                     |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `single`   | Resolves one valid provider. If none exists, the call site decides the default behavior. | `session.world-context@1`, `history.compact@2`, `media.image-flow@1` |
| `collect`  | Collects the output of every provider that passes validation                             | `prompt.segment@1`                                                   |
| `pipeline` | Passes the previous valid result along, in declared order                                | `prompt.history-transform@1`, `ui.slot@1`                            |

Each extension point defines its own inputs, outputs, mode, timeout, and failure policy in `packages/shared/src/extension-points/`. The failure policy `onError` has two values: `skip` (skip this provider and continue) and `fail-turn` (the whole turn fails).

| Extension point              | Mode       | Timeout | `onError`   |
| ---------------------------- | ---------- | ------- | ----------- |
| `prompt.segment@1`           | `collect`  | 500 ms  | `skip`      |
| `prompt.history-transform@1` | `pipeline` | 500 ms  | `skip`      |
| `ui.slot@1`                  | `pipeline` | 500 ms  | `skip`      |
| `media.image-flow@1`         | `single`   | 500 ms  | `skip`      |
| `session.world-context@1`    | `single`   | 500 ms  | `fail-turn` |
| `history.compact@2`          | `single`   | 60 s    | `skip`      |

## Depending on an extension point

The root `requires` can list extension points or UI slots. This means "someone in the session must implement it". The rules are:

- The resolver recognizes providers from `contributes.extensions[].point`, and from the `slot` of `ui.slot@1`.
- A non-empty `contributes.prompt` counts as implementing `prompt.segment@1` (the host implements it on the plugin's behalf).
- Writing the name of a kernel contract only in the root `provides` does not satisfy another plugin's dependency.
- Client-side preselection and server-side activation use the same rules. A provider that has no authorization, or that is explicitly excluded, is not added automatically.
- `conflicts` cannot reference kernel extension points or specific slots. Both the author validation and a direct call to the session resolver return `invalid-conflict`.
- Mutual exclusion for `single` is guaranteed by the mode itself. `collect` and `pipeline` allow several implementations to coexist.

## What a handler can get

A provider's handler receives two arguments: the input the extension point defines, and the context `ctx`.

- `ctx.pluginData` is read-only, and it can read only the provider's own data. It cannot read `_hidden.*` hidden world data, because the output of an extension point goes into the prompt or to the client. It has no `set` or `update`: an extension point handler does not write data. Writes belong to runtimes; a function runtime uses `ctx.pluginData.set` or the operation-based `ctx.pluginData.update`, which commit with the execution's proposals (see [Local code · Change data](../plugins/local-code.md#change-data) and [Transactions · Operation-based writes](./transactions.md#operation-based-writes-plugindataupdate)).
- `ctx.world` is the session's World Model view: `characters`, `characterSchema`, `dimensions`, and the session's seats, `seats`. Every call site gives this session's view, including calls outside a turn (the image flow, history compaction, UI slots), which read the committed state.
- To find the character the player is acting as, use the SDK's `actingCharacterOf([], ctx.world.characters, ctx.world.seats)`, not `find(type === "player")`: a session may have several `type: player` characters. Extension providers have no actions and pass `[]`, returning the primary seat’s current character. For the full rule, see [Seats](./world-model.md#seats).
- It cannot read other plugins' private namespaces from here.
- A community provider's `ctx.utils`, like its `covel.http`, reaches only the origins listed in the `permissions.http` of its own package (see [the plugin reference](./plugins.md#runtime-field-groups)).

Service and extension contexts share `sessionId`, `locale`, read-only `pluginData`, `world`, and `getOwnSettings()`; see the [service context](./plugin-extensions.md#what-a-service-can-and-cannot-access) for in-execution visibility rules. Extensions still read their own execution snapshot.

The read methods of `ctx.pluginData` have the same shape in four places: a function runtime's handler, a runtime's guard, an extension point's handler, and a service handler. Code can be moved directly between them.

| Method                | Returns                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `get(namespace, key)` | The stored value itself. Returns `null` if it does not exist.                                                 |
| `list(namespace)`     | An array of `{ key, value, createdAt, updatedAt }`, in creation order, without the storage identifier fields. |

An extension point's handler has only these two read methods. It has no `set` or `delete`.

The input and every output are validated against the extension point's schema. Timeouts and exceptions are handled according to that extension point's `onError`.

> [!TIP]
> An extension point is not a way for plugins to call each other. To send a request to another plugin and get a result back, use a public service contract. To read the results of an upstream runtime in the same turn, use the runtime's `io.inputs`. For how to choose, and the transaction boundaries of each, see [Plugin extension boundaries and communication](./plugin-extensions.md#choose-a-way-to-communicate).

## The two fields of the prompt segment `prompt.segment@1`

### `volatility`

`volatility` is valid only in `prompt.segment@1`. Its values are `stable`, `session`, and `turn`. It tells the kernel how often the content changes, and the kernel uses this to place the boundaries of the prompt cache. Other extension points do not read this field. The caching behavior of UI slots, history transforms, and compression is decided by each one's own implementation.

Right now, it takes effect only for two kinds of segments:

| Segment                                                             | Effect of `volatility`                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `position: "system"`                                                | `stable` and `session` go into the stable part of the system prompt. `turn` goes into the [turn context](./prompt-structure.md#turn-context) after the history (still with the system role). This keeps the system prompt unchanged every turn. |
| `position: "pre-history"` with `role` set to `system`               | All of them stay in the system prompt. Those with `turn` come after the last cache boundary.                                                                                                                                                    |
| Non-system messages with `pre-history`, `post-history`, and `depth` | This field is ignored. Caching behavior is decided by the cache_control layout of the message history as a whole.                                                                                                                               |

### `order`

Within the same `volatility` level, segments are sorted by `order` in ascending order. The default is 0.

When several plugins use the same `order`, the order is decided by `providerPluginId` (in dictionary order), and then by `id`. This order is deterministic, but it is an implementation detail, not a promise. Renaming a plugin quietly changes its position within its level. A plugin that needs a definite order should set a different `order`.

## Where the other extension points are described

- `ui.slot@1`: the provider also declares a `slot`, and may declare `order`, `watch`, or `preview`. The server handles projection, validation, and caching. The front end uses generic slots and does not read a plugin's namespace. See [UI slots](./ui-panels.md#kernel-ui-slots).
- The three stage data slots are `stage.backdrop@1`, `stage.cast@1` and `stage.choices@1`. Speaker name tags come from story segments, not from a slot. The handler returns the selected slot's value or `null`, or returns `previous` when no change is needed. See [Stage slot values](./ui-panels.md#stage-slot-values) for fields, required values, enums and limits. Each output is validated against the selected slot. An invalid output skips only that provider and keeps the previous valid value.
- To show a plugin's state on the player's status bar or on the scene HUD, provide `session.summary@1`. See [Session summary](./ui-panels.md#session-summary).
- To give a session background music, provide `stage.music@1`. See [Background music](./ui-panels.md#stage-music).
- For where world context, history transforms, and compression sit in the flow, see [Plugin contracts](./plugins.md#prompt-and-memory-extensions).

## Session world context

`session.world-context@1` gives runtimes and the client the current world state of the session. It is in `single` mode: only one provider is used, and the states of several plugins are not merged.

All output fields are optional. When nothing has been initialized yet, it can return `{}`. Empty maps or entries are also valid.

| Field                       | Shape                                 | Description                                                                                                      |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `schema`                    | `Record<string, unknown>`             | The session's character schema                                                                                   |
| `entries`                   | `Record<string, unknown>`             | Other world context entries. They are not a copy of the current dimension values.                                |
| `dimensions`                | `DimensionSnapshot`                   | `{id: {name, description?, schema, value, version}}`. Does not contain initial values or rules.                  |
| `dimensionRecovery`         | `{editorRuntimeId, trackerRuntimeId}` | The full names of the registered recovery runtimes owned by the same plugin. The host validates them.            |
| `dimensionProviderPluginId` | string                                | Injected by the host from the actual provider. The owner identity a plugin reports about itself is not accepted. |

Note that a dimension **declaration** in a world package and a **snapshot** in the session are two different shapes.

Rules for dimensions:

- When a world declares dimensions, the session must have exactly one enabled provider of `world.dimensions@1`. This contract defines the shape of the public snapshot, and it is also how the provider is found.
- The actual output is published by a read-only pre-turn runtime. It is not a case of each plugin stitching its private namespaces into one shared state bus.
- The `dimension-context` of the built-in provider `world-init` reads only the committed `_dimensions`. `session.world-context@1` gives the runtime and the client a snapshot of the same shape.
- When the provider is removed, or when an authoritative read fails, the system does not fall back to the initial values the author wrote.

Reading and recovery:

- Public reads are frozen within one execution. After the post-turn update is committed, the next execution publishes the new version.
- The two recovery entry points point to the manual editor and to the tracker. When a player retries, the tracker is triggered directly, with `retryFromTurnId` passed in. The editor does not call the tracker in turn.

See also [Dynamic dimension snapshot](./world-model.md#dynamic-dimension-snapshot) and [Edit and recovery API](./api.md#dimension-editing-and-recovery-of-pending-settlements).

## History compression `history.compact@2`

Once the conversation gets long, the kernel asks the provider of this extension point to write summaries of the earlier messages.

### Input

| Field               | Meaning                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages`          | The messages to compress                                                                                                                                                                                    |
| `existingSummaries` | The summary segments that already exist                                                                                                                                                                     |
| `locale`            | The session language                                                                                                                                                                                        |
| `estimatedTokens`   | The estimated number of tokens                                                                                                                                                                              |
| `contextWindow`     | The smaller of the two capacities, for the story model and the fast model, after each one's reserved space for the reply is subtracted. Used to compute the trigger threshold and the total summary budget. |
| `inputWindow`       | The input capacity of the fast model itself. A summary request must fit within this capacity.                                                                                                               |
| `summaryBudget`     | `{maxTokens, maxSegmentTokens, maxSegments}`                                                                                                                                                                |

### Output

The output is `null`, or:

```text
{
  summaries: [{ messageIds, replacesSummaryIds, content, focusSections, truncated? }],
  deferred?: { reason }
}
```

- Each segment must cover one of two things: a continuous prefix of messages that have not been compressed yet, or the oldest continuous run of summaries.
- The host validates the references, the order, and the budget. Then, in one transaction, it replaces only the summaries listed and marks the matching messages.
- The default provider keeps the segments stable. It merges the oldest continuous segments only when the total budget is exceeded or there are more than eight segments. The budget of a single segment grows with the amount of source text and the window. For the specific budgets, see [Prompt structure](./prompt-structure.md).

### The new summary is written, but merging the old summaries fails

The provider does not drop the new summary. It returns only the new summary, together with `deferred: {reason}`, and leaves the merge for a later turn.

- The host saves it as usual, and it records `reason` as one failure (`context.compaction.failed`, which counts toward the consecutive failure count).
- In this case the total summary amount may temporarily exceed the budget, up to twice the budget (for both the number of segments and the tokens). When it goes past twice the budget, the result is rejected.

### How a compression failure is reported

`null` means only "there is nothing to compress".

When a provider cannot finish a compression (the model returns an error or times out, the summary is empty, the merge fails, or the input does not fit the window), it must **throw an error with a reason**. Do not return `null`. What happens next:

- The host skips the provider according to `onError: "skip"`, records the reason in the turn trace as `context.compaction.failed`, and it can be seen in `/debug`.
- Every turn that goes over the threshold retries once.
- After 3 consecutive failures in the same session, the player sees a failed task in the execution timeline. It explains that the story memory cannot be compressed, and what can be done about it. After that, the notice repeats every 3 more failures.
- A successful compression, or a run with no failure, resets the count to zero.
- The count exists only in the server process. After a restart, it starts counting again.

## Contract versions and compatibility

The `@N` in a contract ID is the version number, for example `prompt.segment@1`. Each extension point has only one current version. The kernel does not negotiate versions, and an old version has no grace period.

- An incompatible change is published under a new contract ID (`@2`, `@3`). The kernel and all built-in providers are upgraded in the same change, and the old version stops working at that point.
- `pnpm validate:plugin` always validates plugins against the current kernel contracts.

Plugins outside this repository must follow the contract upgrades in the main repository. The CHANGELOG marks incompatible changes and gives migration notes.

## Helper functions in the public SDK

Plugin code depends only on the SDK (`@covel/plugin-handlers-utils`). It does not need to import the host's internal packages for the items below. The host uses the same implementations.

| Need                                          | Where to get it                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Estimate the number of tokens                 | `estimateTokens`                                                                                                                                                                                                                     |
| The list of built-in tool names               | `FRAMEWORK_TOOL_NAMES`                                                                                                                                                                                                               |
| Resolve multilingual text                     | `resolveI18nText` / `resolveI18nDeep`, and the locale registry                                                                                                                                                                       |
| Form tools, character field validation        | The SDK root entry point                                                                                                                                                                                                             |
| Types used by a `world.dimensions@1` provider | The schema and materializer from `@covel/plugin-handlers-utils/dimensions`                                                                                                                                                           |
| Load the plugin's own prompt templates (Node) | `createPromptLoader(root)` from `@covel/plugin-handlers-utils/prompts`, which reads only the English `<name>.md` and the Simplified Chinese `<name>.zh.md`. This sub-entry point is not part of the root module used in the browser. |

For the return rules of hooks, see [Hooks](./hooks.md#how-an-event-runs). No return value means continue. On an event that can be intercepted, a handler that fails counts as a rejection. On other events, a handler that fails is skipped, and rewrites that succeeded before it are kept.
