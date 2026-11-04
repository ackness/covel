### Breaking

- **Hand-built `ToolModule` objects must provide all four boolean annotations.** Use the SDK's `tool()` factory to receive safe defaults, or supply `readOnly`, `stagesWrites`, `idempotent` and `concurrencySafe` explicitly. Plugins already using `tool()` need no changes. No stored development data needs recreation.
- **A runtime that declares a tool its package never registers now fails before its first model call.** This covers a plugin tool in a runtime's tool declarations (deferred declarations included) that the package does not register, and a framework tool name that matches no builtin factory. Remove the declaration or register the tool. Missing builtin host capabilities remain optional and only produce a warning. No stored development data needs recreation.

### Added

- **Tools declare annotations and optional per-call timeouts.** The executor reports `TIMEOUT`, revokes late work, and rejects proposals or domain events returned by read-only tools.
