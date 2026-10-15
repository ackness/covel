### Changed

- **The prep screen names plugin tags and summarizes world data in the player's words.** The derived tags show as "Calls a model", "No model calls", "Side panel", "Message cards" and "Player actions" instead of `cost:llm` or `ui:manual-action`, in the filter chips, the group headings and the plugin badges. The world-data section counts what will be imported (characters, lore entries, images, plugin records) instead of listing storage addresses.
- **Turning one plugin on or off says what else moved.** When the switch also turned on a provider another plugin needs, or turned off a plugin that conflicts with the one chosen, a short notice names them and says why.
- **The prep screen survives a reload of the tab.** The world being prepared is remembered for the tab; opening the app anew still starts on the world list.
- **World-data notices carry a code.** `worldDataNotices` items of `POST /api/sessions` and the import after a plugin is turned on have an optional `code` (`dimension-provider-missing`, `receiver-missing`); the game screen says those in the interface language and folds any other English message under "Details". `docs/reference/api.md`.
- **A refused toggle names the provider that must stay on.** The `409 dimension_provider_required` response has `details.pluginId` and `details.displayName`, and the toast names that plugin. A refusal the app knows no longer prints the raw response under the toast.

### Fixed

- **A plugin pack chosen after "Back to the minimal set" gets its plugins back.** The minimal set excluded the pack's plugins for good, so choosing a pack afterwards left them off.
- **World lists name each world in the edition the player gets.** The showcase, the other list layouts and the delete and language dialogs showed a world's own language (an English interface showed the Chinese names of worlds that have an English edition).
- **The world detail page shows dimension values in the play language.** Values kept as locale maps printed every language, booleans and empty values printed `false` and `null`, and dimension names ignored the play language. Its update note no longer tells the player to open the page they are on.
- **Skipped tasks say why in words.** The turn's task list printed codes such as `upstream-failed`; the needs gate now reports that code like the input gate, and the app translates every gate code.
- **Approval dialogs name the plugin.** Turning on a community plugin asked "Plugin qa-broken requests to run covel:plugin-server-code"; every approval now names the plugin by its display name, and the server-code approval explains what it allows.
- **The World item of the top bar leaves world details and the dimension editor.** It did nothing there; the editor asks first when it has unsaved changes.
- **A world whose package changed on disk shows its update without a reload.** The world list is fetched again when the player comes back to it and when the window regains the focus.
- **An interjection stays where the turn saves it.** It showed below the streaming story text and, after a reload, above it; it now goes above it at once, and the text written after it starts a new paragraph while it streams.
- **Lists in player text use the interface language's separators**, and the session hints no longer show contract IDs such as `world.dimensions@1`. The hint for installing a plugin ZIP says where `PLUGIN.md` goes. A plugin's name on the prep screen is no longer cut short by its badges, dimension tables in the narrow side panel scroll instead of squeezing a column to one character per line, and the Russian language notice reads correctly.
