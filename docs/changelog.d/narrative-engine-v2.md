### Breaking

- **The narrative contract is now `narrative-engine@2`, and a story is a list of segments.** A story runtime returns `segments` (`narration`, `dialogue` or `action`, each with optional `speaker` and its `text`), optional `cues` and `yield`. The kernel derives `narrativeOutput` (the segment texts joined by blank lines), so consumers that select `/narrativeOutput` only change the contract ID from `narrative-engine@1` to `narrative-engine@2` in `requires`, `needs` and `from`. Schema-less stories submit `narrativeOutput` through the host default and become one narration segment per paragraph; an agent with a declared segments schema must satisfy it. Rule: `docs/reference/plugins.md`.
- **`stage.dialogue@1` and the `dialogue` field of `stage.direction` are removed.** The stage reads each paragraph's nameplate from the committed story's segment speakers. A `stage.direction` event now needs at least one cue. Plugins that provided the slot or emitted the field must drop them. Rule: `docs/reference/ui-panels.md`.
- **The narrators' "Narrative person" setting is replaced by "Perspective".** `narrativePerson` (`first`, `second`, `third`) becomes `perspective` (`character-first`, `character-second`, `character-third`, `omniscient`, `dm`; default `character-second`). `omniscient` narrates in the third person with no player line and rejects "I" and "you" in narration; `dm` addresses the players and skips the pronoun check while keeping the tag check. An earlier choice is not carried over; choose again in the plugin settings. A plugin that uses `createNarrativeReview` must rename its own setting key to `perspective` with these values, or the perspective check silently stops applying.

### Added

- **Story segments carry speakers.** Both bundled narrators ask for segments through `io.output.schema: contract:narrative-engine@2`. Speakers and `cues.present` are written as names; at commit the kernel resolves them to characters by exact name or alias, and `/messages` and `/view` return `segments` with the character's current name and `speakerId`. `narrative.completed` carries the same `segments`, so a turn shows its nameplates as soon as it is committed. A name that matches no character, or more than one, stays as written and is listed in `narrative.completed.unresolvedSpeakers`. A quotation inside a named speaker's line (after a colon, or in 『』) is not read as narration when the perspective is checked, while narration around a quote still is. Rule: `docs/reference/api.md`, `docs/reference/protocol.md`.
- **Story messages record who was present.** Each committed story keeps its resolved speakers and `cues.present` characters as presence metadata, ready for per-character history later.

### Changed

- **Stage nameplates and the HUD speaking marker come from the story.** The nameplate of each paragraph is its segment's speaker, and the HUD marks the speaker of the last attributed segment.

### Upgrade notes

- **Recreate narrative-contract data from before the upgrade.** Reload updated narrative contracts, reselect the Perspective setting and re-record local story captures; recreate suspended agent runs as described in the `submit-output` entry. Compatible committed messages remain readable, but older text without segment presence cannot supply stage nameplates. No blanket database deletion or store schema conversion is required.
