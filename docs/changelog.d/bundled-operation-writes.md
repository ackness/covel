### Changed

- **Inventory, affinity and world-time record their counters with operations and declare datasets.** Concurrent changes to a quantity, a score or the clock tick add up instead of overwriting each other; each record is validated against its schema when saved. Players see no change. Dataset rules are documented in `docs/reference/plugins.md`.

### Upgrade notes

- **Check records that worlds or plugins write into Inventory, Affinity and World Time.** Those plugins now declare datasets, so a record written into their namespaces must satisfy the dataset's allowed operations and record schema; a violating record is rejected at commit or import. Existing stored data is not scanned or rewritten. See [plugin reference](../en/reference/plugins.md).
