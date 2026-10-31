### Added

- **Plugins can draw story paragraphs through segment templates.** A package lists display-only json-render specs under `contributes.ui.segment`; each has a required `match` by segment `kind`, speaker (character ID or name as written), or both. The chat view draws a committed story's matching segments through the most specific template (kind + speaker, then speaker, then kind; ties by the session's plugin order, then declaration order) and the rest as before. A template reads only the segment, its index, the resolved speaker's `{ id, name, type }` and visual; it uses only display components (no buttons, inputs, candidate lists or components that read session data) and cannot declare actions, plugin data or a webview, and one that fails to render falls back for its own segment. A story no template matches renders exactly as before. Rule: `docs/reference/ui-panels.md`.
- **`narrative.delta` carries live paragraph metadata.** For a story runtime with a declared output schema, each paragraph's first event carries `segment: { index, kind, speaker? }`, and a `kind` or `speaker` that arrives after the text is sent as one more event with empty text. The speaker is the name as written; prose stories carry no `segment`. Rule: `docs/reference/protocol.md`.

### Changed

- **Stage nameplates and the HUD speaker appear while the story streams.** They show each paragraph's speaker as the model wrote it as soon as it arrives, and are replaced by the resolved name (for example an alias by the character's current name) when the story commits.
