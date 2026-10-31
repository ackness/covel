### Changed

- **Pending data-receiver approvals stay separate from explicit plugin requests.** Inferring a receiver does not submit it as a player selection; world and player requests retain their existing approval flow.

- **Live plugin changes preserve world provider choices.** Unrelated switches do not add new core defaults or replace an unavailable world provider. Presentation packages require a gameplay or player selection; seed assets alone do not enable them.

- **Development session selections now freeze inferred data requirements.** Recreate sessions and recordings that assumed the previous receiver set and reimport modified world copies. Database structures and existing player rows are unchanged.

- **Worlds select gameplay through one ordered `plugins` field.** Prefixed pack, plugin and contract references share one interpretation across validation, preparation and collections. The first pack selects the initial mode; alternatives remain available, independent requests survive pack changes, and manual exclusions win. Missing optional features produce notices and play can start.
- **Breaking: the authored `pluginPolicy` field and its `preset`, `plus`, `packs` and `requires` fields are removed.** Presentation overrides move to `pluginPitch`; the plugin-plan API returns `selection` and bounded diagnostics. Recreate development worlds and sessions.

### Added

- **World content selects its data receivers automatically.** Enabled files, character extensions and portable records request accepted data contracts independently of gameplay capabilities. A unique eligible receiver joins automatically; ambiguity, exclusions and approval remain player choices. Unknown structured files receive an actionable author warning.
- **Players see safe explanations for omitted world data.** Hidden source identities and errors stay private, and unreceived conventional sources preserve their managed records during sync.

- **World introductions default to public name, summary and tags.** Optional `pluginPitch` fields override each value independently, with locale resolution at display time. Revisions preserve edits and removals, resolving translated pitch to the world's content language before writing authored YAML. Derived text never reads private lore and is never saved as authored data.
