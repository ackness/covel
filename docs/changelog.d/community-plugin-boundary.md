### Security

- **`permissions.http` covers a community package's entry code.** `covel.http` in tools, hooks, RPC, form validators, services, extensions and wires reaches only the origins and methods in the `permissions.http` of the root `PLUGIN.md` and of its runtimes; a wire may also reach the endpoint of the slot it serves. A service or extension handler's `context.utils` is checked against the provider's package, not the caller's. Builtin packages are not checked, as for runtimes. See `docs/internals/security.md`.
- **Media wires serve only sessions that enable their plugin.** Image, speech, transcription and music wires a plugin registers follow the same rule as text wires; generation outside those sessions fails with a configuration error that names the plugin to enable.
- **`framework` is a reserved plugin ID.** A package with `id: framework` no longer loads or installs, and `pluginId: "framework"` in plugin-rpc reaches only framework default actions. A plugin ID no longer falls back to a framework default action of the same name.

### Added

- **Root `permissions.http` in `PLUGIN.md`.** A package whose entry code calls an outside service declares the origin there. See `docs/reference/plugins.md`.

### Upgrade notes

- A community package whose entry code calls `covel.http.fetchWithRetry` must list the origins it calls under `permissions.http` in its root `PLUGIN.md` (or in a runtime); undeclared requests now fail with `http permission denied`.
