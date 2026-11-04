### Added

- **Function presentation runtimes read a bounded public-story projection and write only declared own display state.** Restricted contexts, proposal checks and fixed `presentation.completed` diagnostics explain missing story, assets, allowance or output.
- **Optional presentation generation runs after story commit without holding the next input.** Durable source-turn dispatch and media-unit allowances survive retries and requeues; commit-time destination checks keep newer display overrides, and queue saturation preserves stories and independent writes.

### Changed

- **Scene Stage 0.0.42 and Soundtrack 0.0.7 adopt zero-budget story-cue presentation.** Existing scene, presence, focus, day/night, music and explicit event overrides remain deterministic, with no added model charges.
- **Presentation retries retain their original source and remaining allowance; failed inline selectors recover from validated committed public story.** Kernel spend bookkeeping stays outside snapshots, forks and browser checkpoints and is deleted with its session.

### Upgrade notes

- **Discard queued or withheld presentation jobs created before the upgrade.** Jobs queued for earlier Scene Stage and Soundtrack versions and experimental presentation snapshots cannot be reused; recreate them. Ordinary story segments and display records remain current, and no database reset or migration is required.
