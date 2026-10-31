### Added

- **Runtimes can read this execution’s staged operations.** The `operations@1` kernel input provides a frozen snapshot from completed upstream runs to agents and functions.
- **Failed operations are visible to players and models.** A committed turn reports a fixed count notice to the player, and the calling agent receives failed operation summaries on its next player or continuation execution.

### Changed

- **Service provider faults count toward pausing a plugin.** Provider crashes, invalid output and kernel import timeouts count; deliberate refusals and caller-chosen timeouts remain neutral. A clean call clears the streak only when its execution commits.
