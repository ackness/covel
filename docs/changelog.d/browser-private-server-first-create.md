### Fixed

- **A new browser-private save keeps its plugins and opening data even when it is edited before its first sync.** A save used to start as an empty browser-made checkpoint that the server recognised as "new" only by its revision number; a local change before the first successful sync (for example after closing the page mid-creation and editing the world) made the server replace its own initialization with that empty save. The server now creates and initializes the session first, and its first export (`browser-commit` with `baseRevision: 0` and the `local:create:<id>` action) becomes the save's revision 1, so every later upload is an ordinary full replacement. Rule: `docs/reference/api.md`.

### Upgrade notes

- **Browser-private development saves that never completed a first sync must be recreated.** They no longer get special treatment and upload as ordinary saves without the server's initialization.
