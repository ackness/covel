# Plugin Contract Reference

This page lists every declaration a plugin package can make: the fields of the root `PLUGIN.md`, the fields of a runtime, the rules for inputs and outputs, and the built-in plugins that ship with Covel. Come here when you write, change, or review a plugin. If this is your first plugin, read [Your First Plugin](../plugins/first-plugin.md) and [Plugin Essentials](../plugins/essentials.md) first.

A plugin package does three things:

- In the root `PLUGIN.md`, it says who it is, which contracts it provides and needs, and what it contributes (tools, data, UI, and so on).
- It runs work through zero or more runtimes. A runtime is one schedulable unit of execution. It is either driven by a model (`agent`) or is a piece of JavaScript (`function`).
- The framework provides storage, transactions, scheduling, tool execution, and extension points. The plugin provides the gameplay meaning.

The source of the built-in plugins is in [plugins/](../../../plugins/). Optional plugins are in the [official community repository](https://github.com/covel-ai/covel-plugins).

> [!IMPORTANT]
> Covel supports only the format described on this page. A flat old-style manifest, a `PLUGIN.md` in a subdirectory, role mirrors, and old checkpoint development data cannot be read. You must regenerate them. There is no migration read path and no dual write.

## Package and Runtime Files

```text
example/
├── README.md
├── PLUGIN.md
├── PLUGIN.zh.md
├── locales/
│   └── zh.yaml
├── server/index.js
├── schemas/
├── ui/
└── runtimes/
    └── extract/
        ├── RUNTIME.md
        ├── RUNTIME.zh.md
        └── handler.js
```

Layout rules:

- The root `PLUGIN.md` is required. The plugin ID is the package directory name; when you write `id`, it must match that name. `framework` is kept for the framework itself and cannot be used as an ID.
- A `package.json` is optional. Without one, the package's `.js` files load as ES modules. When there is one, it must say `"type": "module"`; the host does not read its `version`, `author`, `license` or `homepage`, which are written only in `PLUGIN.md`.
- If there is only one runtime, write it in the `runtime` section of the root file. The body of the root file is then its prompt.
- If there are several runtimes, put each one in `runtimes/<id>/RUNTIME.md`. Its logical ID is `<pluginId>/<id>`. The body of each file is the prompt for that runtime.
- You cannot mix the two layouts. A child runtime cannot declare package-level contributions.
- A package that has only an entry, UI, or extensions can have no runtime at all.

Every real subdirectory under `runtimes/` must contain a correctly capitalized `RUNTIME.md`; put shared code in `lib/` at the package root. When a manifest is missing, the loader reports its path and still loads the other runtimes. Static validation and installation reject that layout. Runtime directory symlinks are excluded from discovery and localization scans.

Every `PLUGIN.md` and `RUNTIME.md`, and their language variants, must start with plain YAML wrapped in a single `---` line. Forms such as `---javascript` and `---js` that would run code are rejected before parsing. This means installing, copying a folder in by hand, and reloading can never run code through metadata.

The full list of fields is generated from the Zod schemas. It is not maintained by hand:

- [plugin-manifest.schema.json](../../../packages/shared/schemas/plugin-manifest.schema.json) · [field table](./schema/plugin-manifest.md)
- [runtime-manifest.schema.json](../../../packages/shared/schemas/runtime-manifest.schema.json) · [field table](./schema/runtime-manifest.md)

The tables on this page only summarize what each group of fields is for. The generated field tables are the authority on which fields are valid, their types, whether they are required, and their allowed values.

When you write code that validates a manifest, import two entry points from `@covel/shared`: `pluginManifestSchema` validates a package manifest, and `runtimeAuthoringManifestSchema` validates an author's runtime. The more detailed schemas (input and output settings, command arguments, projection items, binding references, and so on) are internal. They are not exported separately from the package entry point.

How the loader handles these files:

- The format an author writes is compiled into an internal execution structure, `RuntimeManifest`. The fields of the internal structure are not the author format, so do not copy them to the root level of `PLUGIN.md`.
- Loading produces two parts: the package definition `ParsedPluginMd` and the execution definition `ParsedRuntimeMd`.
- `loadPluginDefinition()` always returns a `packageManifest` and an array called `manifests`. If the array is empty, there is no runtime that can be scheduled.
- `parsePluginMd()` parses only the package. An inline runtime in the root file is compiled explicitly by `compileInlineRuntime()`.
- The package's entry, UI, events, commands, and extensions are registered once, from the root definition. They are not copied to each runtime. Each runtime keeps its own execution identity and version, and it inherits the user settings and data schemas that its execution needs.

## Root PLUGIN.md

```yaml
---
displayName: Example
description: Records useful facts after each story turn.
requires: [narrative-engine@2]
contributes:
  tools: [save-facts]
  data:
    facts:
      schema: ./schemas/facts.schema.json
runtime:
  schedule:
    stage: post-turn
  io:
    inputs:
      narrative:
        from: { contract: narrative-engine@2 }
        select: /narrativeOutput
    output: { contract: example.facts@1 }
  agent:
    finishWith: save-facts
---
Extract facts supported by runtime-inputs.narrative.value, then call save-facts.
```

The ID of this package is its directory name, `example`; its entry is `server/index.js` (which registers `save-facts`); the runtime has no `function` block, so it is an agent; and the package provides `example.facts@1` because the runtime outputs it. None of these needs to be written; see [Defaults](#defaults).

<!-- prettier-ignore -->
| Root field | Meaning |
| --- | --- |
| `id` | The plugin ID. When left out, it is the package directory name; when written, it must match that name. |
| `kind` | `core` (added to every game by default) or `plugin` (the value when left out; added only when chosen). |
| `version`, `displayName`, `description`, `tags` | Metadata. Tags group and filter plugins in session prep; they do not determine runtime scheduling. Covel works out the `ui:*` and `cost:*` tags; authors write only the others, such as `mode:*`. See [Derived tags](#derived-tags). |
| `author`, `license` | Author information, shown only for display. See [Author information](#author-information). |
| `provides` | Contracts that no runtime outputs (for example, ones a service provides), or contracts to mark as `{contract, default: true}`. The `io.output.contract` of each runtime is added on its own; do not write it. |
| `requires` | Required contracts. The resolver adds a provider for each one. A contract that a runtime refers to but `requires` does not list is optional. |
| `conflicts` | Makes the package mutually exclusive with other plugins that provide these contracts. |
| `contracts` | Schema declarations for contracts, as `{contractId: {schema: ./path.json}}`. Contracts received by a `contributes.data` namespace do not need to be listed here. |
| `entry` | The path, relative to the package root, of the module that does the registration. When left out, `server/index.js` is used if it exists. |
| `contributes` | Package-level contributions. See [contributes fields](#contributes-fields). |
| `runtime` | An optional declaration of a single runtime. |

Root fields that are rarely needed, such as `covel` and `homepage`, are in [Advanced fields](#advanced-fields).

A contract is a versioned name, such as `narrative-engine@2`. Plugins find each other through it, not through plugin IDs. A few rules:

- The contracts this package provides are `provides` plus the `io.output.contract` of each runtime.
- Within one package, two runtimes cannot produce the same contract (`ambiguous output contract`).
- Different packages can provide the same contract. A consumer says whether it wants one provider or all of them, using `cardinality: one` (the default) or `all`.
- Only an extension point that allows one provider, and an explicit `conflicts` entry, get a separate mutual-exclusion check.
- `conflicts` can name only plugin contracts. If you write a kernel extension point or a UI slot, you get `invalid-conflict`, and the error points to the position of the `conflicts` field. How kernel extension points combine is decided by their mode.

Session prep groups the plugins by whether they call a model, that is by the derived `cost:*` tag. A plugin without that tag goes under its first tag (the tags the author writes come before the derived ones), and one with no tags under “Untagged”. A derived tag shows as words ("Calls a model", "Player actions"), and a tag the author wrote shows as written. Each plugin appears once; all tags remain available for filtering. The `kind: core` badge says “Enabled by default” and does not indicate a lock. “Builtin” in the session list describes the source only.

### contributes fields

<!-- prettier-ignore -->
| `contributes` field | Registration or resource it maps to |
| --- | --- |
| `tools` | Tool names passed to `registerTool` |
| `actions` | Nonempty `registerRpc` action names; `covel:`, `runtime:` and `event:` prefixes are reserved for framework approvals and rejected in declarations, registration and action requests. |
| `commands` | Player command metadata. Its `action` must be listed in `actions`. |
| `services` | Contract IDs passed to `registerService` |
| `extensions` | Extensions provided with `provideExtension`, written as `<point>/<id>`, such as `prompt.segment@1/notes`. To set options such as `order` or `slot`, write `{point, id, …}`. |
| `hooks` | The hook events the package listens to, written as event names, such as `PreToolUse`. To set `enforce`, write `{event, enforce}`. See [Hooks](./hooks.md). |
| `forms` | Form IDs passed to `registerFormValidator` |
| `events` | Plugin event contracts |
| `settings` | Player settings. The runtime reads them through `ctx.userSettings`. |
| `data` | The schema, version, accepts, and search settings for this plugin's data namespace |
| `datasets` | Typed datasets the package owns: the name is the namespace, with schema, key and ops. See [Datasets](#datasets-contributesdatasets) |
| `actionKinds` | Action kinds players may submit: name, roles, text rule, `fields` schema and display label. See [Action kinds](#action-kinds-contributesactionkinds) |
| `ui` | Paths, relative to the package root, of the `right/message/view` UI spec files |
| `ui.view` | Full-column view spec paths relative to the package root; see [Plugin views](./ui-panels.md#plugin-views) for declarations and consent |
| `worldProjections` | Declarations of world data projections |
| `prompt` | Static prompt sections |

Registrations in `entry` and declarations in the manifest are checked in both directions. If something is registered but not declared, or declared but not implemented, loading fails. Package-level contributions belong only to the root file. They are not merged with the fields of a child runtime. `wires` and other rarely needed forms are in [Advanced fields](#advanced-fields).

Authors can generate the six registration lists from their entry with `pnpm plugin:extract <dir>` and check drift in CI with `--check`. This executes the author's own code; installation, approval and static validation still read declarations, and loading still checks both directions. See [Plugins with local code](../plugins/local-code.md#4-write-the-entry-file) for the rewrite scope and command usage.

Bundled plugins follow the same current data contracts as external packages. Dice receipts carry a `checks` array, and `pluginData.get()` returns the stored value directly. A narrative binding projected with `select: /narrativeOutput` carries a string. World rules use flat records with `schemaVersion`, `id`, and `content`, without a `{ rule, ... }` wrapper. NPC edge history permits one open version per relation; duplicate open versions are rejected without automatic repair. Portrait replacement matches an exact character ID or the current `npc-<blueprintId>` projection, never an arbitrary session prefix.

### Contract version policy

The `@N` in a contract ID is its version marker, such as `narrative-engine@2`. The kernel supports only the current version (current-only). It does not negotiate versions, it does not support several versions at once, and it has no cross-version compatible reads or dual-write migration.

- A breaking change uses a new contract ID, such as `@2`. The provider and the consumers are upgraded together in the same change. The old version stops working at that point.
- Snapshots of old sessions and queued jobs must be rebuilt.
- Record the change in the CHANGELOG and in the migration notes of the related PR.

Authors of external plugins should follow the framework's [CHANGELOG](../../CHANGELOG.md). After a contract change, upgrade your plugin and update the contract versions it declares.

## Runtime Field Groups

| Field         | Main settings                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `schedule`    | `stage`, `every`, `trigger`, `needs`, `after`, `detached`, `background`                                    |
| `io`          | `inputs`, `selfData`, `payloadSchema`, `output`, `visibility`, `concealed`                                 |
| `agent`       | `model`, `toolChoice`, `reasoning`, `history`, `tools`, `finishWith`, `completion`, `loop`                 |
| `function`    | A runtime with this block is a function, one without it an agent; `handler`, `model`, `timeoutMs`, `tools` |
| `guard`       | The guard module, relative to the runtime                                                                  |
| `effects`     | Read and write resources, and `parallelSafe`                                                               |
| `permissions` | Declaration of the permissions the execution needs                                                         |

The root `PLUGIN.md` can also have `permissions.http`. It covers the code of the `entry` module: in a community package, `covel.http` (used in tools, hooks, RPC, services, extensions and wires) reaches only the origins and methods listed in the `permissions.http` of the root file and of each runtime. A wire can also reach the endpoint of the slot it is serving. An undeclared request fails before it is sent: `http permission denied: …`.

```yaml
permissions:
  http:
    - origin: https://api.example.com
      methods: [POST]
```

### Defaults

Leave out a field whose value is the default. When you write one, `pnpm validate:plugin` gives a warning (`is the default value; remove it`) and the package still passes.

<!-- prettier-ignore -->
| Field | When left out |
| --- | --- |
| `schedule.trigger.type` | `auto` |
| `schedule.every` | `1`: runs every turn |
| `schedule.detached` | `false`: the turn waits for the runtime |
| `schedule.detached.settle` | `false`: the player's next action does not wait for it |
| `schedule.background` | `false`: the caller waits for the result |
| `io.visibility` | `system` |
| `cardinality` (`needs`, `after`, `io.inputs.*.from`) | `one` |
| `io.inputs.*.required` | `true` |
| `io.inputs.*.scope` | `turn` |
| `io.selfData[].format`, `maxEntries` | `summary`, `50` |
| `agent.model` | `story` for a runtime with `io.visibility: story`, `plugin` for any other |
| `agent.reasoning` | `true`: the model's own reasoning setting applies |
| `agent.toolChoice` (with `finishWith`) | `required` |
| `agent.loop.timeoutMs`, `callTimeoutMs`, `maxRetries` | a runtime with `io.visibility: story`: 240000, 120000, 1; any other: 120000, 60000, 3 |
| `agent.loop.profile` | `story` for a runtime with `io.visibility: story`, `system` for any other |
| `agent.loop.stream`, `steering`, `truncation`, `fallback`, `finalizer.*`, `corrections.*` | the chosen profile's value; see [Loop profile](#loop-profile-agentloopprofile) |
| `contributes.data.*.version` | `1` |
| `contributes.hooks[].enforce` | `normal` |
| `contributes.extensions[].order` | `0` |
| `contributes.prompt[].role` | `system` |

`pnpm validate:plugin` also warns about a declaration that has a shorter form (`it means the same`), and the package still passes:

- A hook with only `event` is written as the event name: `- PreToolUse`.
- An extension with only `point` and `id` is written as `<point>/<id>`.
- `completion: {require: tool-use, afterTools: [one tool]}` with `toolChoice: required` is written as `finishWith: <tool>`. See [Completion conditions](#completion-conditions-agentfinishwith-agentcompletion).

Covel works out the fields below when they are left out. When one is written with the value Covel would work out, `pnpm validate:plugin` warns in the same way (`is the default value; remove it` or `is worked out from …; remove it`).

<!-- prettier-ignore -->
| Field | When left out |
| --- | --- |
| `id` | The package directory name |
| `kind` | `plugin` |
| `entry` | `server/index.js` when the package has it; otherwise no entry |
| The runtime type | A function runtime when there is a `function` block; otherwise an agent |
| `function.handler` | `./handler.js` next to the manifest |
| `provides` | The `io.output.contract` of each runtime |
| `ui:*` and `cost:*` in `tags` | Worked out from the package; see [Derived tags](#derived-tags) |
| `contributes.data.*.authoring.source.key` | `id`; `filename` for a media directory |
| The format of `contributes.data.*.authoring.source` | Worked out from `path`: `.yaml`/`.yml`, `.json`, or a media directory without an extension |

#### Derived tags

The tags the author writes come first, followed by the derived tags in this order. A written `ui:*` or `cost:*` tag is ignored.

<!-- prettier-ignore -->
| Tag | When it is added |
| --- | --- |
| `cost:llm` | There is an agent runtime, or a function runtime that writes `function.model` |
| `cost:function` | There is a function runtime that calls no model; or there is no runtime, but there is an entry or `contributes.worldProjections` |
| `ui:right-panel` | `contributes.ui.right` has a panel |
| `ui:message-block` | `contributes.ui.message` has a message block |
| `ui:manual-action` | There is a runtime with a `manual` trigger, or there are `contributes.actions` / `contributes.commands` |

`io.visibility` has two values: `story` for the narrative runtime that provides the story text, and `system` for every other runtime.

### Two kinds of runtime

- A **function runtime** is a runtime with a `function` block. Its handler is the module that `function.handler` names, or `./handler.js` next to the manifest when it is left out; the module must default-export a function. It cannot also set `agent`. When `function.handler` is not written and there is no `handler.js` next to the manifest, the runtime cannot run: the loader leaves it out and says why, and `pnpm validate:plugin` and installation report it as an error.
- An **agent runtime** is a runtime without a `function` block. The body of its file is its prompt.
- `function.model` says which model slot (such as `memory`) the `ctx.gateway` calls in the handler use. Before a detached (background) job is claimed, the system uses this to check whether its credentials are ready. If you do not declare it, the check uses the system default preset. That can miss a slot binding set for a single request, and then the job waits in the queue until `maxQueueMs` runs out.
- When `agent.model` is left out, an agent with `io.visibility: story` uses `story` and any other agent uses `plugin`.
- `agent.model` and `function.model` only name a role (slot). A plugin cannot choose a provider, model, address, or protocol: the player's model settings decide them (see [Actual selection priority](./slots.md#actual-selection-priority)). An `llm.toml` in a plugin's directory is not read.

### Which tools an agent can use

- When a package has only one inline runtime (its runtime ID equals the plugin ID), an agent that does not set `agent.tools.plugin` gets all of the tools in `contributes.tools` automatically. Set `plugin: []` to give it none.
- If you add a tool to such a package that only a UI action should use, also write the agent's allowlist. Otherwise the model can call that tool too.
- In a package with several runtimes, each runtime must declare its own tools.

### Agent guards

An agent's guard runs before the model is called.

- Returns `{ skip: false }`: the runtime runs as usual.
- Returns `{ skip: true, ...fields }`: the model is not called, and the result is recorded as `skipped`. The fields other than `skip` are this runtime's output. If you declare `io.output.contract`, that output is validated against the contract and bound to consumers as usual. The `skip` marker itself is not part of the validation or the binding.

When the runtime needs to give up its work for this turn, return the smallest output the contract allows. For example, when `story-events/plot` is off, return an empty plan, `{ skip: true, events: [] }`.

A guard gets the same `ctx` as a function handler, and a bundled plugin gets the same as a community one:

- It has `ctx.inputs` (this execution's input bindings), `ctx.world`, `ctx.store`, `ctx.pluginData`, `ctx.recursiveCall`, and the other helpers.
- Its plugin-data reads, like a function handler's, include the writes of upstream runtimes of the same plugin in this execution (see [In-execution plugin-data visibility](#in-execution-plugin-data-visibility)).
- Write through `ctx.pluginData`, or attach proposals to the skip result with `withPendingProposals`. These writes commit only when the guard skips; otherwise they are dropped, and the model's run decides what to write.
- Once the guard returns or times out, `ctx.signal` is aborted and all of these stop working.

### Runtimes that hide content (`io.concealed`)

Use `io.concealed: true` for runtimes that handle hidden content, such as an agent that plans hidden events in the story.

- Before the framework writes a trace or pushes the live stream, it removes the runtime's prompt, model replies, tool arguments, tool results, and output. Only the runtime name, the tool names, the status, the duration, and the usage are kept.
- The execution results returned by `/turns` and by manual RPC also have their output and tool content cleared.
- When the runtime fails, the failure reason shown to the player (in the turn stream, the trace, and the returned result) is replaced with one fixed, generic message. The real reason is written only to the server console log.
- The stored execution record keeps the full content, so that retries can use it.
- The text in its output (`narrativeOutput` or `content`) is not written to the conversation log. So it does not reach other runtimes' prompt history, the message API, or the "rebuild prompt" API. Content it shows to the player directly (interactive forms and UI blocks) is written as usual.
- You cannot declare it together with `io.visibility: story`. A story runtime's text is the story text the player reads. A manifest that does this is rejected when it loads.
- A hidden runtime passes its result to other runtimes through an `io.output` contract or through `effects`. The author decides who can read it.

### Scope of dependencies and references

The runtime IDs written in `schedule.needs`, `schedule.after`, and `io.inputs.*.from.runtime` must belong to this package. Write the full `<pluginId>/<runtimeId>`. In a package with a single runtime, write the package ID. An unprefixed string dependency is rejected with a suggestion to write `<pluginId>/<runtimeId>`. Only a complete runtime ID from another package receives the advice to use a contract.

**Limits on references to runtimes in other packages:**

- A reference inside a package (`needs`, `after`, `inputs`) is a reasonable way to order work and pass data. You can write the specific runtime ID.
- A dependency on another package must go through a contract (`from.contract`). That way the provider can be replaced without changing the consumer.
- The loader checks references to runtimes in other packages strictly. If it finds one, it refuses to load the package.
- Writing only `after` does not activate a provider.

The contracts that a runtime's `schedule.needs[].contract` and `io.inputs.*.from.contract` refer to need no other declaration:

- For a contract listed in the root `requires`, the resolver activates a provider.
- A contract not listed in `requires` is optional: when the session has a provider, it binds as usual; when it has none, the gates apply, and a runtime whose required input or `needs` has no provider does not run. This is how a contract that another runtime in the same package provides is used.
- `schedule.after` only orders work, and `from.kernel` is a kernel input. Neither one activates another package.

**A story runtime must not hard-depend on another plugin.** One narrative plugin is enough to play, so a runtime with `io.visibility: story`:

- must set `required: false` on every input bound to a contract (`io.inputs.*.from.contract`, in both `turn` and `committed` scope). The default is `true`, which is rejected.
- cannot list a contract in `schedule.needs`; bind it as an optional input, or use `schedule.after` to order only.
- belongs to a package whose root `requires` lists no plugin contract: with a missing provider the resolver turns the whole package off. Remove the entry and let the runtime read the contract as an optional input.

Kernel extension contracts are exempt. When a provider is missing the input has no value, and the runtime must still write its story without it.

### Stages and scheduling order

Stages run in this order: `setup → pre-turn → narrative → post-turn → audit`. The next stage starts only after every runtime in the current stage has finished.

- Within a stage, the order is set by dependency edges. `needs` is a success gate: the downstream runtime runs only if the upstream one succeeds. `after` only sets the order.
- The output of a later stage cannot be used to unlock an earlier stage.

Event chains within a turn are ordered the same way. For each layer, the synchronous event runtimes that actually match are built into a dependency graph from `needs`, `after`, and `io.inputs`:

- Runtimes in the same layer that do not depend on each other each run on their own. After the layer finishes, the results are merged, and then the success gates and inputs of the downstream runtimes are checked.
- When there is a cycle, the runtimes on the cycle, and the downstream runtimes they block, are recorded as `skipped: dependency-cycle`. Other branches keep running.
- A declared dependency does not trigger a provider when no event has matched.
- A background event follower is a separate job. It does not take part in this synchronous dependency graph.

A provider that already succeeded in an earlier stage or event layer can also satisfy a `needs` on a contract with a "single provider". That way another candidate provider in the current batch does not create a false cycle. It does not cancel ordering edges that come from `after`, from requirements for "all providers", or from input bindings.

### Notes on setup runtimes

A package-level `requires` makes sure the contract's provider is activated. It does not require the provider to produce output again on every execution.

- A setup runtime that handles a form in later executions should use `after` to be placed after the one-time setup provider, and it should read the committed state.
- Do not use `needs` on a contract with the default turn scope. The provider stops running once setup is done, so the consumer is skipped by the success gate.
- `after` does not prove that initialization succeeded. A consumer's guard must check the domain state it needs itself. For example, before creating the protagonist, first confirm that `ctx.world.characterSchema` exists. If it does not exist, fail clearly. Do not generate the form, and do not write a character.

The completion state of a setup runtime is recorded against the `version` in the root `PLUGIN.md`. After you publish a new version (the `version` changed), existing sessions run it again on the player's next action:

- A session that is still in the setup stage runs it again during setup.
- A session that has already moved into the main loop runs it again before pre-turn, through the late-setup channel. Its retry budget is recalculated.

So the guard of a setup runtime must return `{ skip: true }` for work that is already done. For example, when the protagonist already exists or the schema is already written. Otherwise an upgrade makes the player see the welcome message or the form again. A plugin that does not declare `version` is treated as `0.0.0`, so an upgrade never makes it run again. When a package with an `entry` or a setup runtime has no `version`, `pnpm validate:plugin` gives a warning.

### Triggers

The trigger types are `auto` (the default), `manual`, and `event`.

- An `auto` runtime must declare a stage and runs in that stage every turn. It needs no `schedule.trigger`.
- `schedule.every: N` makes an `auto` runtime run only on the logical turns that are a multiple of N. For example, `every: 3` runs on turns 3, 6 and 9.
- `schedule.trigger` can also set `startTurn` (the first turn it may run), `cooldownTurns` (the least number of turns between two runs) and `maxTriggerCount` (the most runs in one session). When it sets only these, `type` can be left out too.
- `manual` and `event` runtimes are triggered separately, by a request or by an event. They declare no stage and cannot set `every`. A setup runtime cannot set `every`, `startTurn` or `cooldownTurns`.
- `schedule.subagentOnly: true` makes an agent runtime run only as a [sub-agent](#sub-agents): the scheduler never selects it, and no manual RPC, batch re-run or `ctx.recursiveCall` can run it. It implies `trigger: manual`, so `type` can be left out, and any other type is rejected. It cannot be a function runtime or `io.visibility: story`, and cannot set `stage`, `needs`, `after`, `background`, `io.output.recordAs` or `guard`: these mean something only for a scheduled runtime.
- `schedule.background: true` runs a manual or event runtime in the background: the caller gets a job ID at once and does not wait for the result. Such a runtime has no upstream in the same execution, so it cannot read a `scope: turn` input; use `scope: committed` or a kernel input instead.
- `schedule.detached: true` lets the turn finish first; the runtime then runs as a durable background job. It is allowed only on the `post-turn` and `audit` stages, and not on a runtime with `io.visibility: story`.
- Written as an object, `schedule.detached` sets the job's options and also makes the runtime detached: `settle: true` makes the player's next action wait until the job is done, for at most `maxSettleWaitMs` (120000 at most); `maxQueueMs` and `maxExecutionMs` limit how long the job may queue and run.
- The manifest validation and the runtime admission check enforce the specific limits.

### History window (`agent.history`)

`agent.history: {maxTurns}` limits the history in an agent's prompt to the most recent N turns.

- Turns are counted by `turnId`. `0` means no history.
- Compression summaries are removed as well, and they do not take part in the compression barrier for this turn.
- If you leave it out, the agent uses the history view shared by the session.
- The current turn is not counted in N. The current player input and the story text this execution has already produced are always sent (see [Prompt structure](./prompt-structure.md#this-turns-story-text)).

An extraction runtime that reads only this turn's input should declare it, so the prompt does not keep growing as the session gets longer.

<a id="timeouts-retries-and-completion-conditions-agentloop"></a>

### Timeouts and retries (`agent.loop`)

An agent's timeouts and retries are in `agent.loop`. When they are left out, the defaults follow `io.visibility`: a `story` runtime has `timeoutMs` 240 seconds, `callTimeoutMs` 120 seconds and `maxRetries` 1; any other runtime has 120 seconds, 60 seconds and 3. Rarely needed limits, such as the step limit, are in [Advanced fields](#advanced-fields).

A streaming call is limited by how long it goes without output: a model that keeps producing output is not cut off, and the time spent producing output does not count toward `timeoutMs`. The limits on the wait for the first output and between two outputs are in [Wait limits of a streaming call](#wait-limits-of-a-streaming-call).

**The reply is cut off (`finishReason: length`).** When a reply is cut off at the model's output limit, the cut-off tool calls and JSON cannot be used.

- The call is retried as a new attempt, with one added line that says "write only what the task needs". A model that loops or repeats itself usually finishes on a second try.
- The call fails only if it is cut off again. The error message suggests raising the output limit. If the limit is really too small, the second attempt will not finish either.
- The one exception: a runtime on the `story` profile (`truncation: accept`) produced only story text and no tool calls. In that case the text is kept and committed, and the player sees a notice that it may have stopped mid-sentence. A runtime with `io.visibility: story` uses this profile by default.

**The provider did not say why it stopped (`finishReason: other`).** The reply may stop anywhere. As with a cut-off reply, a runtime on the `story` profile that produced only story text and no tool calls keeps and commits the text, and the player sees a notice that it is not finished and the turn can be retried. Anything else fails and is not retried. See [slots.md](./slots.md#finish-reasons-diagnostics-and-refusals).

**A streaming call is interrupted after it has already produced output** (the connection drops, or it goes silent for longer than `idleTimeoutMs`).

- A runtime that streams its text to the player (the `story` profile, `stream: true`) is not retried, because the player has already read that text.
- For other runtimes, the output was not shown to anyone, so it is discarded and the call is retried according to `maxRetries`. The time spent producing the output that was already written does not count toward `timeoutMs`. Silence after that does count.

**A non-streaming call** gives no progress signal, so `callTimeoutMs` limits the total duration of a single call.

**`maxRetries`** (default 1 for a `story` runtime and 3 for any other, maximum 5) is the number of retries when a model call gets no reply.

- Retried: a call timeout, a network error, rate limiting, 5xx errors, a generation error reported by the provider, the mid-output interruption described above, and a cut-off reply.
- Not retried: 4xx errors and output that does not match the schema.
- A call rejected by a tool does not count toward this number. The model reads the error and calls again on its next step, subject to the step limit.
- There is no wait between retries. Retries and the first call share `timeoutMs`, and they also share the request budget for one logical call (120 seconds and 8 HTTP requests by default, see [slots.md](./slots.md#http-retry-cleanup)).

The budget decides how many retries can actually be used:

- A non-streaming call with `callTimeoutMs` of 60 seconds and `timeoutMs` of 120 seconds leaves room for only one more try when a call hangs and never returns. A streaming call retries according to the first-output wait rule above.
- A 5xx error that uses up every transport-level retry leaves room for only two rounds.
- Failures that return quickly and use only one HTTP request (the connection drops partway through a reply, or a generation error) are the ones that can use more attempts.

### Completion conditions (`agent.finishWith`, `agent.completion`)

An agent that finishes by calling one tool writes `finishWith`:

```yaml
agent:
  finishWith: save-facts
```

- The runtime finishes as soon as `save-facts` succeeds, without asking the model again. If it ends without a successful call to that tool, the run fails.
- The model must call a tool on every step, as with `toolChoice: required`. When `agent.toolChoice` is written, its value is used.
- It means the same as `completion: {require: tool-use, afterTools: [save-facts]}` with `toolChoice: required`.

When there are several completing tools, or the model should call `runtime-done` when nothing changed, write the full `completion`. Write only one of `finishWith` and `completion`.

- `completion.afterTools`: the run finishes once one of the listed tools succeeds.
- When the model must read the tool result and revise it, use `completion.require: tool-use` without `afterTools`. Character creation, for example, returns the filled narrative for review before the model finishes.
- `completion.require: explicit`: the run must end with a successful call to a completing tool, or with `runtime-done`. A runtime with `io.visibility: story` cannot use it.
- `completion.require: tool-use`: with a nonempty `afterTools` list, at least one listed completing tool must succeed. Without that list, any successful business tool counts. Failed calls and `runtime-done` do not count.
- If the model returns only plain text, or calls `runtime-done` while no such call has been made yet, the framework first injects a correction prompt. Only if the run is still not complete is it marked as failed. So even when "nothing changed", submit an empty result through a business tool.
- The request right after a correction requires the model to call a tool (`toolChoice: "required"`, with any tool named in the manifest kept as it is). After the model calls a tool, the choice goes back to automatic. When the model is in thinking mode, the provider does not accept a forced choice, so the model keeps choosing on its own.
- This check runs in one place, where the loop returns. It applies to every way a normal run or a resume can end: a text answer, `runtime-done`, automatic completion through `afterTools`, a `PostToolUse` hook that stops the run, and running out of steps.

### Tool choice and reasoning (`agent.toolChoice`, `agent.reasoning`)

- `agent.toolChoice: required` makes the model call a tool on every step; the model picks which one. `{name: <tool>}` makes it call that one tool. Without it (and without `finishWith`), the model decides on its own.
- `agent.reasoning: false` turns reasoning off for this runtime. It suits an extraction runtime that only fills in tool arguments. Without it, the model's own reasoning setting applies; a reasoning level the player sets explicitly still wins.
- When the model is in thinking mode, the provider does not accept a forced tool choice, so the model keeps choosing on its own.

### Function tools and timeouts

- A function's tool allowlist is in `function.tools`. It controls what `ctx.tools.call` can call.
- A function's timeout is `function.timeoutMs`. Do not put the time limit for an external service in the agent settings.
- Text calls that a function makes through `ctx.gateway` (`generateText`, `generateObject`, and `evaluate`) are not streamed, so they give no progress signal. When the model accepts the request but never answers, the host gives up on the call at half of the remaining `function.timeoutMs` (at least 60 seconds) and sends it again once. The second attempt uses the remaining time.
- If there is not enough time left for a second attempt (60 seconds or less remain), the call is sent only once, and `function.timeoutMs` ends it.
- A request that the provider rejects is still handled by the gateway's transport retries and fallback models. It is not sent again here.
- A handler whose single call really needs more time should raise `function.timeoutMs`.
- The host creates a request budget from the remaining time when each logical call starts. HTTP retries, fallback models, and a stalled-call resend share 8 transport attempts. The gateway default of 120 seconds adds no extra ceiling, and the budget cannot extend the runtime deadline.

### Inputs and outputs

```yaml
io:
  inputs:
    narrative:
      from: { contract: narrative-engine@2 }
      select: /narrativeOutput
      accepts: ./schemas/narrative.schema.json
    previous:
      from: { runtime: example/extract }
      scope: committed
      recordAs: latest-facts
      required: false
    digest:
      from: { kernel: turn-digest@1 }
  selfData:
    - namespace: facts
      as: <known-facts>
  output:
    contract: example.facts@1
    schema: ./schemas/output.schema.json
    recordAs: latest-facts
```

#### How inputs are read

- A normal input reads the result of an upstream runtime that has already finished in the same execution. `select` is a JSON Pointer into the result value.
- To read a result left by an earlier execution, use `scope: committed` with `recordAs`.
- A kernel input (`from: { kernel: turn-digest@1 }`) has only `from`. It always has a value and is not checked against a schema, so writing `scope`, `select`, `required`, `accepts` or `recordAs` is rejected.
- A schema can be a local path, or it can be written as `contract:<contractId>`. A contract schema from another provider is resolved when the package loads.
- In the prompt, an input is at `runtime-inputs.<binding>.value`. Do not rely on the old injection tags.
- If an agent runs after the narrative and it is bound to this turn's story text, that `value` is a sentence that points to the story message in the conversation. The story text itself is not repeated (see [Prompt structure](./prompt-structure.md#this-turns-story-text)).
- The name of an input binding matches only schemas and slots that are declared explicitly. A name such as `constructor` or `toString` does not read JavaScript's inherited properties.

#### Static checks

The static validation in the CLI and the installer checks inputs with `scope: turn` and with `scope: committed`:

- A local `accepts` file must exist and must be valid JSON.
- A producer runtime that is referenced directly must be in the same plugin package.
- `scope: committed` does not allow `select`, not even an empty string. The error points to `io.inputs.<binding>.select`. Ordinary turn inputs still support JSON Pointer.
- An optional external contract does not require its provider to be installed because of this.

#### `select` and optional inputs

- `select` follows RFC 6901. An array index is written as `0` or as a decimal integer with no leading zero. `/01` and `/+1` do not match an array element.
- For an input with `required: false`, the slot is left out when the static schemas are incompatible or when the actual value fails validation. The consumer runs as usual and resolves its other inputs.
- A static pattern proof handles only complete, anchored literal prefixes (such as `^audio/`). A regular expression with groups, quantifiers, or alternatives is checked against the actual value. The check does not cut out a surface prefix and reject valid input.

#### Publishing an output contract

When you publish a runtime's output contract, declare the public schema of the complete output in `contracts.<contractId>.schema` at the root.

- All providers of the same contract ID must publish the same schema.
- The public schema covers both model output and guard skip output. For example, `world-init` publishes `world-data-provider@1` with support for authored schemas of fewer than 15 attributes; the requirement to generate at least 15 stays in the `initialize-world` tool parameters.
- `world-data-provider@1` requires `success`, `attributeCount`, `dimensionCount`, and `worldSchema`. The same schema also validates tool and guard results before separation, so it permits an optional `preGameDone: true`. This is a completion signal; agent finalization moves it to `RuntimeResult.completion`, and the public business output does not require it.
- A replacement plugin provides a contract through the `io.output.contract` of its own runtime (`provides` includes it on its own). Output from other installed plugins cannot satisfy the declaration in its place.
- A consumed contract that has no schema, or a provider that declares a contract but never produces it, causes a loading diagnostic.

#### Where contracts are validated

- The kernel validates a published contract at the boundary where a runtime's final output is produced. A failed result cannot commit domain effects, and it cannot write to `recordAs`.
- For an input in the same turn, the complete output is validated once more before `select` is applied.
- For an input with `scope: committed`, the public contract is validated after the frozen complete export is read. This happens even when `accepts` is not written explicitly.
- A consumer's `accepts` can add more restrictions, but it cannot turn off validation of the public contract.
- `accepts` with `cardinality: one` validates a single business value. With `all`, it validates the array of business values sorted by runtime ID, including the array length and uniqueness constraints. The public contract still validates each provider separately.
- For an input with `required: false`, if `accepts` points to `contract:<id>` and no installed package publishes that contract, the runtime still loads, because the plugin that publishes it is itself optional. In that case, the value that cannot be validated is not injected, and the diagnostic is `accepts-contract-unresolved`. A required input in the same situation still fails to load.

When a contract changes, rebuild the affected development session data and the stored exports.

#### The three parts of a result

The internal `RuntimeResult` keeps three things separate:

| Part         | What it is            | Who reads it                                       |
| ------------ | --------------------- | -------------------------------------------------- |
| `output`     | Business output       | Downstream inputs, contract validation, `recordAs` |
| `effects`    | Explicit side effects | Commit, event followers, pending interactions      |
| `completion` | `done` or `pending`   | Decides whether setup is complete                  |

The output of an `outputKind: story` runtime is normalized as described in [Story output](#story-output) and then published as the narrative.

#### Story output

The kernel owns the shape of a story. It is the same for every `outputKind: story` runtime: agents, functions, and stories that a guard returns early. The current contract is `narrative-engine@2`:

| Field      | Type                                    | Meaning                                                                                                |
| ---------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `segments` | Array of segments, at most 60           | The story text, in order                                                                               |
| `cues`     | `{ scene?, present?, mood? }`, optional | Scene name (≤200 characters), names of the characters present (≤32), mood (≤80 characters)             |
| `yield`    | `user` or `continue`, default `user`    | Hands the turn back to the player after the story; `continue` is reserved for later and acts as `user` |

Each segment is `{ kind, speaker?, text }`:

- `kind` is `narration`, `dialogue` or `action`.
- `speaker` is the name of the character who speaks or acts (≤80 characters). Write a name, never an ID. Narration has no speaker.
- `text` is the segment's text (≤4000 characters). Blank lines inside a segment fold to a single newline, so each segment is exactly one paragraph the player sees.

The kernel derives `narrativeOutput` by joining each segment’s `text` with blank lines. Consumers needing only prose can use `select: /narrativeOutput`. Consumers extracting who spoke, acted, or changed state should use `select: /segments`, reading `kind`, `speaker`, and `text` together; quoted first-person speech does not automatically belong to the player. The public contract validates the full output before `select`, so consumers need no duplicate segment schema. The original player message may be absent from an extractor’s inputs; do not infer commitments from missing text. Requests, attempts, and promises do not establish successful outcomes. Dialogue logs, next-turn history, `turn-digest@1`, and memory still read the joined prose, not JSON.

**Lenient normalization.** Before commit, the kernel tidies the story:

- Prose is still a valid story: each paragraph becomes one `narration` segment.
- An unknown `kind` is read as `narration`. A dialogue without a `speaker` is kept, unattributed.
- The `speaker` of a `narration` segment is dropped.
- A `text` over 4000 characters is split at newlines into several segments. Above 60 segments, neighbours of the same kind and speaker are merged first; trailing segments are dropped only if the story still does not fit.
- A trailing paragraph that lists options for the player ("What do you do?") is removed.
- A story with no text left fails with the "no narrative output" error, including when a PostRuntime hook empties it.

**Repair requests.** A story agent that declares `io.output.schema: contract:narrative-engine@2` sends that schema to the model as the response format. When the answer has problems (a dialogue without a speaker, an unknown `kind`, prose where `segments` were asked for, or an empty `segments` array), the kernel sends one repair request through the existing output repair flow, listing at most five problems. Once the repair budget is spent, the story commits under the lenient rules above.

**Speaker resolution.** At commit, the kernel resolves `speaker` and `cues.present` to characters of the session by name. Only a full character ID, name or alias matches; there is no partial matching.

- A resolved segment gets `speakerId`, and its `speaker` becomes the character's current name.
- A name that matches no character, or more than one, is kept as written and listed in `unresolvedSpeakers` of the `narrative.completed` event (see [protocol](./protocol.md)).
- The story message's metadata records `segments`, `cues`, `yield` and the presence record `presentCharacterIds`: the resolved speakers and the characters in `cues.present`. The presence record is only stored for now, ready for per-character history later.
- Story messages on `/messages` and `/view` carry `segments` (see [API](./api.md)). Character IDs never reach model-facing text.

**Streaming.** When the answer is segmented JSON, the narrative stream forwards only each segment's `text`, with a blank line between segments, matching the committed text. JSON keys, `speaker` and `cues` never appear in the stream. A prose answer streams as before.

#### Function output

The output contract of a function is based on the `value` that the handler returns. It can be a scalar, an array, an object, or `null`.

- The runtime stores the raw business value using `canonicalValue`. An object is projected to `output`. A scalar, an array, or `null` is projected to `{ value }`. When there is no value, the projection is an empty object.
- Fields in the business value named `events`, `pluginData`, `interactions`, or `preGameDone` do not trigger side effects, and they do not complete setup. These intents must be expressed through `HandlerResult.effects` and `HandlerResult.completion`.
- `effects.interactions` and `effects.notifications` must be arrays. Their entries, and `effects.ui[].parts`, must be objects. If a function returns a channel that is not an array, or an entry that is not an object, it fails with `output-schema-invalid`. The same kind of content that arrives by another route is treated at commit time as a rejected write of that runtime (see [Transactions reference](./transactions.md)).
- `effects.statePatches` has been removed; this field is explicitly rejected on a successful result. Failed or skipped handler results strip domain effects and retain their original error or skip reason. Store plugin-owned state in plugin data through `effects.pluginData`.
- The same-turn input, the public contract validation, and the `recordAs` publication all read the same business value.
- When no `value` is given, no export is published. Do not guess `output.value` to unwrap it.
- The `select` of a normal input works on this business value. A committed input reads the complete export, and `select` is not supported there.

#### Agent output

An agent's side effects come only from its tools. What the model can write is decided by the `agent.tools` allowlist.

- The execution boundary puts side effects from tool results (proposals returned by tools, events sent by `emit-event`, forms and UI blocks) into `effects`. It turns `preGameDone: true` or `completion` in the final output into a completion signal.
- The model's final JSON fields `statePatches`, `pluginData`, `notifications`, `assetGenerations`, `interactions`, `ui`, and `events` that carry a `topic` have no effect. This is the same as the fields with these names in a function's business value. These fields are removed during the split, and the server log records a warning with the runtime name and the field name.
- `events` without a `topic` (for example, business events of WorldIR) stay in `output.events`.
- When a tool that ends the run returns its own value as the output, the side-effect fields in that value take effect as usual, because the tool is on the allowlist.
- An agent's public contract value is the business `output` after the split. Normal execution and resume use the same boundary.

#### Hooks that rewrite results, and schema checks

- If `PostRuntime` changes a function's `output`, it should also set a matching `canonicalValue`. The new value is validated again against the private and public schemas.
- Changing only `output` discards the business value. It stops the export and the downstream value bindings. When there is a public output contract, it also fails because the contract value is missing.
- `PostRuntime` cannot add or rewrite `pendingProposals`, `effects`, or `completion`; those channels always come from the runtime's original result. To block or rewrite a proposal, use [`PreStateCommit`](./hooks.md#prestatecommit).
- The side effects of a failed runtime are not committed, and its events do not trigger the runtimes that follow it.
- Normal execution and resume share the output schema check for agents. A non-story agent that declares a private `io.output.schema` first validates the candidate protocol output, and only then splits out the business value and the side effects. A final output with no story text, or with empty story text, is also accepted by the validation. If it does not match the schema, the run fails, and the writes accumulated while it was paused are not committed.
- A story agent does not use the private schema check; it uses the checks and repair of [Story output](#story-output) instead.

> [!NOTE]
> After a change to the internal result structure, rebuild the affected development execution results, exports, background jobs, and snapshots. The old flat side-effect results cannot be read.

#### Turn information in the handler context

| Field                            | Meaning                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.playerMessage`              | The player's input for this turn: the text the kernel renders from `ctx.playerActions`. A single player's ordinary input is the text as written; several characters, a host or a plugin kind name the character and the kind. See [API · How the player message is rendered](./api.md#how-the-player-message-is-rendered)             |
| `ctx.playerActions`              | The player's resolved actions of this turn, in submission order, each `{ seatId, kind, actorId?, text?, fields?, interaction?, source }`. Empty for the opening, a manual run, an event, a detached job, and a nested `ctx.recursiveCall` run                                                                                         |
| `ctx.logicalTurn`                | The scheduler's logical turn: the number of committed main-loop player turns, plus one. It is in the context of function handlers and plugin tools. Setup, the opening continuation, and the first player message are all turn 1. `startTurn` and `every` also count by it.                                                           |
| `turnNumber` in the tool context | The number of player messages recorded in the session, including the form submission during setup                                                                                                                                                                                                                                     |
| `ctx.session.lastPlayerInput`    | The most recent `PlayerInputSubmission \| null` when the source execution starts. It includes `id/sessionId/turnId/formId/values/createdAt`.                                                                                                                                                                                          |
| `ctx.execution.origin`           | Why this execution runs: `player`, `continuation`, `manual`, `background`, `recursive`, or `resume`                                                                                                                                                                                                                                   |
| `ctx.execution.sourceTurnId`     | When a committed turn is retried, the ID of that turn. Use it as a key so a retry reuses the earlier rolls and reveals instead of drawing again                                                                                                                                                                                       |
| `ctx.recursionDepth`             | `0` for a top-level execution, one more for each level of `ctx.recursiveCall`                                                                                                                                                                                                                                                         |
| `ctx.world.seats`                | The session's [seats](./world-model.md#seats), read-only. The character the player plays now is the SDK's `currentCharacterOf(primarySeat(seats), ctx.world.characters, seats)`; `seatCharacterIds` gives the characters bound to one seat. Guards, tools (`context.world`) and extension providers (`ctx.world`) read the same seats |

`ctx.session.lastPlayerInput` may come from an earlier turn. Having this record does not mean that a form was submitted in this turn.

#### Nested calls (`ctx.recursiveCall`)

`ctx.recursiveCall({ playerMessage, manualTrigger: { runtimeId, payload } })` starts a nested run inside the current execution. Its effects commit with the parent's. Only these fields are read; the session, locale, settings and model come from the parent, and other fields are ignored.

The nested call's writes follow the parent handler:

- When the parent handler succeeds, the nested writes commit with the parent's, ahead of the parent's result.
- When the parent handler fails (it throws, times out, or returns `failed` or `skipped`), the nested writes are discarded with it. They are also discarded when a PostRuntime Hook changes the parent result's status (for example, rewrites a failure as a success), just like the parent's own writes. The rule applies at every level: when any parent handler fails, the writes of every level below it are discarded.
- When the parent handler suspends for input, the nested results and their writes are saved with the suspended item. When the resumed handler succeeds, they commit with the parent's writes, ahead of the parent's result, in the same order as without a suspension. When the resume fails, a PostRuntime Hook changes the status, or the item is abandoned, expires or is voided, they are discarded with the parent's writes. A nested call that suspended itself is not saved; the trace records a `recursive.failed` with `code` `nested-suspension-dropped`.
- A nested call made from an agent's guard commits only when the guard returns `{ skip: true }` and the result is still skipped; it is discarded when the guard lets the agent run.

At commit, a top-level runtime and the nested calls at every level below it are one unit: they all commit, or they are all discarded.

- In an execution with a story, the unit of a non-story runtime commits in one savepoint. When any of its writes is rejected, the whole unit is discarded and the story is still saved. Runtimes that depend on that top-level runtime are discarded with it under the [commit rules](./transactions.md#turn-level-single-transaction).
- When the unit holds a run of a story or setup runtime, at top level or nested inside, the unit commits under the story rule: when any of its writes is rejected, the whole execution rolls back.
- When a unit is discarded, the suspensions of its nested calls are void too: they are not saved, cannot be resumed, and do not replace an existing suspension. When the execution leaves no other suspension, the turn ends and counts as usual, and the detached jobs the suspension held back are queued as usual.

`ctx.recursiveCall` returns a copy of the nested result. Changing it does not change what commits or who owns it.

`manualTrigger.runtimeId` may only name a runtime in the caller's own package: the package ID for an inline runtime, or `<pluginId>/<runtimeId>` for a multi-runtime package. A target in another package throws before the nested execution starts. The error names the target runtime and the caller's package ID. Bundled and community plugins follow the same rule.

Use [services](./plugin-extensions.md#registering-and-calling-public-functions) for requests and responses across packages, or [events](./plugin-extensions.md#how-events-trigger-downstream-work) to trigger work in another package.

A `manualTrigger.runtimeId` that names a `schedule.subagentOnly` runtime is an error; use `ctx.agents.run` instead.

#### Sub-agents

A sub-agent is another agent runtime that the caller runs inside its own execution. It has its own transcript and budget and **returns output only**: it makes no writes, emits no events and forms no top-level runtime result, so it is never a commit unit. A function runtime uses `ctx.agents.run`; an agent runtime uses the builtin tool [`delegate`](./tools.md#sub-agents-delegate).

```ts
const result = await ctx.agents?.run({
  target: { contract: "gate-actor@1" }, // or { runtimeId: "my-plugin/guard" }
  brief: "A stranger asks to pass the gate.",
  data: { stranger: "Mara" },
  budget: { maxSteps: 4, timeoutMs: 20000 },
});
// { ok: true, output, stopReason, usage? } or { ok: false, error: { code, message }, stopReason? }
```

<!-- prettier-ignore -->
| Field | Meaning |
| --- | --- |
| `target` | `{ contract }`: the active `subagentOnly` provider whose output contract it is, in any package. `{ runtimeId }`: an active `subagentOnly` runtime of the caller's own package |
| `brief` | The task, the sub-agent's only user message. 1 to 20 000 characters |
| `data` | An optional JSON object, serialized after the brief, at most 32 KB |
| `budget` | Optional `maxSteps` and `timeoutMs`. They can only tighten the provider's own limits, and the time limit never exceeds what the caller has left |

The provider is an agent runtime that names the contract it provides in `io.output.contract` and sets `schedule.subagentOnly: true` (rules under [Triggers](#triggers)). Its prompt is the RUNTIME.md body, as usual.

Rules at run time:

- **Own transcript**: the sub-agent's prompt is the provider's own body, the framework's completion instructions, then the brief. It sees neither the session history nor the caller's conversation.
- **Read-only tools**: tools in the provider's `agent.tools` without the `readOnly` annotation (plugin tools, write tools such as `plugin-data-set`), `suspend` and `delegate` are taken away. A declared plugin tool that is not registered still fails the run as it always does.
- **Loop profile**: without `agent.loop.profile` it runs `actor`: no streaming, no player interjections.
- **Model**: it uses the model role the provider declares. The session's `runtimeModelOverrides` apply by the provider's runtimeId, also in a run resumed after suspension; the caller's override and the request's story model override do not.
- **Caps**: one execution runs at most 8 sub-agents at a time, nested executions included, and a sub-agent cannot call another one (depth cap 1). A call over a cap gets `unavailable` at once; nothing queues.
- **Cancellation**: when the caller is cancelled, times out or ends, the sub-agent stops with it, with `cancelled`. A sub-agent the handler did not await is waited for before the runtime finishes.
- **Output only**: the output is checked against the provider's `io.output.schema` and contract schema; a failure is `internal`. The `PreRuntime`, `PostRuntime` and `PostContextAssembly` hooks do not fire for a sub-agent; the in-loop `PreLLMCall`, `PreStep`, `PreToolUse` and `PostToolUse` fire as usual, with the sub-agent's `ctx.runtimeId`.
- **Trace**: every event of the sub-agent carries `subagentCallId`, `parentCallId` and `parentRuntimeId`, plus `subagent.started` / `completed` / `failed` (see [protocol](./protocol.md#sub-agent-events)). An `io.concealed` provider has its content hidden as a top-level run does.
- **Fault latch**: a sub-agent’s own faults count against its provider. Only the provider’s own tightest time limit (winning ties) counts as its timeout; model errors and cancellations do not count. Faults count even if the parent execution fails or rolls back; clearing requires a committed execution. Calls from setup runtimes neither count nor clear faults. Paused providers return `unavailable` and still count toward ambiguity. See the [protocol fault latch](./protocol.md#plugin-fault-latch).

A failure does not throw (only a call after the handler has ended throws); it returns an error code:

These codes are a subset of the [tool error codes](./tools.md#unified-result-format-and-error-codes).

<!-- prettier-ignore -->
| `error.code` | Meaning |
| --- | --- |
| `invalid-input` | The request is invalid: a missing field, a brief that is too long, `data` that is not JSON or too large |
| `not-found` | No active provider matches `target` |
| `ambiguous` | More than one active provider offers the contract |
| `unavailable` | The depth cap or the execution's concurrency cap is reached, or the provider is paused in this session after repeated faults |
| `timeout` | The sub-agent used up its own time limit |
| `cancelled` | The caller or the player cancelled |
| `internal` | Any other failure: invalid output, a model error, a tool loop. The message is fixed text; the reason is logged on the server only |

`ctx.agents` exists only in a function runtime; an agent's guard has none.

#### The session view (`store.getSession()`)

`ctx.store.getSession()` (`context.store.getSession()` in a tool or an action) returns `PluginSessionView`, a read-only view of the current session, not the session record itself:

| Field                  | Meaning                                                                                                                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase`                | `setup` or `playing`                                                                                                                                                                                           |
| `completedPlayerTurns` | Committed main-loop player turns; setup and the opening do not count                                                                                                                                           |
| `locale`               | The content language of this game                                                                                                                                                                              |
| `setupRuntimes`        | The progress of each setup runtime, keyed by runtime ID: `{ state: "pending", lastError? }`, `{ state: "done", resolution: "completed" \| "waived", warning? }`, or `{ state: "blocked", reason, lastError? }` |

When the session no longer exists, `getSession()` throws and the current execution cannot continue. Normal degradation for missing plugins or optional capabilities does not change this boundary.

#### Random numbers (`ctx.random`)

`ctx.random` is a random source provided by the host. The context of every function handler, agent guard, plugin tool, and RPC action has it, and its type marks it as always present.

- Use `ctx.random.int(min, max)` for dice and any other random draws in the game. It returns an integer with `min <= n < max`. It is the same as `randomInt` from `node:crypto`.
- The SDK's `validateRandomIntRange(min, max)` is shared by the host and `makeRandom`: both bounds must be safe integers, `min < max`, and the range width must be strictly less than `2 ** 48`, otherwise it throws `RangeError`. The argument rules and error messages are identical with or without a seed.
- Do not use `node:crypto` or `Math.random` directly.
- Normally it is just `randomInt`. When the test server is started with `COVEL_RANDOM_SEED`, the nth number drawn by the same runtime (or the same RPC action) is the same on every run. A scripted session can therefore be repeated (see [Environment variables](./env-registry.md#runtime-contract) and [Recording and replay](../ship/real-model.md#recording-and-replay)).
- `shortId` and `shortIdBatch` must get it as their fourth argument. The random part of an ID can then also be repeated. The SDK has no other random source to fall back on.

#### Bookkeeping fields the model cannot see

**Bookkeeping fields in records are not given to the model.** Session IDs, the UUIDs of rows, turns, and results, and write timestamps are of no use to the model. They take up tokens, and copying them back is error-prone. Timestamps also change the prompt every time a row is rewritten. And if the same session is run twice, these values are different each time.

When the kernel writes records into the prompt, it removes these fields:

- Each row of `io.selfData` is `- <key> | <JSON of the value>` (the `summary` format is cut to 200 characters). An `updatedAt` on the row is not included, and an `id` in the value that is the same as the key is not repeated.
- The following are passed through the same projection before they reach the model: the values in `<runtime-inputs>` and `<runtime-exports>`, the payload in `<runtime-activation>`, the fields of `{{ world.schema }}` and `{{ characters.npcs }}`, the player sheet and NPC fields of the SDK's `characterSheetSegments()`, and the `data` field of unified tool results.

A property is removed only when both its name and its value match:

| Property name                   | Value                                 | Result  |
| ------------------------------- | ------------------------------------- | ------- |
| `id`, or ending in `Id` / `Ids` | A UUID, or an array of only UUIDs     | Removed |
| `timestamp`, or ending in `At`  | An ISO time                           | Removed |
| `sessionId`                     | Anything                              | Removed |
| `id`                            | A readable ID such as `"npc-lin-yao"` | Kept    |
| `date`                          | `"1943-06-01T08:00:00Z"`              | Kept    |

When a record's `id` is a UUID and another part of the same value points to that UUID (for example the `from` / `to` of a World IR relation or an event's `participantIds`), the UUID is a reference, not bookkeeping. It is kept everywhere it appears, so the model can match the entity with what points to it. Only references inside the projected value count: `io.selfData` is projected row by row, so a reference from another row does not.

A record repeating its own UUID in its properties, arrays or nested objects without an independent `id` does not count as a reference from another record. A child object with its own `id`, including a semantic short ID, is an independent record; its reference to its parent's UUID counts.

> [!WARNING]
> This check looks only at the name and the shape of the value. It cannot tell story time apart from other times. If a moment in the story is stored as `diedAt: "1943-06-01T08:00:00Z"` (the name ends in `At` or is `timestamp`, and the value is an ISO time), the model cannot see it either, and no error is reported at run time. For story time that the model should see, use a different name (`date`, `diedOn`), or do not write it as an ISO time (for example, `"1943 年 6 月 1 日清晨"`, meaning early morning of June 1, 1943). This applies to data in a world package and to data the plugin stores itself. For such a field in a world package, `pnpm validate:world` gives a `model-hidden-field` warning. Data that a plugin stores while it runs is not checked.

The records that code reads do not change: the return values of `ctx.inputs`, `ctx.activation`, `ctx.pluginData`, and `ctx.tools.call` are all complete.

- When a plugin builds its own prompt (for example, by calling `ctx.gateway` directly), it does the same thing with `modelFacingJson(value)`, which is exported from `@covel/plugin-handlers-utils`.
- When a tool must give the model an opaque handle, put it in the model view summary with `withModelView(content, { summary })`.

#### The kernel input `turn-digest@1`

The kernel input `turn-digest@1` freezes the facts of the source turn. A foreground runtime and a background job read the same value. Its type in the SDK is `PluginTurnDigest`:

| Field               | Meaning                                                                       |
| ------------------- | ----------------------------------------------------------------------------- |
| `turnId`            | The ID of the source turn                                                     |
| `playerMessage`     | The player's input for that turn (the text rendered from the actions)         |
| `actions`           | The player's resolved actions of that turn; empty without player input        |
| `lastPlayerInput`   | The same snapshot as `ctx.session.lastPlayerInput`, or `null`                 |
| `narrativeText`     | The story text of the turn's successful story runtimes, joined by blank lines |
| `toolCallSummaries` | One short line per successful, visible tool call                              |
| `runtimeResults`    | The runtimes that finished: `{ runtimeId, status }`                           |
| `locale`            | The content language of this game (only sometimes present)                    |

- `runtimeResults` holds the final states already observed, as `{runtimeId, status}`. `status` is `success`, `failed`, `skipped`, or `suspended`. A runtime that has not finished is not predicted to succeed.
- A background (detached) worker reads the snapshot of the source execution. It does not query the latest form or turn state again.
- After this input contract is updated, old jobs and snapshots must be rebuilt. There is no compatible read path.

## Advanced fields

No bundled plugin uses the fields below, and a first plugin does not need them. They are there for community plugins with special needs. The type and values of each field are in the [manifest field tables](./schema/plugin-manifest.md) and the [runtime field tables](./schema/runtime-manifest.md).

<!-- prettier-ignore -->
| Field | Use |
| --- | --- |
| `covel` | The range of host versions the package works with, such as `">=0.0.45"`. A host outside that range does not install or load the package. |
| `homepage`, `author.about`, `author.links` | The package's page, a note to players, and labelled links. See [Author information](#author-information). |
| `contributes.wires` | IDs of provider wires registered with `registerWires` |
| `contributes.events[].advertise` | `false` hides the event from the model that writes the story; only the UI and code use it |
| `contributes.prompt[].position: {depth: N}` | Inserts the static section into the history by message depth. See [Prompt structure](./prompt-structure.md). |
| `contributes.commands[].context` | Host information a command passes to its action: `session`, `active-runtimes`, `models` |
| `contributes.commands[].arguments[].variadic`, `choices` | `variadic: true` collects the remaining words into the last argument; `choices` lists the values an argument may take |
| The `text`, `textarea`, `integer`, `slider` and `slot` values of `contributes.settings[].type` | A one-line text box, a multi-line text box, a whole number, a slider, and a choice of model role |
| `agent.loop.maxSteps` | The most tool-call steps. A runtime that calls one tool and stops can set 1 or 2. |
| `agent.loop.firstTokenTimeoutMs`, `idleTimeoutMs` | The wait limits of a streaming call. See [Wait limits of a streaming call](#wait-limits-of-a-streaming-call). |
| `agent.loop.loopDetection` | How many identical calls in a row count as a loop. The default is 3; `0` turns the check off. |
| `agent.loop.maxRecursionDepth` | How deep `ctx.recursiveCall()` may nest. The default is 10. |
| `agent.loop.profile`, `stream`, `steering`, `truncation`, `fallback`, `finalizer`, `corrections` | How the loop behaves; see [Loop profile](#loop-profile-agentloopprofile) |

### Wait limits of a streaming call

- `firstTokenTimeoutMs`: the longest it waits before the first output.
- `idleTimeoutMs`: the longest silence allowed between two outputs. The default is 120 seconds.
- A model that keeps producing output is not cut off, and the time spent producing output does not count toward `timeoutMs`.

How long to wait for the first output:

- If you set `firstTokenTimeoutMs`: every attempt waits this long.
- If you do not set it: one attempt waits at most 120 seconds, and time is left for the retries that `maxRetries` still allows. The last attempt can use all of the remaining `timeoutMs`. Earlier attempts wait "remaining time ÷ remaining attempts". If that value is under 60 seconds, the wait is 60 seconds, but never more than half the remaining time.

| `timeoutMs` | `maxRetries` | Maximum wait for each attempt |
| ----------- | ------------ | ----------------------------- |
| 120 s       | 3            | 60, 30, 15, 15 s              |
| 240 s       | 1            | 120, 120 s                    |

So when a provider accepts the request but never produces any text, there is still time to send the retries. A model that is slow to give its first output (a reasoning model that does not stream its reasoning) should set `firstTokenTimeoutMs` explicitly, and set `timeoutMs` large enough.

### Loop profile (`agent.loop.profile`)

A profile decides how an agent loop runs: whether its text is shown to the player as it is written, whether it reads the player's interjections, whether a reply cut off at the output limit is kept, what happens when the model keeps calling the same tool, and when the tools are turned off to ask for a final answer. Without one, the profile follows `io.visibility`: `story` for a story runtime, `system` for any other. Both bundled narrative runtimes get theirs this way, with nothing written in their manifests.

When only one thing differs from the profile, write only that key; the rest keep the profile's values:

<!-- prettier-ignore -->
| Field | Effect |
| --- | --- |
| `profile` | `story`, `actor` or `system`; the other keys override it |
| `stream` | Show the model's text to the player as it is written |
| `steering` | Merge the player's queued interjections into the conversation before each step and after the story text is written |
| `truncation` | `accept`: story text cut off at the output limit is kept; `reject`: it fails |
| `fallback` | When the model keeps calling the same tool: `answer-without-tools` turns the tools off and asks for the answer; `fail` fails with `loop-detected` |
| `finalizer.maxSteps` | At the step limit, turn the tools off and ask once more for the final answer. With `false` the step limit always fails |
| `finalizer.deadlineReserveMs` | With this many milliseconds left before the time limit, start no new step and ask for the final answer with tools off. `0` turns it off |
| `corrections.toolUse` | Corrections for missing required tool work or explicit completion. Integer 0–3, default 1 |
| `corrections.review` | Corrections after `PostLLMResponse` rejects a draft. Integer 0–5, default 2 |
| `corrections.loopPerturbation` | Perturbations of a repeated tool loop before `fallback`. Integer 0–3, default 1 |
| `corrections.outputRepair` | Requests with tools off for a complete replacement of invalid output. Integer 0–3, default 1 |

The values of the three profiles:

<!-- prettier-ignore -->
| Field | `story` | `actor` | `system` |
| --- | --- | --- | --- |
| `stream` | `true` | `false` | `false` |
| `steering` | `true` | `false` | `false` |
| `truncation` | `accept` | `reject` | `reject` |
| `fallback` | `answer-without-tools` | `answer-without-tools` | `fail` |
| `finalizer.maxSteps` | `true` | `true` | `true` |
| `finalizer.deadlineReserveMs` | `0` | `0` | `0` |
| `corrections` | `{ toolUse: 1, review: 2, loopPerturbation: 1, outputRepair: 1 }` | `{ toolUse: 1, review: 2, loopPerturbation: 1, outputRepair: 1 }` | `{ toolUse: 1, review: 2, loopPerturbation: 1, outputRepair: 1 }` |

`actor` is for an agent that only answers a brief and writes no story text. A [sub-agent](#sub-agents) that names no profile uses it.

Loading checks these rules and rejects a manifest that breaks one:

- `profile: story` requires `io.visibility: story`.
- A `stream` or `steering` that ends up `true` requires `io.visibility: story`: only a story writes the narrative feed and reads the player's interjections.
- A `truncation` that ends up `accept` requires a `stream` that ends up `true`: only text the player read as it was written is kept. A story that writes `stream: false` therefore also writes `truncation: reject`.
- `finalizer.deadlineReserveMs` is a non-negative integer smaller than `timeoutMs` (compared with the default time limit when `timeoutMs` is not written).

**Finishing before the time limit (`deadlineReserveMs`).** When less time than this is left, and text alone could complete the runtime at that moment (no unmet `requireToolUse` or explicit completion, and no output handed over by a completing tool) and at least 3 seconds remain to write it, the loop starts no new step and asks for the final answer with tools off. With `steering` on, player interjections queued during the last step are merged first, so that request reads them. When the answer is written, the runtime succeeds with stop reason `deadline` and `finalizer: true`. When it is not, the runtime still fails with a timeout. The reserve used is at most half of `timeoutMs`, and the time left is measured against the deadline as queue and streaming time have moved it. When the conditions do not hold, the loop runs to the real time limit as usual.

**Correction budgets and output repair.** The four budgets in `agent.loop.corrections` are independent; `0` disables that correction. Write only keys you want to override. A bare text finish and a `runtime-done` without business work share the `toolUse` budget. After the loop and any finalizer, output that fails its schema or a story with empty text gets one request with tools off by default, including the validation errors and asking for a complete replacement answer. If it is still invalid, the runtime fails with `invalid-output`. The repair replaces earlier drafts and story text from before interjections. It runs only after a success-shaped exit, with required tool work and completion met, output not handed over by a completing tool, and at least 3 seconds left. Errors, cancellation and an expired deadline get no repair. Each request consumes one `outputRepair` unit. Each new loop starts fresh budgets; a resumed execution is not a new loop and keeps counting from what it spent before the suspension.

### Author information

Plugins, worlds (`world.yaml`), and collections (`covel-collection.yaml`) use the same optional fields to say who made them and where to find them. These fields are for display only. The host makes no decisions based on them, and their text never goes into a prompt.

```yaml
version: 1.2.0
author:
  name: Jane Doe
  url: https://example.com
  about: I write small mystery worlds. A new one comes out every month.
  links:
    - label: Community
      url: https://example.com/community
    - label: Support my work
      url: https://example.com/support
license: CC-BY-4.0
homepage: https://example.com/tidefall
```

| Field          | Description                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `author.name`  | The author or team name, up to 80 characters. It is shown as written in every language and is not translated.                          |
| `author.url`   | The author's own page                                                                                                                  |
| `author.about` | A short note the author writes for players: who they are, their other work, and how to support them. Plain text, up to 500 characters. |
| `author.links` | Links with labels, up to 6 of them. Each `label` is up to 40 characters.                                                               |
| `license`      | The license: an SPDX identifier or a short name, up to 64 characters                                                                   |
| `homepage`     | The package's own page, such as its repository or documentation                                                                        |

- **Links must use `https`.** They cannot contain a user name or password. Addresses such as `http:`, `javascript:`, and `file:` are rejected when the manifest is validated. The host does not review these links, because they are third-party addresses the author provides. Before a player opens any of them, the interface shows the full address and the domain and says so. The link opens in the browser only after the player confirms. Domains are displayed in ASCII form. A look-alike domain written with other characters is shown as `xn--…`.
- **Where they appear:** the world list (author · version), the world details, the world cards and plugin rows on the session-prep screen, and the installed plugins in Settings. The install preview shows only the author name, not the links. The screens used during play do not show these fields.
- **Translation:** a plugin translates `author.about` and the `label` of each `author.links` entry in the `PLUGIN.md` section of `locales/<locale>.yaml`. Links are matched by position. A world translates the same two items in `world.<locale>.yaml`. Author names and licenses are not translated, and `pnpm i18n` does not count them as text to translate.
- **Version number:** the list shows the `version` from the manifest. The version is written only in `PLUGIN.md`: the host, the install preview and the update check all read it, and a `version` in `package.json` is not read. A change to `version` makes existing sessions run the plugin's setup runtimes again, so the setup guard or handler must return a skip for work that is already done.

## World Model and data boundaries

The character schema, the characters, and the world record belong to the kernel's World Model. A plugin reads them only, and it writes to them through proposals.

- `ctx.world.characterSchema`, `ctx.world.characters`, and `ctx.world.worldRecord` are read-only views. The objects you get back are frozen (`Object.freeze`, and nested objects too). Changing one throws a `TypeError`. To sort or change them, first make your own copy (`[...ctx.world.characters]`, or `structuredClone`).
- Until this execution buffers new writes, repeated reads return the same object. A loop that looks up characters one by one does not copy the whole list each time.
- Legal upstream proposals in these domains, and the proposals this runtime has already buffered, are visible to later reads.
- Writes go through proposals, and they are validated together at commit time.
- `ctx.world.dimensions` starts from the provider's frozen snapshot and overlays the valid dimension proposals visible to that view. See [Dynamic dimensions](#dynamic-dimensions) for the distinction between public reads and execution-local previews.
- `ctx.world.seats` holds the session's seats, frozen as well. No proposal changes them; the player switches the current character through the [switch endpoint](./api.md#session-seats), and it applies from the next turn.

**Finding a character by name.** Besides `name`, a character can have `aliases` (other names for the same person).

- To match a name the model wrote to a character, use the SDK's `resolveCharacter(ctx.world.characters, name)`. Do not compare strings yourself. It matches by ID, then by name, then by alias, in that order. When the name is ambiguous or does not exist, it returns `ambiguous` or `missing` (with the closest characters).
- When a plugin saves its own records by name (affinity, relationship nodes, codex entries), it first resolves the character, and it uses that character's `name` as the key. That way, two names for the same person do not become two records.
- `characterNameKey` gives the normalized form used for comparison, and `mergeCharacterAliases` merges alias lists.
- To find which characters a piece of text mentions (for character selection or retrieval), use `mentionedCharacterIds(text, characters)`. Text split into words by spaces needs word boundaries (`Rin` is not found in `spring`). A match that is covered by a longer name of another character does not count (`会长` is not found in `副会长`).

The rules are in [Aliases and name resolution](./world-model.md#aliases-and-name-resolution).

**Character types and schema.**

- A character type is an open string declared in the schema. `player` is a reserved type, and a session can have several. To find the character the player plays now, use `currentCharacterOf` (see [seats](./world-model.md#seats)), not `find(type === "player")`.
- Character fields follow the attributes of the CharacterSchema.
- The proposal that changes the schema is `character.schema.set`. Its payload contains `types` and `attributes` directly. The kernel increments the version.

**The plugin's own data.**

- Persistent data owned by a plugin is accessed through the bound `ctx.store.getPluginData(namespace, key)` and `listPluginData(namespace)`. What it reads includes writes of this execution that are not committed yet; the rules are under [In-execution plugin-data visibility](#in-execution-plugin-data-visibility) below.
- A plugin cannot specify an arbitrary sessionId or pluginId to read another plugin's private data.
- To share data publicly across plugins, use a contract, a service, or an extension. Do not scan the other plugin's namespace.

**Lorebook.** A lorebook entry's identity has two parts, the owner and the ID. The owner is `world`, `plugin`, or `player`. The player editing path over HTTP manages only entries whose owner is `player`. Do not use a character ID, a plugin ID, or an arbitrary namespace to imitate ownership of the character table or the lorebook.

### In-execution plugin-data visibility

Writes made during an execution commit when it ends. Until then, a plugin that reads its own data reads "the committed value plus the writes this execution will commit":

- The writes this runtime has already buffered.
- The writes of completed upstream runtimes of the same plugin: a successful result, or a guard that skipped its agent and left writes. They apply in commit order: upstream first, then the runtime's own; the results of a nested call before their parent; within one result, `effects.pluginData` first, then buffered writes. `plugin.data.update` operations are computed in the same order and give the value the commit stores.

`ctx.pluginData.get/list`, `ctx.store.getPluginData/listPluginData`, `context.store` in tools (agent tools and `ctx.tools.call`) and the builtin `plugin-data-get/list` all read this way. The early check of `ctx.pluginData.update` uses the same view.

These writes are not visible:

- Other plugins' writes. A plugin reads only its own data.
- Siblings of the same level. The visible writes are taken when the runtime starts, so runtimes running in parallel in one level do not see each other.
- Failed results, and the writes of a guard that let its agent run (they never commit).
- The previous turn's results that a manual retry brings, and the upstream results a background job brings. Their source execution already committed or dropped those writes; applying them again would count an operation such as `inc` twice.
- A parent execution's upstream inside a nested execution. An execution started by `ctx.recursiveCall` sees only the upstream of that nested execution.

Upstream writes are only read. They never enter the reader's own buffer, so nothing is committed twice.

> [!IMPORTANT]
> This changes the earlier read contract: each runtime used to see only committed values and its own buffer. Now a later runtime of the same plugin reads what earlier runtimes wrote in this execution, without passing it on through an input binding or an event.

**Read dependencies.** A runtime that read an upstream write depends on it. When that write is dropped at commit (for example, the commit refused its proposal), an auxiliary runtime that read it is dropped too, with the error `read data of <upstream runtime> that did not commit`. The drop carries on to its hard dependents and to the runtimes that read its writes. A story or setup runtime is never dropped for this: it commits as usual, and the trace records a `read-dependency.kept` row. Dependencies are recorded per read:

- `get` depends only on the upstream writes that still shape the returned value. When the runtime first wrote the whole key itself (`set` or a delete) and then read it, it depends on no upstream.
- `list` depends on every upstream runtime that wrote any key in that namespace; a list without a namespace depends on every upstream that wrote plugin data.

The commit rules are under [Turn-level single transaction](./transactions.md#turn-level-single-transaction).

### Dynamic dimensions

`world.dimensions@1` publishes `{id: {name, description?, schema, value, version}}`.

- To read the current value, a plugin uses `ctx.world.dimensions.<id>.value`.
- Do not take the current value from `worldRecord.dimensions` or `metadata.dimensions`. Those hold the author's definition and the initial values.
- Do not scan another plugin's `_dimensions`.

The built-in `world-init` has four runtimes related to dimensions. `dimension-clock` runs after time settlement and `dimension-tracker`.

| Runtime             | Stage              | Responsibility                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dimension-context` | pre-turn function  | Calls no model. Reads the committed values and publishes `world.dimensions@1`.                                                                                                                                                                                                                                                                               |
| `dimension-tracker` | post-turn agent    | Must be bound to this turn's narrative, and it maintains the dimensions by the author's rules. WorldIR is an optional supporting input. The world clock after this turn's settlement (`world-time-evolution@1`) is an optional input. `finishWith: update-dimensions`. When nothing changed, it still settles by calling `update-dimensions({updates: []})`. |
| `dimension-clock`   | post-turn function | Calls no model. Using the world clock after this turn's settlement (`world-time-evolution@1`, an optional input), it computes the fields with `x-derive` in the schema. When a value changes, it commits `dimension.update`.                                                                                                                                 |
| `edit-dimensions`   | manual function    | The player changes a value, confirms a manual handling, or explicitly skips it.                                                                                                                                                                                                                                                                              |

**Reading.**

- `world.dimensions@1` and `session.world-context@1` expose the public snapshot frozen at the start of the execution.
- A function handler or guard's `ctx.world` overlays completed upstream and its own valid domain proposals on that base for later calculations. For example, clock-derived fields can see this turn's dimension maintenance. This is an execution-local preview, not committed state, and it does not replace the public snapshot.
- The built-in tools `world-dimension-get` and `world-dimension-list` always read the frozen snapshot. They do not add the caller's own writes, and they do not fall back to the initial values.
- In a template, read a value with `{{ world.dimensions.<id>.value }}`. The default prompt section is a projection within the budget, not the full record.

**Writing.**

- Use the domain proposals `dimension.initialize` and `dimension.update`. Only a trusted owner can write. An update carries `expectedVersion`, and the whole batch is compared by version (CAS).
- A plain `plugin.data` write, a batch, a delete, or a store write from an action RPC cannot touch `_dimensions` or `_dimension-settlements`.
- The framework gets the source of the maintenance tool and the set of versions it reads. The model only submits the new values.
- Even when nothing changed, call `update-dimensions({updates: []})`. Do not infer that settlement happened just because the runtime succeeded.

**After a settlement fails.**

- When automatic maintenance fails or there is no runtime to run it, keep a `pending-settlement` receipt. It must be resolved before the next narrative step.
- Before the next player action starts, the host automatically retries once. Only if it still fails does it block and prompt the player.
- The metadata for recovery is provided by `session.world-context@1` and verified by the host. The editor is a manual runtime RPC. A retry calls the tracker directly and passes `retryFromTurnId`.
- An ordinary manual edit does not automatically settle the obligation of the source turn. A receipt that has already been finalized is not recalculated again.

For the full state and interfaces, see [World Model](./world-model.md#turn-timing-and-settlement-receipts) and [API](./api.md#dimension-editing-and-recovery-of-pending-settlements).

> [!IMPORTANT]
> **BREAKING CHANGE**: The old raw dimension format with nine categories, and the old copy reads, have been removed. World authors use the [unified definition](./world-data.md#dynamic-world-dimensions-dimensions). Development worlds, sessions, and snapshots must be rebuilt. Dimensions do not provide a trigger layer for hidden events, and they do not change who is responsible for characters, inventory, affinity, or time.

### World data import

```yaml
contributes:
  data:
    facts:
      schema: ./schemas/facts.schema.json
      accepts: [example.facts@1]
```

When a namespace accepts a contract, that shows what the contract's records look like. So its `schema` is the public schema of that contract, and you do not need to write it again in the root `contracts`. There are only two cases where you write `contracts.<id>`:

- The contract is not a data contract (for example, a runtime's output contract).
- Two namespaces accept the same contract with different schemas. In that case you must say which one is the public one.

A namespace that receives world data can also declare `authoring` (`title`, `summary`, `hint`, `example`, `source` or `characterField`, `references`, `generate`). It tells world authors how to provide this content, and whether the in-app generator can generate it.

If reading an example or preparing a generatable contract schema fails during a request, only that contract is skipped, with its plugin, namespace, and reason reported. The plugin remains enabled and other content can still be generated. `pnpm describe:authoring --check` continues to report broken examples to authors.

- Only a namespace that lists `accepts` can declare it.
- `source` is the convention path in a world package for this content (`kind`, `path`, `key`). A world author who puts the file there has it imported without writing a descriptor. The last segment of `path` can be `*.<extension>` (for example `data/rules/*.yaml`): each such file in the folder is a source, imported in file-name order. The rules are in [import by convention](./world-data.md#import-by-convention).
- `characterField` replaces `source`: the content is written in each record of the world's character file, under the field it names (for example `blueprint`). The kernel gives it to the receiving plugin, keyed by the character's `id`. See [one character file per world](./world-data.md#one-character-file-per-world).
- `pnpm describe:authoring` summarizes the declarations of all scanned plugins. Adding `--check` validates each `example` against its namespace's schema.
- For the fields, see the [Plugin manifest field table](./schema/plugin-manifest.md).

Some values in a record name something else in the world: the `id` of a character attribute, or the ID of a dimension. Declare them with `references`, and `pnpm validate:world` checks those values before a session starts:

```yaml
authoring:
  references:
    - path: attributes[].id
      to: character-attribute
      type: number
      within: [base, max]
```

- `path`: where the value is in each record. Field names are joined by `.`, with `[]` after a field that holds a list. `**.` before a field name finds that field at any depth below.
- `to`: what the value names. `character-attribute` is the `id` of a top-level attribute of the world's `characterSchema`; `world-dimension` is the ID of a dimension the world declares.
- `type` (optional, only for `character-attribute`): the named attribute must have this type.
- `within` (optional): fields beside the value that must lie inside what it names. For `character-attribute`, number fields that must lie inside the `min` and `max` of that attribute. For `world-dimension`, a path into the dimension's value (`a.b`, or a list of keys); the dimension's `schema` must allow that place.
- `values` (optional, only for `world-dimension`): paths to candidate values, read from the object holding the dimension ID, using the same syntax as `path`. For example, `equals` checks the whole value; `in[]` checks each list member. With `values`, `within` can name at most one field: candidates are checked against the schema at that path, or against the whole dimension when the field is absent or its path is empty. Checks include types, enums and the schema's other constraints. Missing candidate fields, indeterminate schema paths and unsupported schemas do not produce candidate-value errors.

The bundled story-events declares the dimensions in its event conditions like this. A condition can nest `all` / `any` / `not` to any depth, so the path uses `**`:

```yaml
references:
  - path: when.**.dimension
    to: world-dimension
    within: [path]
    values: [equals, notEquals, "in[]"]
```

`pnpm validate:world`, session import, preflight and sync all use this declaration. The framework reads only declared fields; it does not recognize condition operator names. Numeric comparison thresholds need not be possible dimension values, so do not declare thresholds such as `gte` as `values`.

A value that does not fit is reported as an `attribute-reference` or `dimension-reference` error. Attributes are not checked in a world without a `characterSchema`, and dimensions are not checked in a world that declares none, because they are only generated when a session starts. Declare only what the plugin really cannot find or refuses at run time. Otherwise a valid world is reported by mistake.

A world data source writes `to: contract:example.facts@1`. If you leave out `schema`, the schema of the target contract is used. The framework finds the active namespaces that declare that they accept this contract, validates the schema, and then delivers the data to them. The framework does not recognize any specific plugin ID. The `contracts` and the schema of the receiving namespace must match. For the full structure, see [World Data](./world-data.md).

A world data source can declare `localeArrayKeys` (for example, `[label]`) in addition to `key`. It is an extra identity field. After the source's `key` and `id`, it is used to match nested object lists with language files that contain only translated text. Each key used for matching must be kept in the language file. See [World Data](./world-data.md#language-files-namelocaleext).

### Searchable data

```yaml
contributes:
  data:
    facts:
      schema: ./schemas/facts.schema.json
      search:
        text: text
```

After a namespace declares `search`, its records enter the framework's memory retrieval (in the archival scope of [`memory-search`](./tools.md)).

- A result's `source` is `archival:plugin_data`, and it includes the `pluginId`, the `namespace`, and the record's key.
- `search.text` is the name of the field in the record value that holds the text to search. A record whose field is not a non-empty string is not searched.
- The framework reads these records only when the plugin is enabled in the current session. A namespace that is not declared is not read by the framework.
- When an embedding model is configured, these records are written to the vector index together with the lorebook and character records. The plugin does not need to do anything extra.

**Ranking inside your plugin's code.** The framework does the retrieval, and the plugin decides only what to record. To rank a batch of texts in your own code (for example, to pick the records related to the player's input inside `prompt.segment@1`), use the SDK's `rankTexts(query, texts, { limit, minCoverage })`. It uses the same BM25 implementation as the framework's retrieval, and it does not call a model.

- `coverage` (0 to 1) shows how much of the query the text answers. You can use it to drop results that only match common words.
- `matched` is the number of query terms that the text contains. Dividing it by `searchTerms(query).length` gives the share of the query that this text covers. When a long query shares only one everyday word with the text, this share is small.
- `searchTerms` and `searchExcerpt` are the matching tokenizer and excerpt functions.

**Hidden data.** When a world package declares a source as `visibility: hidden`, the same data is imported into `_hidden.<namespace>` of the receiving plugin (for example, `_hidden.facts`).

- A plugin runtime reads it through `ctx.pluginData.list("_hidden.facts")`.
- Extension points, model tools, `io.selfData`, and the public API cannot read it.
- Revealing it should happen through this turn's runtime output. See [World Data · Hidden data](./world-data.md#hidden-data-visibility-hidden) for details.
- The plugin's own code (`ctx.pluginData.set` / `ctx.pluginData.update` in a function runtime, and `plugin.data` / `plugin.data.update` proposals produced by the plugin's local tools) can also write to its own `_hidden.<namespace>`. This is used to append hidden content during the story. A write always belongs to the plugin that issued the proposal, so it cannot reach another plugin's hidden data.
- The REST interface and the built-in `plugin-data-set` and `plugin-data-set-batch` tools cannot write to any namespace that starts with `_`.

## Prompt and memory extensions

- **Static sections** go in `contributes.prompt`. Each item has `id`, `content`, and `position`, and it may have `role`. The position is `system`, `pre-history`, `post-history`, or `{depth: number}`. The host registers static sections automatically, so you do not need to declare an extension for them. `static-prompt` is a reserved registration ID.
- **Dynamic content** uses extension points. A dynamic prompt uses `prompt.segment@1`, world context uses `session.world-context@1`, history transforms use `prompt.history-transform@1`, and history compression uses `history.compact@2`. See [Plugin extension points](./plugin-extensions.md) for details. These extensions use the snapshot of the same execution, and they do not reread the manifest on each call.
- **Memory blocks** belong to the memory plugin. The default definitions are provided through the `memory.block-definitions@1` service. World-defined custom definitions are imported through the `memory.blocks@1` data contract. The framework does not combine `memoryBlocks` or `summaryFocus` fields, and there is no separate working_memory table.

## Session plugin selection

`resolveSessionPlugins` decides which plugins are enabled in each session. It reads four things: the plugins the player explicitly asks for (`requested`), the ones the player explicitly excludes (`excluded`), the authorization state, and the contract declarations in each plugin's root manifest. The result is `active`, `autoAdded`, and `rejected`.

- An explicit exclusion wins. An excluded core plugin is not restored either.
- When a provider is activated explicitly, the default provider steps aside.
- A required contract automatically brings in a provider. When a contract is missing, ambiguous, in conflict, or not authorized enough, the result gives the reason.
- An event topic has only one declarer in a session. When two active plugins both declare the same topic in `contributes.events`, the one accepted second is rejected with `event-topic-conflict`. The reason names the topic and the two plugin IDs. Explicit requests come before automatic dependencies, and the rest follow request order. A topic is a name that is global to the session. The sender and the subscribers often belong to other plugins, so a topic can match only one payload schema. Two plugins can be installed at the same time, but they cannot both be in the same session. To avoid name clashes, add a prefix tied to your plugin to your own topics.
- A plugin that loses its required provider, and an automatic dependency that nothing needs anymore, are removed. Such a rejection has the `code` `missing-provider` or `ambiguous-provider`, and `contract` names the contract it waits for.
- When a plugin that others depend on is missing, the plugins that depend on it are turned off automatically, and the game still starts. When a session is created, or a plugin is turned on or off, the requested plugins (`requested`) and the `kind: core` plugins turned off this way are still written into `activePlugins`. They do not run for now, they are listed in `unavailable`, and they come back on their own once the dependency is back. Creation returns `400 plugin_rejected` only when a plugin the player asked for is rejected for another reason, such as a conflict; the message names the plugin and the reason.
- Before the game starts, the session prep screen lists the plugins this will turn off, the contract each one lacks, and the installed plugins that provide it, with a button to turn one on. The game screen does the same for `unavailable`.
- When none of the enabled plugins has a narrative runtime (`io.visibility: story`), turns do not tell a story. The session prep screen and the game screen both say so and list the narrative plugins that can be turned on. When none is installed, they point to Settings → Install & manage.
- `requested` and the computed `active` set are stored separately. An automatic dependency does not become the player's explicit choice.
- The world's `pluginPolicy.requires` is passed in as `requiredContracts`. A world is a dependent, just like a plugin. A single provider is added automatically, and it is not removed as an unneeded dependency. A need that cannot be met is returned in `unmet`, with the reason `missing-provider`, `ambiguous-provider`, `approval-required`, or `excluded`. None of the four blocks session creation: the session starts without this part, and the session-prep screen and the response that creates the session (`unmetRequirements`) tell the player what is missing. The first two are an install problem. The last two are the player's choice.

**How a world and a gameplay pack give the initial request.**

- A world's `pluginPolicy` picks a built-in pack with `preset` and adds the plugins it wants with `plus`; see [plugin selection](./world-data.md#plugin-selection-pluginpolicy). A gameplay pack uses `requested` and `recommended`. The initial explicit requests are the `preset` pack's `requested` plus `plus`.
- A built-in gameplay pack (`packs/builtin.yaml`) can also have `defaultViewMode` (`stage`, `parsed` or `plugin:<pluginId>:<viewId>`; bridge views request player consent first). When a world is created with AI for this pack, the generated world gets this `defaultViewMode`. The framework makes no decision by pack ID: the choices of AI world creation are all the packs of this catalogue; see `packs` in [`GET /api/framework/authoring`](./api.md#get-apiframeworkauthoring).
- A recommendation is not enabled automatically, and it does not override the player's explicit exclusion.
- `defaultPluginIds` from `GET /api/worlds/:id/plugin-plan` is the initial set of explicit requests. The session-prep screen and the create endpoint then use the same resolver to compute the active set.
- Each `requested` list and `defaultPluginIds` returned by this endpoint contains only installed plugins. A plugin that a world or pack requests but that is not installed is listed in `missing`. The session-prep screen shows it as a notice, and it is not sent in the create request.

**Switching the gameplay pack on the session-prep screen.**

- Switching packs does not change the view mode. A pack's `defaultViewMode` is written into the world only during AI world generation.
- Switching replaces the requests that the previous pack contributed, including the pack the world selected at the start.
- A plugin in the initial default requests that the initial pack requests belongs to that pack. After a switch, it is kept only if the new pack also requests it. This lets the new pack's narrative engine replace the old pack's engine.
- The world's `plus` and the requests the player added by hand are kept. An explicit exclusion still wins.
- A manual change clears the highlight on the pack card. The source of the old pack is still remembered, though, so the next switch does not add the old pack's plugins back. A plugin in a pack that the player re-enables by hand is kept as a manual choice.
- The resolver still checks the world's `requires` on its own. Do not treat `plus` as a required item that cannot be canceled.
- A gameplay pack can have `excluded`: choosing the pack turns those plugins off, `kind: core` ones included, and the player can turn them back on. Switching to the next pack lifts only the exclusions the previous pack added; the player's own exclusions stay. The exclusions of the pack the world selects at the start apply from the beginning. A plugin that is not installed does not appear in `excluded`.
- The "Back to the minimal set" button keeps only the narrative plugins (the selected ones, or the core ones when none is selected) and the plugins that these and the world's `requires` pull in. It adds no extra requirement for a `world.dimensions@1` provider. Every other core plugin and every plugin in the world's `plus` is excluded, and the pack highlight is cleared.

**A save keeps the set the player confirmed.**

- When a session is created, or a plugin is enabled or disabled, the result of the resolution is written to the session's `activePlugins`. This is the set the player confirmed.
- The plugin list, the slash commands and the executor all read it through one function, `resolveConfirmedSessionPlugins`. It starts from `activePlugins`, checks it against the installed versions, and adds no plugin. A plugin installed later, a `kind: core` one included, does not join an old save on its own.
- A plugin that is not installed, failed to load, lacks a required provider in its installed version, or conflicts with an earlier member sits out for now. The reasons are listed in `unavailable` of `GET /api/sessions/:id/plugins`, and the game screen shows a notice. The other plugins run as usual. `activePlugins` is not rewritten, so the plugin comes back when it is available again.
- Sitting out means it is off everywhere: its runtimes do not load, its hooks do not fire, its services, actions and form validators refuse calls, its panels do not show, and memory search does not read its data. A direct call to one of its actions returns `404 plugin_not_active`, and the error message gives the reason.
- Approval does not change this set. A community plugin's code does not run until it is approved; the trust gate checks that per session.
- To recompute the set from the installed plugins, enable or disable a plugin. Both operations resolve `requested` and `excluded` again and write the result back to `activePlugins`.

**Discovery and authorization.** The data returned by the plugin discovery API separates `kind`, the host's `hostState`, and the session's `sessionState`. The runtime provides `outputContract`. A community plugin that is not authorized can stay in the request list, but its code does not run until it is approved. An approval is bound to the session identity and to its approval scope.

## Localization and validation

### What the static check looks at

The directory-level command `pnpm validate:plugin <dir>` and the ZIP install share the same static file and runtime checks:

- The referenced entry, handler, guard, JSON Schema, and UI files must be inside the package.
- Each JSON UI spec declares one of `view` and `webview`. Component names in `view` must be in the [component catalogue](./ui-components.md). `repeat.statePath` and `$item` must have a legal form (see [UI panels](./ui-panels.md#json-render-binding-cheat-sheet)). The error gives the spec file and the path of the node.
- The built-in tool names and the plugin tool declarations, the runtime references inside the package, and the root contract dependencies must all be consistent.
- A `contributes.actionKinds` `name` must not be a base action kind or repeat; its `schema` file must be in the package and be a JSON object.
- Each `contributes.datasets` schema file must be in the package and valid JSON. `key` must be a required property in the schema's top-level `properties` (skipped when the schema has none). A name that is also in `contributes.data` must use the same schema in both.
- An error from a cross-field rule (for example, `schedule.detached` is only allowed on `post-turn` or `audit`, or a story runtime's contract input must set `required: false`) gives the file path and the field path you wrote, for example `runtimes/note/RUNTIME.md: schedule.stage: …`.

Loading, `pnpm validate:plugin` and installation use one copy of the manifest rules (the schemas in `@covel/shared`), and the same holds for UI specs: a panel that passes the check is not dropped in the game for its format.

Some errors stop one runtime from ever running and leave the rest of the package unaffected:

- An `auto` runtime has no `schedule.stage`. The framework does not guess a default stage.
- A manual or event runtime that runs in the background reads an input from the same execution (see [Triggers](#triggers)).

When a package placed in the plugin directory by hand has such an error, the loader leaves out only that runtime and writes the file, the field and the reason to the server log. The package's other runtimes, tools and panels load as usual, and its output contract no longer counts as provided by the package. `pnpm validate:plugin` and installation report it as an error.

Session prep, the session's plugin list, and the installed plugin list in Settings show a warning for each unavailable runtime and ignored field. Warnings are visible without opening advanced settings; choose “Show reason” to read the manifest file, field, and reason. Paths are relative to the plugin directory and do not show the server's installation path. Correcting the manifest and reloading the plugin updates the warnings. See [`GET /api/plugins`](./api.md#get-apiplugins) for the response fields.

When a manifest has a field the host does not know (for example an old field that was removed, or a field written for a newer host), the loader leaves out that field and writes the file and the field to the server log. The package loads as usual, and installation goes ahead. `pnpm validate:plugin` reports it as an error: remove it, or change it to the field name this page gives.

Only a whole field is left out: a field at the top of `PLUGIN.md`, an entry under `contributes` (including unsupported placements under `contributes.ui`), or a field at the top of the inline `runtime` or of a `RUNTIME.md`. Two cases still make the load fail:

- An unknown key inside a known field, for example `permissions.fs`, `io.conceal` or `schedule.priority`. The host does not run a declaration it only half understands.
- A field that looks like a misspelled field that limits or identifies the package, for example `permision`, `gaurd` or `covle`. These fields are `id`, `kind`, `version`, `covel`, `provides`, `requires`, `conflicts`, `permissions`, `entry` and `runtime` at the root, and `guard`, `permissions`, `effects`, `schedule`, `io` and `function` on a runtime. The error says which field it looks like.

The directory-level check also warns when the plugin's root has an `llm.toml`: the file is not read, and it does not fail the check.

These checks do not run plugin code, and they cannot replace the registration consistency check at startup.

### Summaries in the history window

`agent.history.includeSummaries: true` lets a limited `maxTurns` window still read the saved summaries. By default, summaries are not included. A runtime with a window does not trigger shared history compression. The built-in guide uses the last two turns plus summaries. The windows of the other built-in bookkeeping agents are 0 or 1 turns. For how they are laid out, see [Prompt structure](./prompt-structure.md#layout-for-bookkeeping-runtimes).

### The language of the prompt body

- The body of the main files `PLUGIN.md` and `RUNTIME.md`, and the fixed `content` of `contributes.prompt`, must be in English.
- Only Simplified Chinese has a variant. The root file uses `PLUGIN.zh.md`, and a child runtime uses `RUNTIME.zh.md`. These files contain only the body and the fixed section `content`. The frontmatter can be empty.
- The main file decides the structural fields. A variant cannot change the contracts, tools, stage, timeouts, or the IDs and positions of prompt sections.
- A session in Simplified Chinese reads the Chinese variant. Every other language (including Traditional Chinese) reads the main file. Variant files for other languages are never read.
- `COVEL_INSTRUCTION_LOCALE=en|zh` can fix the instruction language for all sessions without changing their content language. Player-visible text that instructions ask a model to write into state or events still uses the content language. When a value is absent, prefer omitting an optional field as its schema permits. For example, when Dice Check has no usable ability, its receipt omits `attribute` instead of filling in a "None" label chosen by the instruction language.

### Text the player sees

- Labels the player sees (`displayName`, `description`, `label`, `title`, `summary`, `about`) are written in English in the main manifest.
- Translations go in `locales/<locale>.yaml` at the plugin root. They are organized by section of the manifest file, and they contain only the translated text. They can be in any language. The loader compiles them into a locale map.
- A label file can translate only these fields. An entry written on a contract field or on prompt content is ignored, and `pnpm validate:plugin` reports it as an error. An inline locale map in the main manifest is also an error.
- The `messages` section of the same file translates the text in the UI spec and in the code (from the English original to the translation). For the rules on interface text, see [UI panels](./ui-panels.md#plugin-ui-text-rules). The code reads them with `translate(ctx, …)` or `labelText(ctx, …)`.
- For the format, see [i18n](./i18n.md#2-localize-a-plugin).

### Extra requirements for built-in plugins

- For a built-in plugin, the prompts the model reads (agent bodies and fixed sections) must have a Chinese variant. The body of a function runtime is documentation, so it is written only in English. A community plugin needs only English.
- Both languages must mention the same set of tools, injected blocks, and `runtime-inputs.<name>`. `pnpm check:prompts` checks this. It also uses `plugins/prompt-variants.lock.json` to catch the case where the English text changed but the Chinese was not updated. After you update both, run `pnpm prompts:lock`.
- For the full rules, see [i18n](./i18n.md#built-in-languages-and-the-extension-boundary).

The language versions of static prompts and runtime bodies are all captured when the definition (definition / generation) is loaded. At execution time, the body is picked from this snapshot using the effective locale. It does not reread files that are being hot-reloaded. A language choice cannot change the permissions or the execution contract of the main manifest.

### Commands

Using the built-in `world-init` as an example:

```sh
pnpm validate:plugin plugins/world-init
pnpm validate:plugin plugins/world-init/runtimes/dimension-tracker/RUNTIME.md
pnpm check:prompts
pnpm --filter @covel/plugin-world-init test
pnpm lint
```

Output of the first command:

```text
✓ Static package validation: /Users/you/covel/plugins/world-init
  languages: text en, zh; instructions en, zh
```

- `validate:plugin` performs only static author validation. It does not run `entry`.
- For built-in plugins, the real registration, the alignment of declarations, and the release acceptance are checked by `apps/server/tests/bootstrap/builtin-plugin-entries.test.ts`. That test runs with the full `pnpm test`. This check does not run the `entry` of community plugins.
- New behavior should be tested for normal output, invalid input, and data ownership. When an execution can fail, also verify that the proposals are not partly committed.
- The server code of a community plugin is loaded only after the player approves it. A declaration in the manifest is not an approval by itself.

## Built-in plugins at a glance

Below are all the plugins that ship with Covel from [plugins/](../../../plugins/). `kind: core` means the plugin joins every game by default, and a player can exclude it. `kind: plugin` is enabled only when a player chooses it. In the "runtime" column, "inline" means there is only the one runtime in the root file, and "none" means the plugin has only an entry, extensions, or UI.

<!-- prettier-ignore -->
| ID | Name | `kind` | Contracts provided | runtime | What it does |
| --- | --- | --- | --- | --- | --- |
| [affinity](../../../plugins/affinity/README.md) | Affinity | `plugin` | none | inline | Tracks numeric affinity between the player and NPCs. The right panel shows scores, tiers and changes; `prompt.segment@1` provides a read-only projection of current scores. |
| [branch-reply](../../../plugins/branch-reply/README.md) | Reply Variants | `plugin` | `branch-reply@1` | inline | Offers several replies the player can switch between. |
| [char-creator](../../../plugins/char-creator/README.md) | Character Creator | `core` | `character-creation@1` (default provider) | `player-init`, `character-tracker` | Creates the protagonist with echoed form answers and records character changes. |
| [character-blueprint](../../../plugins/character-blueprint/README.md) | Character Profiles | `plugin` | `character-blueprint@1`, `character-presence@1` | `presence` | Stores the character profiles a world presets, along with avatars, portraits, and voices. |
| [chat-mode-narrator](../../../plugins/chat-mode-narrator/README.md) | Dialogue Narrator | `plugin` | `narrative-engine@2` | inline | Makes the story read more like a conversation between characters. |
| [codex](../../../plugins/codex/README.md) | Codex | `plugin` | none | inline | Organizes newly found places, people, items, and rumors. |
| [core-quest](../../../plugins/core-quest/README.md) | Quest Log | `plugin` | `world-ir.vocabulary@1` | `log`, `vocabulary` | Registers quests from the narrative and moves them forward. |
| [dice-check](../../../plugins/dice-check/README.md) | Dice Check | `plugin` | `action-check@1` | `roller`, `recorder` | Rolls dice for actions that carry a risk of failure. |
| [guide](../../../plugins/guide/README.md) | Action Suggestions | `plugin` | `scene-prompts@1` | inline | After each story turn, reviews what has happened so far and offers short actions the player can use as they are. |
| [history-compaction](../../../plugins/history-compaction/README.md) | History Compaction | `core` | `history.compact@2` (default provider) | none | Organizes earlier conversation into segmented summaries. |
| [inventory](../../../plugins/inventory/README.md) | Inventory | `plugin` | `world-ir.vocabulary@1` | `ledger`, `vocabulary` | Records items gained and lost, and changes of equipment. |
| [living-world-rules](../../../plugins/living-world-rules/README.md) | World Rules | `plugin` | `living-world-rules@1`, `world-info@1` | none | Shows the rules in a world package that apply over the long term, and keeps the narrative to them. |
| [memory](../../../plugins/memory/README.md) | Story Memory | `core` | none | `extract` | Remembers the plot, scenes, character relationships, and the protagonist's state. |
| [narrator](../../../plugins/narrator/README.md) | Narrator | `core` | `narrative-engine@2` (default provider) | inline | Advances the story based on the player's actions. |
| [npc-graph](../../../plugins/npc-graph/README.md) | Relationship Graph | `plugin` | `npc-graph@1`, `graph-rag@1` | `extractor`, `rag-retriever` | Records the relationships between people. |
| [pregame](../../../plugins/pregame/README.md) | Pre-Game Setup | `core` | `session.opening@1` | inline | Reads the world material at the start and prepares the first adventure. |
| [scene-stage](../../../plugins/scene-stage/README.md) | Scene Stage | `plugin` | `stage-direction@1`, `scene-stage@1`, `scene-cast@1` | `seed`, `direction`, `resolver`, `cast` | Tracks scenes and day/night; a location change clears old direction actors before new cues. |
| [soundtrack](../../../plugins/soundtrack/README.md) | Soundtrack | `plugin` | none | `scene`, `cue` | Plays the background music a world includes, and switches it with the scene and mood. |
| [story-events](../../../plugins/story-events/README.md) | Hidden Story Events | `plugin` | `story-event-cue@1`, `story-event.plan@1` | `intake`, `evaluate`, `plot` | Hides story events that a world package declares until their conditions are met. When they are met, hands them to the narrative to be played out. |
| [tabletop-rules](../../../plugins/tabletop-rules/README.md) | Tabletop Rules | `plugin` | `tabletop-check@1` | `creation`, `check` | Assigns attribute points at the start, and settles attribute checks with code. |
| [world-init](../../../plugins/world-init/README.md) | World Dimensions | `core` | `world-data-provider@1`, `world.dimensions@1` | `schema-gen`, `dimension-context`, `dimension-tracker`, `dimension-clock`, `edit-dimensions` | Initializes character attributes and world dimensions, and keeps maintaining them. |
| [world-ir](../../../plugins/world-ir/README.md) | World Fact Extraction | `plugin` | `world-ir-provider@1` | inline | Extracts characters, relationships, events, and clues from this turn's story, for other plugins to reuse. |
| [world-time](../../../plugins/world-time/README.md) | World Time | `core` | `world-time-evolution@1`, `world-time-context@1` | `context`, `advance` | Keeps the date, the time of day, and the direction time flows, and settles time changes from this turn's story. |

The details of each plugin are in its own `PLUGIN.md` and README.

## Representative implementations

To see a real example of a given pattern, look here:

<!-- prettier-ignore -->
| Need | Built-in example |
| --- | --- |
| Narrative provider and user settings | [narrator](../../../plugins/narrator/PLUGIN.md) |
| Local tools and UI messages | [guide](../../../plugins/guide/PLUGIN.md) |
| Datasets (数据集) and operation-based writes | [inventory](../../../plugins/inventory/PLUGIN.md), [affinity](../../../plugins/affinity/PLUGIN.md) |
| World Model initialization | [world-init](../../../plugins/world-init/PLUGIN.md) |
| Character creation and tracking | [char-creator](../../../plugins/char-creator/PLUGIN.md) |
| Function runtime and public output | [world-time](../../../plugins/world-time/PLUGIN.md) |
| History transform extension | [branch-reply](../../../plugins/branch-reply/PLUGIN.md) |
| State summary slot | [core-quest](../../../plugins/core-quest/PLUGIN.md) |
| Memory definitions and extraction | [memory](../../../plugins/memory/PLUGIN.md) |
| History compaction extension | [history-compaction](../../../plugins/history-compaction/PLUGIN.md) |
| Stage and media records | [scene-stage](../../../plugins/scene-stage/PLUGIN.md) |
| Background music scheduling | [soundtrack](../../../plugins/soundtrack/PLUGIN.md) |
| World data entering the narrative prompt | [character-blueprint](../../../plugins/character-blueprint/PLUGIN.md) |
| Hidden world data and planning | [story-events](../../../plugins/story-events/PLUGIN.md) |

### Datasets (`contributes.datasets`)

A dataset is a typed kind of plugin data that a plugin declares: a namespace the package owns, plus the JSON Schema every record in it must satisfy.

```yaml
contributes:
  datasets:
    journal:
      schema: ./schemas/journal.json # required: a package-relative .json path
      key: id # optional: the top-level record field that is the key
      ops: [upsertItem, delete] # optional: allowed operations, default all
```

- **The name is the namespace.** The `journal` dataset is the plugin-data space `journal`. A name starts with a letter and holds only letters, digits, `_` and `-`, at most 64 characters. A name starting with `_` is reserved for the kernel and cannot be declared.
- `schema` must be a `.json` file in the package, with no `..` and no leading `/`.
- `key`: which top-level field of a record (a string value) is its key. Leave it out to derive no key; the caller then chooses keys.
- `ops`: the operation kinds this dataset allows, from `set`, `merge`, `inc`, `append`, `insert`, `remove`, `upsertItem`, `delete`. Leaving it out means all of them. When written it cannot be empty or contain duplicates.
- Omitted fields take their defaults. The compiled declaration always carries `namespace`, `schema` and `ops` (`key` only when written). The compiled result is copied onto `datasets` of every runtime in the package.
- **Relation to `contributes.data`.** When the same name appears in both `data` and `datasets`, the two `schema` paths must point at the same file: a namespace has one schema. `data` still governs world-pack import; the dataset governs the records in the namespace.
- A namespace without a dataset declaration behaves as before.

Loading, `pnpm validate:plugin` and installation read and parse every dataset schema file (a missing file, invalid JSON, or a path outside the package root is an error) and check `key`: when the schema has a top-level `properties`, `key` must be one of them and be listed in the top-level `required`. A schema without top-level `properties` (only `$ref`, `allOf` and the like) skips that check.

At commit, every proposal a plugin writes into a dataset namespace it declares is checked against the declaration:

- **Operation kinds.** Each operation kind of a `plugin.data.update` must be in `ops`. A whole-value write (`ctx.pluginData.set`, `plugin.data`, each item of `plugin.data.batch`) counts as `set`, and a delete (`plugin.data.delete`) counts as `delete`. So a dataset whose `ops` lack `set` cannot be overwritten with `set`.
- **Record schema.** The written value (for `plugin.data.update`, the result after the operations) must satisfy `schema`.
- A violation rejects the proposal with `code: "dataset-violation"`, under the commit-unit rules. When the host did not capture the schema document, every write is refused instead of let through.
- `key` is not checked at commit.
- Writes outside the commit pipeline skip these checks: world data import and sync (validated against the source's `schema`, see [World Data · Companion plugin data](./world-data.md#companion-plugin-data)), `context.store.setPluginData` in a plugin action RPC, and the management API `PUT`.

See [Transactions · Operation-based writes](./transactions.md#operation-based-writes-plugindataupdate).

### Action kinds (`contributes.actionKinds`)

What a player submits each time is a list of actions (see [API · submit_actions](./api.md#submit_actions)). The kernel has six base kinds: `say`, `act`, `narrate`, `direct`, `advance`, `command`. A plugin can declare more kinds of its own, without server code:

```yaml
contributes:
  actionKinds:
    - name: whisper
      roles: [player] # optional: which seat roles may use it, default [player]
      text: required # optional: required / optional (default) / none
      actor: true # optional: whether it is taken as a character, default true
      schema: ./schemas/whisper.json # optional: the JSON Schema fields must match
      display:
        label: whispers
        icon: ear
        placeholder: Whisper to someone
```

- **The wire kind is `<pluginId>/<name>`.** In `whisper-pack`, the example is `whisper-pack/whisper`. Two plugins may use the same `name` without a conflict. `name` is lower-case kebab-case, must not be a base kind's name, and must be unique in the package.
- `roles` must not be empty. Which role may submit which base kind is in [seats](./world-model.md#seats).
- `schema` is a JSON file in the package. Loading, `pnpm validate:plugin` and installation read it; a missing file, a file that is not a JSON object, or a path that leaves the package root is an error. A kind without `schema` takes no `fields`.
- `display.label` is the name in the composer and the kind label rendered for the model, chosen by the session language. `fields` follow the text as JSON; an action without text renders as its label and `fields`, and still reaches the player message and the chat history. For example `[Aya · whispers] Over here. {"target":"Guard"}` or `[Aya · passes]`.
- A form, choice or confirmation can declare in `actionKind` which kind the player's answer is (a base kind or `<pluginId>/<name>`); by default a choice is `say` and a form or confirmation `act`. The answer is checked against the seat's role by this kind; see [API · player interactions](./api.md#player-interactions).
- Only the kinds that the session's runnable plugins declare are available. The server checks each action against that catalogue; see [`GET /api/sessions/:id/action-kinds`](./api.md#action-kind-catalogue).
- Function runtimes read the actions from `ctx.playerActions`, with `fields` as submitted; see [turn information in the handler context](#turn-information-in-the-handler-context).

### Reserved data namespaces

Every namespace that starts with `_` is reserved for the kernel.

- Generic REST APIs and built-in model data tools cannot write to or delete any `_` namespace. Plugin proposals are subject to the same rule, except that the owning plugin’s code may write its own `_hidden.*` buckets. Unknown underscore names and the old `_memory` remain protected.
- `_hidden.<namespace>` holds world data declared `visibility: hidden`, along with hidden content a plugin appends during the story. Only the runtimes of the owning plugin can read it, and only the owning plugin's own code can write to it.
- Plugin logs are produced through the restricted logger API. Business data uses ordinary names such as `blocks` and `definitions`.
- `__kernel:<subsystem>` is another owner partition. A plugin's bound read interface cannot reach it.

For the full list and the read permissions, see [Storage architecture](../internals/storage.md#plugin-data-ownership-and-reserved-names).
