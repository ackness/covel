### Changed

- **A save keeps the plugins the player confirmed.** The plugin list, the slash commands and the executor now read one set: the session's `activePlugins`, checked against the installed versions. A plugin installed later, a `core` one included, no longer joins an old save, and the list no longer shows a plugin as enabled when it does not run (or offers a command that then answers `command_not_active`). A development hot reload no longer rewrites `activePlugins` either. To recompute the set from the installed plugins, enable or disable a plugin. Rules: `docs/reference/plugins.md` (session plugin selection).

### Added

- **A notice for plugins a save cannot run.** When a confirmed plugin is not installed, failed to load, or its installed version lacks a provider or conflicts with another member, the game screen names it and play goes on without it. `GET /api/sessions/:id/plugins` lists them in `unavailable`. Such a plugin is off everywhere: no runtime, hook, service, action, form validator, panel or memory search reaches it, and a direct call to one of its actions returns `404 plugin_not_active` with the reason.
