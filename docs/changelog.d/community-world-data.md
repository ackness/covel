### Fixed

- **A community plugin approved after the game starts gets the world's data.** Session creation skips the world data that only a plugin waiting for approval receives. Enabling a plugin in the game now imports that data once for the plugins that just joined, and leaves the other plugins' data and anything the game changed alone. A community plugin's world projection runs then, with its approval. Reference: `docs/reference/world-data.md`.

### Added

- **The game screen says which world data is missing.** The create-session response lists the world data that was not imported (`worldDataNotices`), and the game screen shows it, with a note that the data arrives when the plugin is turned on. Enabling a plugin returns what it imported (`worldData`), and the notice is updated.
