### Added

- **Runtimes can read this execution’s staged operations.** The `operations@1` kernel input provides a frozen snapshot from completed upstream runs to agents and functions. A reader depends on the operations it saw: when one of them does not commit, an auxiliary reader is dropped with it, and a story or setup reader commits and is traced.
- **Failed operations are visible to players and models.** A committed turn reports a fixed count notice to the player, without an execution error, and the calling agent receives failed operation summaries on its next player or continuation execution. A sub-agent that made the operation receives them the next time it is called.

### Changed

- **Service provider faults count toward pausing a plugin.** Provider crashes, invalid output and kernel import timeouts count; deliberate refusals and caller-chosen timeouts remain neutral. A clean call clears the streak only when its execution commits. Calls a setup runtime makes, directly or through a sub-agent, neither count nor clear.
