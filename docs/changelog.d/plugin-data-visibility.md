### Changed

- **Plugin-data reads include completed upstream runtimes of the same plugin.** Within one execution, `ctx.pluginData.get/list`, `ctx.store.getPluginData/listPluginData` and tool `context.store` reads now apply the uncommitted writes of earlier, commit-eligible runtimes of the reader's own plugin, in commit order, before the reader's own buffered writes; `ctx.pluginData.update` checks its operations against that view. Other plugins, siblings of the same DAG level, retry and detached seeds and a parent's upstream inside a nested execution stay invisible. Rule: `docs/reference/plugins.md` (in-execution plugin-data visibility).

### Added

- **A runtime that read a dropped runtime's data is dropped with it.** Each read records which upstream writes it saw. When such a write is dropped at commit, an auxiliary reader is dropped too (`read data of <runtime> that did not commit`), and the drop reaches its hard dependents and readers of its writes. A story or setup runtime still commits, and the trace records a `read-dependency.kept` row. Rule: `docs/reference/transactions.md`.
