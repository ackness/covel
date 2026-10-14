### Changed

- **A missing dependency turns its dependents off instead of refusing the game.** Turning off a plugin others need (say Pre-Game Setup, which Character Creator needs) no longer makes session creation fail with a contract name. The plugins that need it are turned off, the game starts, and they come back once the dependency is turned on again. Creation now fails only when a plugin the player asked for conflicts with another one, with `400 plugin_rejected` naming the plugin. Rules: `docs/reference/plugins.md` (session plugin selection).

### Added

- **The player is told which plugins are off and why.** The session prep screen lists the plugins a selection will turn off, what each one needs and which installed plugin provides it, with a button to turn that plugin on. The game screen does the same for the session's plugins that cannot run, in the player's language.
- **An explanation when no plugin tells the story.** When none of the enabled plugins writes narration, the session prep screen and the game screen say that turns will not tell a story and offer the installed narrative plugins, or point to Settings → Install & manage when none is installed.
