### Changed

- **Inventory, affinity and world-time record their counters with operations and declare datasets.** Concurrent changes to a quantity, a score or the clock tick add up instead of overwriting each other; each record is validated against its schema when saved. Players see no change. Dataset rules are documented in `docs/reference/plugins.md`.
