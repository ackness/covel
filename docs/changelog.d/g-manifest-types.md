### Breaking

- **The compiled runtime manifest no longer carries package fields.** `RuntimeManifest` drops `displayName`, `entry`, `extensions`, `tags`, `events`, `ui`, `i18n`, `commands` and `worldProjections`; the loader never filled them on a runtime. Read them from the package declaration (`PLUGIN.md`, `ParsedPluginMd.manifest`). `userSettings` and `dataSchemas` stay, copied from the package. In `/api/plugins`, a runtime summary has no `tags` and a runtime contract has no `ui`; `/api/plugin-flows` steps have no `uiSlots`. Package `tags` are unchanged.
- **The in-code inject kind `runtime` is gone.** `input.inject` no longer accepts `{ kind: "runtime", from, field, as }`, which no `PLUGIN.md` could produce. Code that builds manifests for `executeTurn` reads an upstream result with an `inputs` binding (`inputs: { name: { from: { runtime } } }`). `@covel/context` no longer exports the synchronous `buildInjectBlocks`.
- **One JSON Schema for the compiled manifest.** `runtime-manifest.input.schema.json` is renamed `runtime-manifest.compiled.schema.json` and titled as the internal compiled form; `runtime-manifest.authoring.schema.json`, `runtimeManifestAuthoringSchema` and the `authoringTriggerConfigSchema` alias are removed. Authors keep using `runtime-manifest.schema.json`.

### Fixed

- **`validatePluginManifest` checks a `PLUGIN.md`.** It validated the frontmatter against the compiled runtime schema and rejected every real package manifest; it now uses the package manifest schema.
- **A runtime that can emit events stays in the foreground.** A `schedule.completion.mode: detached` runtime that lists `emit-event` in its tools, or declares `advertiseEvents: true`, is no longer moved to the background; the check read a package field that was always empty on a runtime.
