### Breaking

- **The data schema is version 7: recreate development databases and browser saves.** Sessions gained a NOT NULL `seats` column. A SQLite or PostgreSQL database recorded with version 6 is refused at startup (`StoreSchemaVersionError`), and a browser checkpoint or snapshot without `session.seats` fails validation. Back up and start a new database, and recreate browser-private sessions. See `docs/internals/storage.md`.
- **A session may have several `type: player` characters.** World model validation, `create-character` and world import no longer reject a second player. The character the story follows is the current character of the primary seat, not the first `type: player` character. `characterSheetSegments` shows a `<player-character>` sheet only for the `currentCharacterId` it is given, and lists every other character, player characters included, in `<character-profiles>`; a plugin passes `currentCharacterOf(primarySeat(ctx.world.seats), ctx.world.characters, ctx.world.seats)?.id`. `createNarrativeReview` reads the player from the new `PostContextAssembly` field `currentCharacterId`. See `docs/reference/world-model.md`.

### Added

- **Sessions have seats.** `session.seats` records who plays (a human or an empty seat), in which role (player, host or spectator), which characters they control and which one is current. Every new session has one human player seat that binds every `type: player` character, so single-player play is unchanged. Plugins read the seats as `ctx.world.seats`, tools as `context.world.seats`, and the SDK exports `seatCharacterIds`, `currentCharacterOf` and `primarySeat`. See `docs/reference/world-model.md`.
- **`PATCH /api/sessions/:id/seats/:seatId` switches the current character.** The body is `{ currentCharacterId }`; the character must be bound to that human seat. The switch runs under the session lock and applies from the next turn. The game view has no switch control yet. See `docs/reference/api.md`.

### Upgrade notes

- **Bundled plugins other than the two narrators still pick the first `type: player` character.** The inventory ledger, tabletop rules, dice checks, memory, character creation, scene stage and character blueprint plugins act on the first player character when a session has several, until they move to seats.
