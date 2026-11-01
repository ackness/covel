### Changed

- **World data no longer adds setup to a composition without preparation.** Narrative Only can begin bundled adventures without an inferred setup step waiting for an excluded feature. Selected setup flows retain their data receivers and completion rules; omitted data still produces a notice. See [world data](../en/reference/world-data.md#data-receivers).
- **Unfinished setup is explained even when no messages were produced.** After an attempt with no pending interaction, the game shows how to continue setup or disable the waiting plugin. See [setup control](../en/reference/api.md#setup-runtime-control-retry--skip).
