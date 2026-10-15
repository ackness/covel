### Fixed

- **Deferred tool discovery describes both builtin and plugin tools.** The `search-tools` description identifies the calling plugin without attributing every tool to it.
- **Plugin diagnostics and debug commands use the shared locale resolver.** Compatible Simplified Chinese locales such as `zh-SG` now receive Chinese messages.
- **The memory backend reports the session's embedding lock consistently.** Locking and rebuilding an index update its model ID and lock time; clearing the index removes both, as on SQLite and PostgreSQL.
