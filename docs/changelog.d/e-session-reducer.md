### Fixed

- **Long sessions keep bounded state-patch caches and asset progress.** Only the latest field values are retained, and state panels still refresh for every new change (F-058).
- **Loading older messages skips client-clock echoes when choosing the cursor.** Recovered server messages replace local timestamps (F-063).
- **Rejected input stays separate from later actions.** Local echoes receive a turn only from their own request (F-064).

### Upgrade notes

- **Clear old development browser display caches after upgrading.** The state-patch cache now stores bounded field values and recent event IDs. Save checkpoints are unchanged.
