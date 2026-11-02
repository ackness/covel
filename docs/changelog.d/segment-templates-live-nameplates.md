### Added

- **Plugins can draw story paragraphs through segment templates.** A package lists display-only json-render specs under `contributes.ui.segment`; each has a required `match` by segment `kind`, speaker (character ID or name as written), or both. The chat view draws a committed story's matching segments through the most specific template (kind + speaker, then speaker, then kind; ties by the session's plugin order, then declaration order) and the rest as before. A template reads only the segment, its index, the resolved speaker's `{ id, name, type }` and visual; it uses only display components (no buttons, inputs, candidate lists or components that read session data) and cannot declare actions, plugin data or a webview, and one that fails to render falls back for its own segment. A story no template matches renders exactly as before. Rule: `docs/reference/ui-panels.md`.

### Changed

- **Stage nameplates and the HUD speaker come from committed segments.** They use the resolved name supplied with the durable story.
