### Breaking

- **`store.getSession()` returns a read-only session view, not the session record.** Function handlers, guards, tools and plugin actions now get `PluginSessionView`: `phase`, `completedPlayerTurns`, `locale` and `setupRuntimes` (each entry `state`, plus `resolution`, `lastError`, `reason` or `warning` where they apply). Code that read another field of the record (`id`, `activePlugins`, `status`, …) gets `undefined`; take the session ID and language from `ctx.sessionId` and `ctx.locale`. Fields: `docs/reference/plugins.md`.
- **`ctx.execution` holds only `origin` and `sourceTurnId`.** The kernel's `executionId`, `logicalTurnId` and `countPolicy` are no longer handed to plugin code.
- **`shortId` and `shortIdBatch` require the context's `random`, and `ctx.random` is never missing.** The SDK no longer falls back to `crypto.randomUUID` or `Math.random` when no random source is passed. Pass `ctx.random` (or `context.random` in a tool) as the fourth argument; in tests, `makeRandom()` from `@covel/plugin-test-utils`.

### Added

- **The plugin SDK types everything the host passes to a function handler or guard.** `PluginFunctionContext` in `@covel/plugin-handlers-utils` now has `execution`, `recursionDepth`, `recursiveCall`, `session`, `activation`, `gateway`, `utils`, and the media capabilities `media`, `images`, `speech`, `music` and `assetProgress`, with their types (`PluginImages`, `PluginMediaRef`, …) and `PluginTurnDigest` for the `turn-digest@1` kernel input. The host builds its context from these types, and a compile-time check plus a runtime test fail when the two drift apart.

### Fixed

- **The SDK README and help texts match the package.** The README states the real `zod` peer range and every subpath export, the `tool()` example imports from `@covel/plugin-handlers-utils`, the `covel-test-runtime` help uses a scaffolded plugin, and the `plugin-with-tools` template no longer ships an `.npmrc` that pointed at a file it must not have. `docs/plugins/essentials.md` lists `covel.registerWires` → `contributes.wires`.
