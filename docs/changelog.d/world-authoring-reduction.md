### Changed

- **Worlds select gameplay through one ordered `plugins` field.** Prefixed pack, plugin and contract references share one interpretation across validation, preparation and collections. The first pack selects the initial mode; alternatives remain available, independent requests survive pack changes, and manual exclusions win. Missing optional features produce notices and play can start.
- **Breaking: the authored `pluginPolicy` field and its `preset`, `plus`, `packs` and `requires` fields are removed.** Presentation overrides move to `pluginPitch`; the plugin-plan API returns `selection` and bounded diagnostics. Recreate development worlds and sessions.

### Added

- **World introductions default to public name, summary and tags.** Optional `pluginPitch` fields override each value independently, with locale resolution at display time. Revisions preserve edits and removals, resolving translated pitch to the world's content language before writing authored YAML. Derived text never reads private lore and is never saved as authored data.
