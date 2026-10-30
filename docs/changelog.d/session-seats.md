### Breaking

- **Sessions require player seats in saved data.** Sessions gained a NOT NULL `seats` column. Recreate development databases as described in the kernel state table removal entry. A browser checkpoint or snapshot without `session.seats` fails validation; recreate browser-private sessions that lack seats. See `docs/internals/storage.md`.
- **A session may have several `type: player` characters.** World model validation, `create-character` and world import no longer reject a second player. The character the story follows is the current character of the primary seat, not the first `type: player` character. `characterSheetSegments` shows a `<player-character>` sheet only for the `currentCharacterId` it is given, and lists every other character, player characters included, in `<character-profiles>`; a plugin passes `currentCharacterOf(primarySeat(ctx.world.seats), ctx.world.characters, ctx.world.seats)?.id`. `createNarrativeReview` reads the player from the new `PostContextAssembly` field `currentCharacterId`. See `docs/reference/world-model.md`.

### Added

- **Sessions have seats.** `session.seats` records who plays (a human or an empty seat), in which role (player, host or spectator), which characters they control and which one is current. Every new session has one human player seat that binds every `type: player` character, so single-player play is unchanged. Function runtimes, guards and extension providers read the seats as `ctx.world.seats` (every extension call site, including the image flow and history compaction), tools as `context.world.seats`, and the SDK exports `seatCharacterIds`, `currentCharacterOf` and `primarySeat`. See `docs/reference/world-model.md`.
- **`PATCH /api/sessions/:id/seats/:seatId` switches the current character.** The body is `{ currentCharacterId }`; the character must be bound to that human seat. The switch runs under the session lock and applies from the next turn. The game view has no switch control yet. See `docs/reference/api.md`.

### Upgrade notes

- **Scene Stage still picks the first `type: player` character.** Its cast and direction filters use the first player character when a session has several, until the plugin moves to seats.
