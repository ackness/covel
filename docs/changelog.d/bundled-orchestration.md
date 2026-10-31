### Breaking

- **Dialogue runtime targets move to `chat-mode-narrator/narrate`.** Reselect model overrides and preparation bindings targeting the old inline runtime. Discard its pending suspensions, saved retry jobs and checkpoints containing that work, or recreate affected test sessions. Old committed stories remain readable; the new optional `latest-story` export begins with the next committed story, without backfilling. Ordinary Narrator sessions and the database need no reset.

### Added

- **Optional character actors and selectable policy strategies support ensemble play.** Turn Policy provides one code-only service with mention, list, random, manual and director strategies. Choose actors accepts exact names or aliases on separate lines. Missing providers and failed actors leave narrator-only play available.
- **New sessions can start as Player, Game master or Spectator.** The creation-only role selector preserves existing player defaults and leaves other roles unbound. In-game roles grant no server authorization.
- **DM Mode, Ensemble Dialogue and Spectator compositions join the pack catalogue.** Packs remain plugin lists and default views; role, narrator perspective and policy strategy are independent choices.

### Changed

- **Dialogue narration prepares a policy once, then delegates inside the story agent.** Successful public actor segments retain plan order; this bundled consumer dispatches sequentially, including parallel advice. Private intent is discarded. Only committed story yield requests bounded host advancement.
- **Orchestration groups policy selection and all three limits.** A sole provider resolves automatically with its name and settings link; multiple providers offer a selector, and stale selections can be cleared. Independent field saves use their existing routes and preserve failed drafts and successful saves. Live advancement and Stop remain in every game view.
- **Preparation waits for plugin defaults before accepting selection edits.** Plugin switches and pack controls stay disabled while the plugin plan loads, so its defaults cannot overwrite a player's exclusions.
- **Translated standalone plugin prompt pairs share the existing fingerprint lock.** Existing English/Chinese pairs under plugin prompt directories participate without requiring translations for unrelated unpaired templates.

### Upgrade notes

- **Choose a different seat role by creating a new session.** Existing seats are unchanged. Refresh local dialogue/delegate model recordings if used. Keep the existing instruction to discard unresolved delegated suspensions and their checkpoints created before delegation-budget snapshots; no whole database or world reset is required.
