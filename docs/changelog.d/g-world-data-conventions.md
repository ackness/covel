### Breaking

- **A plugin can no longer name a kernel or world-package path as its data file.** `contributes.data.<ns>.authoring.source.path` rejects `world.yaml`, `WORLD.md`, `data/world.data.yaml`, `data/dimensions.yaml`, `data/lorebook.yaml`, `characters/characters.json`, `media/gallery.json`, `media/portraits.json`, `media/scenes.json`, `media/gallery/` and their language versions, in any case. A manifest that names one fails to load; pick another path. Rules: `docs/reference/world-data.md`.

### Fixed

- **A world without a descriptor is read by the plugins its session runs.** Before, any installed plugin, even one that failed to load or was never enabled, could make a conventional file such as `data/quests.yaml` stop being imported for every world. Now only the session's active plugins count. When two of them name the same file, the session still starts without it, the server logs a `[sessions]` warning and the world data preflight returns a `convention-collision` warning.
- **`pnpm validate:world` checks a world against the plugins a new session starts with.** A source whose receiving plugin is not enabled by default gets an `unrequested-receiver` warning, and a file that several scanned plugins name gets `convention-collision` (an error when a default session enables two of them). Records are still checked against every scanned plugin.
