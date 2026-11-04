# Current plugin authoring contract

Root `PLUGIN.md` and child `RUNTIME.md` use strict YAML frontmatter. The main checkout's `pluginManifestSchema` and `runtimeAuthoringManifestSchema` are authoritative. `pnpm validate:plugin` rejects old flat fields and any other unknown field; loading leaves an unknown whole field out with a warning (rules: [`docs/reference/plugins.md`](../../../../docs/reference/plugins.md#静态检查查什么)). Do not add compatibility readers.

## Package manifest

Optional credits (`author`, `license`, `homepage`) are display data shown before play; links are `https` only. Fields and limits: `docs/reference/plugins.md` ("作者信息"). The scaffold starts the manifest at version `0.1.0`; the version lives only in `PLUGIN.md`, and a `package.json` (optional) carries none.

The loader works out what an author leaves out; `pnpm validate:plugin` warns about a written value equal to it. `id` is the directory name, `kind` is `plugin`, `entry` is `./server/index.js` when that file exists, a runtime with a `function` block is a function and one without is an agent, `function.handler` is `./handler.js` next to the manifest, `provides` absorbs every runtime's `io.output.contract`, `ui:*` / `cost:*` tags are derived (write only tags such as `mode:*`), and `contributes.data.*.authoring.source` takes its format from `path` and `key: id`. Full list: [`docs/reference/plugins.md`](../../../../docs/reference/plugins.md#默认值).

```yaml
---
version: 0.1.0
description: Save selected story notes.
requires: [narrative-engine@2]
contributes:
  tools: [save-note]
  actions: [open-notes]
  commands:
    - name: notes
      description: Open notes
      action: open-notes
  services:
    - sample.notes@1
    - { contract: sample.notes-add@1, access: write }
  extensions: [prompt.segment@1/notes]
  hooks: [PostContextAssembly]
  datasets:
    notes:
      schema: ./schemas/note.schema.json
      key: id
      description: Notes the player asked to keep.
  ui:
    right: [./ui/notes.json]
---
```

`contributes.datasets.<name>` types a namespace of the plugin's own data: every record must match `schema`, `key` names the record field that is its key, `ops` limits the operations, `tools` the dataset tools an agent may select (default: `get`, `list`, `upsert` when `ops` allow `set`, `update` when they allow another operation) and `description` is model-facing English. `contributes.data` declares a namespace for world data and memory search; when both name a namespace, they use the same schema. Full rules: [`docs/reference/plugins.md`](../../../../docs/reference/plugins.md#数据集contributesdatasets).

Declare only registrations actually made by the entry. `contributes.actions` lists RPC IDs; `contributes.commands` lists slash-command descriptors. A command is not an RPC registration. Services, extensions (`<point>/<id>`, or `{point, id, …}` with options), tools, hooks (event names, or `{event, enforce?, holdsDrafts?}`), wires, and form validators must each match their contribution declaration. Settings live in `contributes.settings`; event schemas live in `contributes.events`. A session admits one declarer of an event topic, so prefix a topic with a word of the plugin's own.

A hook handler is `async (ctx, payload) => ({action: "continue"})`. `ctx.locale` is the session's content locale and `ctx.pluginId` / `ctx.runtimeId` name the runtime the event is about; payloads do not repeat them. Events, payloads and results: `docs/reference/hooks.md`.

Every package has one root manifest. For a single runtime, add `runtime: { ... }` there and use the root Markdown body as its agent prompt. For multiple runtimes, omit root `runtime` and create `runtimes/<local-id>/RUNTIME.md`. The executable ID is `<plugin-id>/<local-id>`. Child manifests contain runtime fields only. Paths for package contributions are package-root relative; handler and runtime schema paths are runtime-directory relative.

Contract IDs use lowercase letters, digits, dots or hyphens followed by `@<positive major>`, for example `narrative-engine@2`. Root `provides`, `requires`, and `conflicts` use those contracts. An output producer declares `io.output.contract`, and the package provides it without a `provides` entry; write `provides` only for a contract no runtime outputs (a service, say) or to mark `{contract, default: true}`. Only one runtime per package may produce a given output contract. A contract a runtime reads but root `requires` does not list is optional: it binds when a provider is active. Root `contracts` maps public schema IDs to `{schema: ./schemas/file.json}`. A data namespace accepting world imports adds `accepts: [contract@1]` and uses the same schema path as that root contract.

## Runtime manifest

```yaml
---
schedule:
  stage: post-turn
io:
  inputs:
    narrative:
      from: {contract: narrative-engine@2}
      select: /narrativeOutput
function:
  timeoutMs: 30000
---
```

Leave out a field whose value is its default; `pnpm validate:plugin` warns about one written anyway. The defaults: `schedule.trigger.type: auto`, `schedule.every: 1`, `io.visibility: system`, `from.cardinality: one`, `io.inputs.*.required: true`, `io.selfData[].format: summary` and `maxEntries: 50`, `schedule.detached: false`, `schedule.background: false`, `contributes.hooks[].enforce: normal`, `contributes.hooks[].holdsDrafts: false`, `contributes.extensions[].order: 0`; for an agent, `agent.model` is `plugin` (`story` for a `story` runtime), `agent.reasoning` is `true`, and `agent.loop` is `timeoutMs: 120000`, `callTimeoutMs: 60000`, `maxRetries: 3` (`240000` / `120000` / `1` for a `story` runtime).

A runtime with a `function` block is a function runtime (its handler defaults to `./handler.js`; write `function: {}` when nothing else is set); one without is an agent. The trigger is `auto` (the default), `manual`, or `event`. An `auto` runtime declares `schedule.stage`: `setup`, `pre-turn`, `narrative`, `post-turn`, or `audit`; `schedule.every: N` runs it on every N-th logical turn, and `schedule.trigger` can add `startTurn`, `cooldownTurns`, and `maxTriggerCount`. Manual/event runtimes omit stage and may use `schedule.background: true`. Stage background work on a post-turn / audit function uses `schedule.detached: true`, or an object with `settle: true`, `maxSettleWaitMs`, `maxQueueMs` and `maxExecutionMs`. Dependencies belong in `schedule.needs` (success gating) and `schedule.after` (ordering only).

`io.inputs` binds named inputs from `{runtime: sample-notes/extract}` or `{contract: name@1}`. Within a multi-runtime package, write the complete `<pluginId>/<runtimeId>`; an inline runtime uses its package ID. See [reference scope](../../../../docs/reference/plugins.md#依赖和引用的范围). Required turn inputs imply a success dependency; optional inputs allow absence. `select` is a JSON Pointer into the successful upstream value. Function code reads `ctx.inputs.<name>.value`; agent prompts receive the `runtime-inputs` block. Committed outputs use `scope: committed` plus `recordAs`. A detached kernel digest uses `from: {kernel: turn-digest@1}`. `from: {kernel: operations@1}` gives agents and functions a frozen `{operations: [{contract, summary, request?, result?, truncated?}]}` snapshot of staged operations from completed, commit-eligible upstream runs, including nested results and excluding seeds and discarded records. It always has a value, adds no dependency, exposes no operation or producer IDs, and is unavailable to tools and detached runtimes. Both kernel inputs take only `from`. Always-detached manual/event runtimes cannot bind same-execution turn outputs.

`io.selfData` contains own-plugin namespace injections, without a `kind` field. `io.payloadSchema` validates invocation payloads. `io.output` supports `contract`, `schema`, and `recordAs`. `io.visibility` is `story` (the main narrative provider) or `system` (every other runtime, the default).

Every agent finishes by calling the host-generated `submit-output` alone with its output object. An authored output schema is used unchanged; schema-less system agents may submit `{}` and setup completion signals explicitly. `completion: { require: tool-use, afterTools: [save-note] }` requires successful business work before submission and never ends the runtime by itself. Omit prerequisites when no-change turns may skip writing. Read canonical results and submit them without repeating successful writes. Use `ReviewAgentOutput` for semantic correction using public own tool results; it cannot replace output or add effects. A review whose purpose is keeping text from players (spoilers, content rating) declares `{ event: ReviewAgentOutput, holdsDrafts: true }`, so story drafts wait until every review accepts; see `docs/reference/hooks.md#holds-drafts`. Never declare `submit-output` in contributes, allowlists or tool files. Tool parameter schemas and output schemas are distinct.

A sub-agent provider is an agent runtime with `schedule.subagentOnly: true` and usually `io.output.contract`: the scheduler never runs it and no manual RPC can. It implies `trigger: manual` and allows no `stage`, `needs`, `after`, `background`, `io.output.recordAs`, `guard` or `visibility: story`. A function calls it with `ctx.agents.run({target: {contract} | {runtimeId}, brief, data?, budget?})`; an agent lists `delegate` in `agent.tools.builtin`. It sees only the brief, keeps read tools and permitted write-service imports, runs the `actor` profile by default, and returns output without an independent commit unit. Successful service operations join the parent; failed children discard them. At most 8 run concurrently and depth is 1; session caps also bound cumulative calls and distinct actors. Failures resolve as `{ok: false, error: {code}}`. See [sub-agents](../../../../docs/reference/plugins.md#子-agent).

Memory policy is plugin behavior: use `memory.block-definitions@1` services and `memory.blocks@1` world data. Compression strategy uses `history.compact@2`; see `docs/reference/extension-points.md` for bounded summary segments and replacement IDs. Do not declare removed root memory policy fields.


Framework-owned orchestration schemas are optional service/runtime contracts,
not kernel extension points. `turn-policy@1` is a read service declared in
`contributes.services`; use SDK canonical request/input/output schemas and
contract-only `services.call({contract, input})`. A session choice identifies
both pluginId and service name. Agent imports use names, with host-supplied
actions and limits.

An actor declares `schedule.subagentOnly: true` and
`io.output.contract: character-actor@1`. Omit the schema to derive the canonical
one, or use `contract:character-actor@1`; no local contract file is needed.
`ctx.agents.run` adds `characterId` and optional `instruction`; actors reject
`data`, and other providers reject actor-only fields. `delegate` uses
`character` names/aliases. `historyFor(characterId, {limit?})` is available to
functions, guards and plugin tools. Follow [contracts](../../../../docs/reference/plugin-extensions.md#orchestration-contracts)
and [execution limits](../../../../docs/reference/plugins.md#character-orchestration)
rather than copying their rules into a plugin. Keep actor intent out of stories.

A top-level `narrative-engine@2` story may return `yield: continue` to request bounded host advancement after commit. Functions see one system `advance` in `ctx.playerActions` and the input digest; the root logical turn remains frozen. Nested output does not control advancement. Keep story service imports optional when their absence should not stop play. See [the story contract](../../../../docs/reference/plugins.md#故事请求自动推进) and [session settings](../../../../docs/reference/api.md#auto-advance).

Presentation functions use the restricted public-story context and durable dispatch allowance in [the presentation contract](../../../../docs/reference/plugins.md#presentation-runtimes). Use the [selector and detached generator examples](../../../../docs/plugins/advanced.md#呈现选择器), and test real manifest admission, forbidden capabilities, commit isolation, cache charging and supersession. Agents cannot declare presentation; a function still follows normal server-code approval.

World source paths are relative to the world package. Declare `accepts` plus `authoring.source` or `characterField` to let actual content infer a receiver; schema publication alone does not receive data. See [receiver rules](../../../../docs/reference/world-data.md#data-receivers).

File references resolve relative to their declaring manifest: package UI/events in root `PLUGIN.md`, runtime handlers/guards/private schemas in their `RUNTIME.md`. Parent segments such as `../../` must remain contained inside the package. `authoring.source.path` remains relative to the consuming world; webview entry remains relative to its declared root. See `docs/reference/plugins.md#declaration-paths`.
