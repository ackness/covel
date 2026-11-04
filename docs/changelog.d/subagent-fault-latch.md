### Changed

- **Sub-agents count their own faults against the provider plugin's session fault latch.** Only the provider's own time limit counts as its timeout; committed successes clear its count. A paused provider returns `unavailable` and still participates in ambiguity checks. A resumed runtime also refuses delegation to a provider paused in the session; admission is frozen at execution entry for new turns and resumes.
