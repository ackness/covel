### Added

- **Agents can import other plugins' services as tools.** A plugin offers a read-only service to models by registering it with `modelFacing: true` and a `description`, and declaring it as `{contract, modelFacing: true}` in `contributes.services`. An agent lists the contract in `agent.tools.services` (optionally `{contract, as}` to name the tool), and the framework generates a read-only tool from the service's input schema when the runtime starts. Without exactly one active provider the tool is absent and the runtime runs as usual. Names, schema, time limit and failure answers: `docs/reference/tools.md` ("Imported service tools") and `docs/reference/plugin-extensions.md` ("Model-facing services").
- **Plugin tools can call services.** A tool's context has `services`, with the same discovery, approval, timeout and cycle rules as a function runtime's `ctx.services`. A service failure reaches the model as a tool error code; failures that are the provider's fault are marked as refused, keep the provider in the service trace, and do not count as a fault of the calling plugin (they do not pause the provider either).
- **`makeTestServiceRegistry` in `@covel/plugin-test-utils`** gives a tool test a real service registry. See `docs/plugins/testing.md`.

### Changed

- **Service call traces carry the tool call.** `plugin.service.completed` has `toolCallId` when a tool made the call, and `errorCode: input-validation` when the provider rejected the input. See `docs/reference/protocol.md`.
- **`pnpm plugin:extract` writes model-facing services as `{ contract, modelFacing: true }`**, and the registration check requires the declaration and the registration to agree on it.
