### Changed

- **Bundled plugins follow the acting character.** Character notes, character creation, dice checks, inventory, memory and tabletop rules use the action’s actor, falling back to the primary seat’s current character, instead of the first player character. Other player characters remain included in roleplay notes, recall names and taken names. See `docs/reference/world-model.md`.

### Added

- **The SDK exports `actingCharacterOf`.** Plugins can resolve the first existing actor of a player action, falling back to the primary seat’s current character. Detached jobs can pass their source turn’s actions. See `docs/plugins/local-code.md`.

### Fixed

- **The execution list keeps one entry per runtime run.** Nested runs no longer overwrite the outer run’s status in live events or recovered history. The displayed chip keeps failures and active runs visible. Existing browser cache rows remain readable; no development data needs to be recreated.
