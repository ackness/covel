### Breaking

- **Hand-built `ToolModule` objects must provide all four boolean annotations.** Use the SDK's `tool()` factory to receive safe defaults, or supply `readOnly`, `stagesWrites`, `idempotent` and `concurrencySafe` explicitly. Plugins already using `tool()` need no changes. No stored development data needs recreation.

### Added

- **Tools declare annotations and optional per-call timeouts.** The executor reports `TIMEOUT`, revokes late work, and rejects proposals or domain events returned by read-only tools. Framework tool names are checked against the actual builtin factories.
- **Missing declared plugin tools fail the runtime before its first model call.** Deferred declarations receive the same check; missing builtin host capabilities remain optional and produce a warning.
