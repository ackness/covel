### Fixed

- **Plugin data writes use the same rules for every plugin.** The management API now allows `PUT` and `DELETE` for active `kind: core` plugins, just as for other plugins. Reserved namespaces and inactive plugins remain protected. See `docs/reference/api.md`.
