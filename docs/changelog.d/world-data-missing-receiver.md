### Fixed

- **Worlds start even when their data receivers are not installed.** Session creation, preflight and later imports or sync skip those sources with warnings through the existing world-data notices. Their schemas and media are skipped too, while other data imports normally. Author validation keeps its existing error rules. See [World data](../en/reference/world-data.md#contract-resolution-and-preflight).
