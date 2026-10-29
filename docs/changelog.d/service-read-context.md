### Added

- **Plugin services can read their provider's own data.** Service handlers receive session identity, locale, a separate world view, provider settings, and read-only plugin data with hidden namespaces filtered. Runtime calls include eligible upstream writes and record read dependencies through nested services; auxiliary callers follow rejected producers, while stories still commit and record a trace. Services cannot write or produce proposals. See the service context in `reference/plugin-extensions.md`.
