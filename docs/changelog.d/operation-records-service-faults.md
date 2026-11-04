### Added

- **Runtimes can read this execution’s staged operations.** The `operations@1` kernel input provides a frozen snapshot from completed upstream runs to agents and functions. Like other reads, it records a read dependency: a reader of an operation that does not commit follows the rule for dropped producers. A retried runtime also sees the source turn's committed operations, read-only, so it does not apply them again.
- **Service handlers receive their provider's message catalog.** Read and write services can use the same translation and multilingual label helpers as function runtimes.

### Changed

- **Service provider faults count toward pausing a plugin.** Provider crashes, invalid output and kernel import timeouts count; deliberate refusals and caller-chosen timeouts remain neutral. A clean call clears the streak only when its execution commits. Calls a setup runtime makes, directly or through a sub-agent, neither count nor clear.
