### Breaking

- **`io.visibility: plugin` is gone.** A runtime is `story` (the narrative provider) or `system` (every other runtime), and `system` is the default, so delete `visibility: plugin` and `visibility: system`. A package that still says `plugin` does not load; the error names the file and the field. `RuntimeManifest.outputKind`, the hook payloads and `GET /api/framework/capabilities` list only `story` and `system`. The plugin list no longer shows the "Auxiliary" badge. The defaults are listed under "Defaults" in `docs/en/reference/plugins.md`.
- **The `scheduled` trigger is gone; an `auto` runtime takes `schedule.every`.** Replace `trigger: { type: scheduled, interval: N }` with `schedule.every: N` and drop `trigger.type: auto`, which is the default. `startTurn`, `cooldownTurns` and `maxTriggerCount` stay under `schedule.trigger`. A package that still says `scheduled` or `interval` does not load; the error names the file and the field. The runtime summaries of `GET /api/plugins` and the plugin flow carry `trigger.every` instead of `trigger.interval`.
- **An agent that leaves out its model slot or loop limits gets new defaults.** `agent.model` defaults to `story` for a `story` runtime and `plugin` for any other, where it used to fall back to the request's `default` binding. `agent.loop` defaults to `timeoutMs` 120000, `callTimeoutMs` 60000, `maxRetries` 3 (a `story` runtime: 240000, 120000, 1), where `maxRetries` used to default to 1. Write the old values if a runtime needs them.
- **Every bundled plugin whose manifest changed has a new version.** Setup runtimes of existing development sessions run again at the next player action; recreate a session if its setup guard does not skip work already done.

### Added

- **`pnpm validate:plugin` warns about a field written with its default value.** It names the file and field (`is the default value; remove it`) and the package still passes. It also warns when a package with an `entry` module or a setup runtime has no `version`, since setup reruns only when the version changes.

### Changed

- **Bundled manifests and the plugin scaffold write only what cannot be defaulted.** Defaults such as `cardinality: one`, `required: true`, `format: summary`, `enforce: normal`, `role: system` and `contributes.data.*.version: 1` are left out, and the `analyst` scaffold no longer sets its own loop limits.
