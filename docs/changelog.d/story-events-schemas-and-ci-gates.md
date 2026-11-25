### Security

- **ZIP archive extraction enforces cumulative uncompressed size, expansion ratio, and collection budgets mid-stream.** `readAllEntries` now tracks both central-directory declared sizes and actual inflated bytes across entries, charging bytes that exceed a spoofed `uncompressedSize` header to the shared collection budget and aborting high-ratio archives before buffering them into memory.
- **Provider HTTP permission and cancellation wrappers now apply to `context.http` as well as `context.utils`.** Both the server entry facade and `@covel/test-runtime` wrap `context.http` with the provider package's own declared HTTP permissions and active call `AbortSignal`.
- **Webview specs always validate `webview.entry` path safety.** `pluginUiSpecSchema` and `pluginUiSpecIssues` now reject traversal or absolute `webview.entry` paths even when `webview.root` is omitted.

### Fixed

- **Fixed `story-events` semantic judging, condition evaluation, and reward settlement.** `compactWorldIR` and `compactDimensions` measure and emit `modelFacingJson` projections; shorthand judge maps exclude reserved condition keys; missing inventory items evaluate numeric quantity predicates as `0`; same-turn judge cache hits are isolated between `pre-turn` and `audit` phases; hidden options for payload events require `revealed` rather than `armed`; pending `requireOutcome` settlements are preserved when semantic judging is disabled or fails transiently; pure-reward events are excluded from narrative delivery repeats; `evaluate` skips nested recursions; and `MESSAGE` writes `__turnId` instead of `turnId`. Updated `plugins/story-events/README.md` and `judge` prompts to match the schema.
- **Hardened model-facing prompt serialization in `char-creator` and `world-init`.** Character fields in the roster and dimension values in the tracker prompt pass through `modelFacingJson` before serialization.
- **Prevented stack overflows in runtime `deepFreeze` and removed all circular module dependencies across the monorepo.** `deepFreeze` now guards against cyclic object graphs with a `WeakSet`, and runtime helpers are split to break the remaining import cycles.
- **Unified event schema directory validation across the server and `@covel/test-runtime`.** Both hosts now share `createEventDirectory` from `@covel/tools` with JSON Schema draft 2020-12 support, strict path containment, and bounded conflict warning tracking.
- **Tightened author-facing manifest schemas and regenerated JSON Schema artifacts.** `contributes.data` validates plugin namespace keys; runtime `io.inputs` keys, JSON Pointers, schema references, `recordAs` names, and `agent.completion.afterTools` entries reject malformed or blank inputs; and `plugin-manifest.schema.json` enforces `minProperties: 1` on `contributes.worldProjections` and its `outputs`.
- **Reported `channel.bridge@1` as a host-only extension point in `@covel/test-runtime`.**

### Changed

- **Enforced zero circular dependencies and production environment variable registration in `pnpm check`.** `pnpm deps:check` now runs `fallow architecture --cycles`, `pnpm check` runs `pnpm check:env` (`scripts/check-production-env.mjs`), and Turbo bundled-plugin inputs cover all bundled plugin subdirectories with a contract test in `scripts/tests/turbo-contracts.test.mjs`.
