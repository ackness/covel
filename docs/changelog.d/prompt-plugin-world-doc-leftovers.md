### Breaking

- **Five SSE event types that nothing emitted are removed from `CovelEvent`:** `interaction.completed`, `state.snapshot`, `record.updated`, `connection.restored` and `memory.updated`. A client that listed them must stop handling them; no server code ever sent them.

### Changed

- **A template variable inside a tagged block is XML-escaped, and world lore cannot close its own block.** In a prompt body, a `{{ ... }}` value that sits between a line starting with `<name>` and the matching `</name>` (for example `{{ world.description }}` inside `<world-summary>`) is escaped, so a closing tag in a name or a description cannot leave its block. In the `<world-lore>` block the kernel writes, only a `</world-lore>` inside the lore is rewritten; quote lines, comment markers and `&` in the lore read as written.
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
