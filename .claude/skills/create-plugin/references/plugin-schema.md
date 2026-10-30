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
  services: [sample.notes@1]
  extensions: [prompt.segment@1/notes]
  hooks: [PostContextAssembly]
  data:
    notes:
      version: 1
      schema: ./schemas/note.schema.json
  ui:
    right: [./ui/notes.json]
---
```

Declare only registrations actually made by the entry. `contributes.actions` lists RPC IDs; `contributes.commands` lists slash-command descriptors. A command is not an RPC registration. Services, extensions (`<point>/<id>`, or `{point, id, …}` with options), tools, hooks (event names, or `{event, enforce}`), wires, and form validators must each match their contribution declaration. Settings live in `contributes.settings`; event schemas live in `contributes.events`. A session admits one declarer of an event topic, so prefix a topic with a word of the plugin's own.

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

Leave out a field whose value is its default; `pnpm validate:plugin` warns about one written anyway. The defaults: `schedule.trigger.type: auto`, `schedule.every: 1`, `io.visibility: system`, `from.cardinality: one`, `io.inputs.*.required: true`, `io.selfData[].format: summary` and `maxEntries: 50`, `schedule.detached: false`, `schedule.background: false`, `contributes.hooks[].enforce: normal`, `contributes.extensions[].order: 0`; for an agent, `agent.model` is `plugin` (`story` for a `story` runtime), `agent.reasoning` is `true`, and `agent.loop` is `timeoutMs: 120000`, `callTimeoutMs: 60000`, `maxRetries: 3` (`240000` / `120000` / `1` for a `story` runtime).

A runtime with a `function` block is a function runtime (its handler defaults to `./handler.js`; write `function: {}` when nothing else is set); one without is an agent. The trigger is `auto` (the default), `manual`, or `event`. An `auto` runtime declares `schedule.stage`: `setup`, `pre-turn`, `narrative`, `post-turn`, or `audit`; `schedule.every: N` runs it on every N-th logical turn, and `schedule.trigger` can add `startTurn`, `cooldownTurns`, and `maxTriggerCount`. Manual/event runtimes omit stage and may use `schedule.background: true`. Stage background work on a post-turn / audit function uses `schedule.detached: true`, or an object with `settle: true`, `maxSettleWaitMs`, `maxQueueMs` and `maxExecutionMs`. Dependencies belong in `schedule.needs` (success gating) and `schedule.after` (ordering only).

`io.inputs` binds named inputs from `{runtime: sample-notes/extract}` or `{contract: name@1}`. Within a multi-runtime package, write the complete `<pluginId>/<runtimeId>`; an inline runtime uses its package ID. See [reference scope](../../../../docs/reference/plugins.md#依赖和引用的范围). Required turn inputs imply a success dependency; optional inputs allow absence. `select` is a JSON Pointer into the successful upstream value. Function code reads `ctx.inputs.<name>.value`; agent prompts receive the `runtime-inputs` block. Committed outputs use `scope: committed` plus `recordAs`. A detached kernel digest uses `from: {kernel: turn-digest@1}`. Always-detached manual/event runtimes cannot bind same-execution turn outputs.

`io.selfData` contains own-plugin namespace injections, without a `kind` field. `io.payloadSchema` validates invocation payloads. `io.output` supports `contract`, `schema`, and `recordAs`. `io.visibility` is `story` (the main narrative provider) or `system` (every other runtime, the default).

Agents group settings in `agent`: `model`, `toolChoice`, `reasoning`, `history`, `tools`, `advertiseEvents`, `finishWith`, `completion`, and `loop`. `finishWith: <tool>` ends the run after that tool succeeds and makes the model call a tool on every step; `completion: {require: tool-use|explicit, afterTools: [...]}` is the long form for several tools or `runtime-done`. `reasoning: false` turns model reasoning off. `agent.loop` holds time, retry and step limits. `agent.tools.services` imports other plugins' model-facing services as read-only tools: a contract ID (tool name = contract without `@version`, dots as dashes) or `{contract, as}`. An import cannot clash with another tool name, cannot be a completing tool, and is absent (the run continues) without exactly one active provider; a function runtime calls `ctx.services` instead. See [imported service tools](../../../../docs/reference/tools.md#导入的服务工具). An agent writes only through the tools in `agent.tools`: `pluginData`, notifications or topic events written in its final JSON do nothing. `io.concealed: true` keeps a runtime's prompts, replies and returned text out of traces, the stream and the conversation, and cannot be combined with `visibility: story`. Functions group `handler` and `timeoutMs` in `function`. HTTP allowlists and effect declarations remain runtime-level `permissions` and `effects`. Guard modules use runtime-level `guard`.

A sub-agent provider is an agent runtime with `schedule.subagentOnly: true` and usually `io.output.contract`: the scheduler never runs it and no manual RPC can. It implies `trigger: manual` and allows no `stage`, `needs`, `after`, `background`, `io.output.recordAs`, `guard` or `visibility: story`. A function calls it with `ctx.agents.run({target: {contract} | {runtimeId}, brief, data?, budget?})`; an agent lists `delegate` in `agent.tools.builtin`. It sees only the brief, keeps read-only tools, runs the `actor` profile by default and returns output only (no writes, no events); at most 8 run per execution and a sub-agent cannot start another. Failures resolve as `{ok: false, error: {code}}`. See [sub-agents](../../../../docs/reference/plugins.md#子-agent).

Memory policy is plugin behavior: use `memory.block-definitions@1` services and `memory.blocks@1` world data. Compression strategy uses `history.compact@2`; see `docs/reference/extension-points.md` for bounded summary segments and replacement IDs. Do not declare removed root memory policy fields.
