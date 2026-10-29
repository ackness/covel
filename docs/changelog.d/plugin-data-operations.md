### Added

- **A plugin can change plugin data with operations instead of a computed value.** `ctx.pluginData.update(namespace, key, ops)` in a function runtime, or a `plugin.data.update` proposal from a tool, submits `set` / `merge` / `inc` / `append` / `insert` / `remove` / `upsertItem` / `delete` operations. The kernel applies them to the latest stored value inside the commit transaction, so two concurrent `inc +1` both land; a failing list is rejected with `code: "data-op-rejected"` and the key keeps its value. In-execution reads project the same operations. See `docs/reference/transactions.md` (Operation-based writes).
- **Declared datasets are enforced at commit.** Every plugin-data write into a `contributes.datasets` namespace is checked against the dataset's `ops` (a whole-value write counts as `set`, a delete as `delete`) and its record schema; a violation, or a missing schema document, is rejected with `code: "dataset-violation"`. See `docs/reference/plugins.md` (Datasets).

### Changed

- **`overlayPluginDataValue` takes the stored value.** Its new last parameter `base` (`{ exists: false }` or `{ exists: true, value }`) is the key's stored value, and it returns `{ hit, exists, value? }`; `overlayPluginDataRows` takes optional stored `baseRows` as a fourth parameter. Composite tools that merge local proposals read the store first. See `docs/reference/tools.md`.
- **A write into a declared dataset namespace is validated.** A plain `ctx.pluginData.set` or `plugin.data` into a dataset whose `ops` exclude `set` is refused, and every written value must match the dataset schema.
