### Changed

- **Sub-agents count their own faults against the provider plugin's session fault latch.** Only the provider's own time limit counts as its timeout; committed successes clear its count. A paused provider returns `unavailable` and still participates in ambiguity checks.

### Fixed

- **Resumed runtimes refuse delegation to a provider paused in the session.** Admission is frozen at execution entry for both new turns and resumes.
