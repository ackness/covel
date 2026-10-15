### Breaking

- **A kernel input takes only `from`.** `io.inputs.<name>` with `from: { kernel: turn-digest@1 }` rejects `scope`, `select`, `required`, `accepts` and `recordAs`; they never did anything. Remove them from your RUNTIME.md. See `docs/reference/plugins.md`.
- **The game applies the full UI spec rules.** A panel with a relative `repeat.statePath` or an `$item` / `$bindItem` that starts with `/` is no longer shown; `pnpm validate:plugin` already rejected both. The host API `loadPluginUi()` and `LoadedRuntime.uiSpecs` are gone; use `loadPluginUiSpecs()`.

### Changed

- **One copy of the manifest rules.** Loading, `pnpm validate:plugin` and installation check RUNTIME.md and the inline `runtime` with the same schema, and UI specs with the same rules, so a package that passes validation is not dropped or stripped in the game. A manual or event runtime with `schedule.manual.execution: background` that reads a same-execution input, another plugin's `pluginId` in a UI spec, a newer `specVersion`, a webview entry that is not a local `.html` of at most 512 KiB, and an unknown `surfaces` value are now reported by validation instead of failing in the game.
- **A runtime that can never run no longer hides itself.** An `auto` runtime without `schedule.stage`, or a background manual/event runtime that reads a same-execution input, is left out at load with the file, field and reason in the server log; the rest of its package loads, and its output contract no longer counts as provided. Validation and installation report it as an error.
- **One broken UI spec hides only itself.** A spec that cannot be read or breaks a rule is reported in `/api/ui-specs` `diagnostics[]`; the plugin's other panels still show.

### Fixed

- **Manifest errors name the file and the field you wrote.** A cross-field error in an inline `runtime` now names `PLUGIN.md`, and errors use the authored paths (`schedule.detached`, `io.visibility`, `agent.completion.require`) instead of internal names (`turnCompletion`, `outputKind`).
- **The `schedule.after` contract description no longer says it must be a dependency.** An `after` contract only orders and does not have to be listed in `requires` or `optional`.
