### Breaking

- **Players can no longer replace a character portrait during play.** The `character-blueprint` plugin's manual `presence` runtime, its `character-presence@1` contract and the portrait gallery's upload button are removed: a portrait comes from the world package (`media/presence.json`), and play does not edit game content. The `PortraitGallery` component no longer accepts `replaceAction`, and catalog actions no longer have an `upload` payload selector. Portrait records that a world imports are unchanged. A plugin that listed `character-presence@1` in `requires` must drop it.
- **Five SSE event types that nothing emitted are removed from `CovelEvent`:** `interaction.completed`, `state.snapshot`, `record.updated`, `connection.restored` and `memory.updated`. A client that listed them must stop handling them; no server code ever sent them.

### Changed

- **A template variable inside a tagged block is XML-escaped.** In a prompt body, a `{{ ... }}` value that sits between a line starting with `<name>` and the matching `</name>` (for example `{{ world.description }}` inside `<world-summary>`) is escaped, and so is the `<world-lore>` block the kernel writes, so a closing tag in world text or a character description cannot leave its block. Text with `<`, `>` or `&` reaches the model as `&lt;`, `&gt;`, `&amp;`; the bundled worlds' lore changes once for this and is stable from turn to turn after. Prose and variables outside such a block are unchanged (`docs/reference/prompt-structure.md`).
- **`{{ characters.npcs }}` and `characterSheetSegments()` give only a count for the profiles that do not fit.** The closing line says how many profiles are left out instead of naming every one of them.
- **`soundtrack` matches a track's scene names as whole names.** A name inside a longer word, or a longer scene name inside a shorter location, no longer plays the track ("Hall" is not "Great Hall"; "inn" is not in "Dunn"). The rule is the one `scene-stage` uses for a name inside a location.
- **`story-events` counts turns with `ctx.logicalTurn`**, the scheduler's frozen logical turn, instead of reading the session row, so a background run counts the turn it was started for.
- **The session-prep world document editor shows the same over-length note as the world page** when the draft is longer than the story prompt carries.
- **The `codex`, `affinity` and `guide` prompts** use examples from more than one genre and no longer name other plugins or "working memory".

### Fixed

- **Bundled world translation files hold only translated text.** The `.en-US` files of `lantern-barrow` and `mistport` no longer copy structure (insertion order, enabled flags, conditions, attributes, tags) from the main files; changing the main file no longer leaves a stale copy behind. The merged result is identical.
- **`role:*` preference tags are gone from the bundled worlds' plugin policies**, since no plugin declares them.

### Documentation

- **`docs/reference/protocol.md` and `api.md` list only events that are emitted.** `docs/reference/world-data.md` says that `media/portraits.json` and `media/scenes.json` are read only by the art generation scripts.
- **The flow page points to `docs/architecture/packages.md`** for package responsibilities instead of repeating them.
- **Guides use `contributes.tools` and `pnpm e2e:verify`** where they named `tools.plugin` and `npx tsx scripts/e2e-plugin-verify.ts`.
- **The 0.0.19 section of the changelog has its heading and link again**, with the missing links of 0.0.32 to 0.0.35.

### Upgrade notes

- **Bundled plugin versions changed.** `codex`, `affinity`, `guide`, `soundtrack` and `story-events` have new versions; setup completion is recorded per plugin version, so a development session recreated or continued on the old versions re-runs setup guards (they skip finished work).
