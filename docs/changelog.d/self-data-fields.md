### Added

- **`io.selfData[].fields` chooses which record fields an agent sees, and in what order.** Leave out display-only fields and put what matters first, since the `summary` format cuts each entry at 200 characters. Values that are not objects are shown whole; read baselines and tools still see the complete value. Reference: [plugins](../en/reference/plugins.md#ioselfdata).

### Fixed

- **The affinity tracker sees each NPC's last reason and history again.** Its `<existing-affinity>` rows were filled with the panel's bar value and colours, which pushed the reason out of the truncated summary. It now lists name, score, tier, last change, reason, notes and history.
