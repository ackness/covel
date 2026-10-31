### Added

- **Write services let one plugin change another plugin's data in the same turn.** A service declared and registered with `access: write` gets `ctx.pluginData` with `set`, `delete` and `update` over its own data, plus `random` and `turnId`, and no model or HTTP access. A call from a function runtime, a plugin tool, an imported tool or a sub-agent stages its writes as one operation on the calling run, which commits with the caller and with the provider's identity. Calls from detached, background and resumed runs, scoped retries, guards, hooks, RPC handlers, extension providers and agents that can suspend answer `unavailable`, and a plugin cannot call its own write service. See `docs/reference/plugin-extensions.md`.
- **Story-attached operations stand or drop alone.** Each operation of the story's commit unit commits in its own savepoint after the unit's writes: a rejected one is dropped with all its writes while the story commits. A rejected operation drops an auxiliary caller with its writes, and rolls back an execution without a story. See `docs/reference/transactions.md`.
- **Turn results list each write-service operation and how it ended.** `runtimeResults[].operations` on `turn_results` (and `GET /api/sessions/:id/turns`) holds a model-facing record of every operation, settled to `committed`, `failed` or `discarded` with a reason in the commit transaction. No schema change.
- **`callTestService` tests a write service without a turn.** `@covel/plugin-test-utils` calls a service as another plugin and returns its output and the operations it staged; `makeTestServiceRegistry` accepts `access`. See `docs/plugins/testing.md`.

### Changed

- **The capability snapshot shows write services.** A write service is recorded as `<contract> (write)`, so a trusted-source package that adds one or turns a service into one asks for approval again. See `docs/reference/plugin-installation.md`.
- **Operation writes that conflict at commit report `conflict`.** An `update` in a write-service operation that no longer fits the stored value fails with the code `conflict` instead of `data-op-rejected`, and does not count toward pausing a plugin.
