### Breaking

- **`overlayPluginDataValue` takes the stored value.** Its new last parameter `base` (`{ exists: false }` or `{ exists: true, value }`) is the key's stored value, and it returns `{ hit, exists, value? }`; `overlayPluginDataRows` takes optional stored `baseRows` as a fourth parameter. A plugin that calls it (composite tools merging local proposals) must read the stored value first, pass it as `base` and read `exists` / `value` from the result; a four-argument call no longer type-checks. See `docs/reference/tools.md`.

### Added

- **A plugin can change plugin data with operations instead of a computed value.** `ctx.pluginData.update(namespace, key, ops)` in a function runtime, or a `plugin.data.update` proposal from a tool, submits `set` / `merge` / `inc` / `append` / `insert` / `remove` / `upsertItem` / `delete` operations. The kernel applies them to the latest stored value inside the commit transaction, so two concurrent `inc +1` both land; a failing list is rejected with `code: "data-op-rejected"` and the key keeps its value. In-execution reads project the same operations. See `docs/reference/transactions.md` (Operation-based writes).

### Fixed

- **An asynchronous JSON Schema no longer passes every value.** A schema with `$async: true` (a runtime input or output schema, an export schema or a dataset record schema) used to read its validator's Promise as success. Such a schema is now treated like one that does not compile: a dataset write is rejected with `code: "dataset-violation"`, and other checks fail instead of passing.
