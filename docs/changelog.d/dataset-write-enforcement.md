### Added

- **Dataset destination rules also cover plugin action and command RPC writes, world imports and syncs.** Registered package declarations apply even without runtimes. Prepared imports retain captured schemas and validate final media records and UTF-8 JSON size before persistence.

### Changed

- **World seeding and replacement require `set`; true managed removals require `delete`.** Replacements use the physical plugin, namespace and key, so changing a source target URI (including toggling `+lorebook`) does not require `delete`. `force` cannot bypass dataset rules. Invalid optional projection outputs are deferred as a whole, preserving older managed records. Inventory and affinity permit removal of world-seeded records.
- **RPC writes remain immediate per call.** Refused records stay unchanged, earlier successful calls remain persisted, and uncaught refusals retain the existing production-safe error response. Management plugin-data PUT and DELETE remain authorized operator overrides. Existing data is not scanned or rewritten.
