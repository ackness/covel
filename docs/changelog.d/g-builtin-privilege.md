### Breaking

- **Bundled plugins no longer get a store community plugins lack.** A bundled function handler or agent guard used to receive a "trusted" `ctx.store` that read the world record and characters and wrote plugin data and characters directly. Every handler and guard now gets the same read-only `ctx.store`. Read characters, the character schema and the world record through `ctx.world`, write plugin data through `ctx.pluginData`, and return other writes as proposals (`withPendingProposals`). Rules: `docs/reference/plugins.md`.
- **An agent guard gets the same context as a function handler.** A community guard used to get only a read-only store: no `pluginData`, logger, gateway, utils or media, and `recursiveCall` was refused. Every guard now gets the handler's context, including `ctx.inputs`, `ctx.execution` and `ctx.recursiveCall`; a community plugin's `utils` still reaches only the addresses its `permissions.http` declares. When the guard returns or times out, `ctx.signal` is aborted and these capabilities stop working, as they do for a handler.

### Added

- **Every plugin can import the plugin SDK and `zod` without shipping them.** The host resolves `@covel/plugin-handlers-utils` (with its `/dimensions` and `/prompts` subpaths) and `zod` to its own copies for the entry, handlers, guards and world projections of every plugin, bundled or installed. A plugin copied out of the repository loads as it does inside it; any other library it uses must still be bundled. `docs/plugins/essentials.md`, `docs/ship/package.md`.

### Changed

- **Bundled plugins declare the SDK and `zod` only as development dependencies.** Their `package.json` files no longer list runtime `dependencies`, so each bundled plugin passes the same package check the installer applies to a ZIP, GitHub or collection install. Plugin authors list these two packages under `devDependencies` too: `docs/ship/publish.md`.

### Fixed

- **An agent guard reads its runtime's input bindings.** `ctx.inputs` was missing in a guard, so a guard could not see the upstream values its runtime declares in `io.inputs`.
- **`tabletop-rules` follows the instruction-language rule.** Its check instructions now follow `COVEL_INSTRUCTION_LOCALE` like every other bundled plugin, and attribute names resolve by language code (`ru` for a `ru-RU` session) through the SDK's `resolveI18nText`.
