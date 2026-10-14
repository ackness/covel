### Changed

- **A world starts even when something it relies on is missing.** A contract the world requires (`pluginPolicy.requires`) with no provider, or with several and none chosen, no longer stops session creation with `400 world_requirement_unmet`: the session starts without that part, the session-prep screen says what is missing instead of turning the start button off, and the response lists it in `unmetRequirements`. Documented in `docs/reference/api.md` and `docs/reference/world-data.md`.

### Fixed

- **A world with dimensions can be played without a dimension plugin.** When no active plugin provides `world.dimensions@1`, creating a session failed with a server error ("Dimension provider unavailable"), and so did the world-data preflight and sync. The dimensions are now left out: the session starts without them, the response lists them in `ignoredDimensions`, the preflight and the session-prep screen warn (`dimension-provider-missing`), and a sync keeps the dimension records the session already has.
