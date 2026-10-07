# Current plugin authoring contract

Root `PLUGIN.md` and child `RUNTIME.md` use strict YAML frontmatter. The main checkout's `pluginManifestSchema` and `runtimeAuthoringManifestSchema` are authoritative. Old flat fields are rejected; do not add compatibility readers.

## Package manifest

Optional credits (`author`, `license`, `homepage`) are display data shown before play; links are `https` only. Fields and limits: `docs/reference/plugins.md` ("作者信息"). When the package has a `package.json`, its `version` equals the manifest `version`.

```yaml
---
id: sample-notes
kind: plugin
version: 0.1.0
description: Save selected story notes.
entry: ./server/index.js
requires: [narrative-engine@1]
contributes:
  tools: [save-note]
  actions: [open-notes]
  commands:
    - name: notes
      description: Open notes
      action: open-notes
  services: [sample.notes@1]
  extensions:
    - point: prompt.segment@1
      id: notes
  hooks:
    - event: PostContextAssembly
  data:
    notes:
      version: 1
      schema: ./schemas/note.schema.json
  ui:
    right: [./ui/notes.json]
---
```

Declare only registrations actually made by the entry. `contributes.actions` lists RPC IDs; `contributes.commands` lists slash-command descriptors. A command is not an RPC registration. Services, extension point/id pairs, tools, hooks, wires, and form validators must each match their contribution declaration. Settings live in `contributes.settings`; event schemas live in `contributes.events`.

Every package has one root manifest. For a single runtime, add `runtime: { ... }` there and use the root Markdown body as its agent prompt. For multiple runtimes, omit root `runtime` and create `runtimes/<local-id>/RUNTIME.md`. The executable ID is `<plugin-id>/<local-id>`. Child manifests contain runtime fields only. Paths for package contributions are package-root relative; handler and runtime schema paths are runtime-directory relative.

Contract IDs use lowercase letters, digits, dots or hyphens followed by `@<positive major>`, for example `narrative-engine@1`. Root `provides`, `requires`, `optional`, and `conflicts` use those contracts. An output producer declares `io.output.contract` and includes it in root `provides`; only one runtime per package may produce a given output contract. Root `contracts` maps public schema IDs to `{schema: ./schemas/file.json}`. A data namespace accepting world imports adds `accepts: [contract@1]` and uses the same schema path as that root contract.

## Runtime manifest

```yaml
---
type: function
schedule:
  stage: post-turn
  trigger: {type: auto}
io:
  inputs:
    narrative:
      from: {contract: narrative-engine@1, cardinality: one}
      select: /narrativeOutput
      required: true
  visibility: plugin
function:
  handler: ./handler.js
  timeoutMs: 30000
---
```

`type` is `agent` or `function`. Stage runtimes (`auto`/`scheduled`) declare `schedule.stage`: `setup`, `pre-turn`, `narrative`, `post-turn`, or `audit`. Manual/event runtimes omit stage and may use `schedule.manual.execution: background`. Stage background work uses `schedule.completion` with a detached mode and bounded queue/execution deadlines. Dependencies belong in `schedule.needs` (success gating) and `schedule.after` (ordering only).

`io.inputs` binds named inputs from `{runtime: local-id}` or `{contract: name@1}`. Use relative local runtime IDs within the package. Required turn inputs imply a success dependency; optional inputs allow absence. `select` is a JSON Pointer into the successful upstream value. Function code reads `ctx.inputs.<name>.value`; agent prompts receive the `runtime-inputs` block. Committed outputs use `scope: committed` plus `recordAs`. A detached kernel digest uses `from: {kernel: turn-digest@1}`. Always-detached manual/event runtimes cannot bind same-execution turn outputs.

`io.selfData` contains own-plugin namespace injections, without a `kind` field. `io.payloadSchema` validates invocation payloads. `io.output` supports `contract`, `schema`, and `recordAs`. `io.visibility` is `story`, `plugin`, or `system`.

Agents group settings in `agent`: `model`, `llm`, `tools`, `advertiseEvents`, and `loop`. `agent.loop` holds timeout/step/retry limits and `completion: {require: tool-use|explicit, afterTools: [...]}`. Functions group `handler` and `timeoutMs` in `function`. HTTP allowlists and effect declarations remain runtime-level `permissions` and `effects`. Guard modules use runtime-level `guard`.

Memory policy is plugin behavior: use `memory.block-definitions@1` services and `memory.blocks@1` world data. Compression strategy uses `history.compact@2`; see `docs/reference/extension-points.md` for bounded summary segments and replacement IDs. Do not declare removed root memory policy fields.
