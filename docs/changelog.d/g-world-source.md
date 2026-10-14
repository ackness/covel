### Changed

- **The world record is the world; a package's files are only what it was installed from.** New sessions, the world-data preflight and `sync-data` / `sync-dimensions` now use the dimensions and the character schema of the world record, so dimensions saved in the world editor or imported on the session-prep screen reach new sessions and syncs for bundled, installed and generated package worlds too (before, a world with a package read them from its files and the edit had no effect). The characters, lorebook entries, plugin data and media under `data/` and `media/` are still read from the package. Rules: `docs/reference/world-data.md` ("World records and world packages").

### Fixed

- **Edits to a bundled, ZIP-installed, hand-placed or generated world survive a restart and a file change.** Only GitHub installs were marked `packageModified` when edited, so the startup seed and the file watcher silently replaced every other edited world with its files. Every world that came from a package is now marked, and the seed, file reloads, translations and updates keep the edited record.

### Added

- **"Restore the package version" brings an edited world back to its files.** The world's detail page shows that a package world was edited and offers the package version back (`POST /api/worlds/:id/restore-package`); after that the record follows its files again. Documented in `docs/reference/api.md`.
