### Breaking

- **The plugin view field `surface` (`main` / `composer`) is removed.** There is one kind of plugin page, and the host input box now appears below every page by default. A page hides it with the optional `composer: false`, or by embedding `SessionComposer` (no field needed). A spec that still declares `surface` gets no special treatment; delete the field. Plugin views have not shipped in a release, so no saved data needs recreation.

### Changed

- **The black control strip under the session header is gone.** Plugin pages are chosen from the header’s “Plugin pages” menu, which lists each page with its plugin name. The Text and Stage toggle leaves a page; there is no separate “back to default” button, input-box selector or per-region retry strip. The consent prompt’s decline button reads “No thanks”.
- **Stop stays reachable on pages without the host input box.** While a turn runs and a page hides the host input box, the header shows “Stop” beside the busy indicator.
- **A page that fails to load returns to the read view with a notice.** Choosing the page again retries with a fresh frame after the current consent is checked. Pages keep a usable minimum height on phones, and normal document unload is not reported as a page error.
- **The relationship graph and codex no longer duplicate their right panels as pages.** Use “Expand panel” for a larger view.
