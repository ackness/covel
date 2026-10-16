### Changed

- **`queryDimensionSnapshot` builds its model text without bookkeeping.** The `_text` it returns from `@covel/plugin-handlers-utils/dimensions` now selects paths and pages inside the `modelFacingJson` projection, as `world-dimension-get` already did, so a plugin tool that hands it to a model never shows a session ID, row UUID or write time. `results` keep the full values. Rule: [`world-dimension-get`](../reference/tools.md#world-dimension-get).
