### Added

- **Repeated self-caused auxiliary plugin faults pause the plugin for that session.** Players see a fixed notice and can resume it from the plugin list. Story and dimension providers stay available; provider errors, cancellations and cascade failures do not count. Fault counts live only in memory and clear on restart. No development data needs to be recreated.

### Fixed

- **Service failures no longer pause an innocent caller.** Provider exceptions and service admission failures, including paused providers, retain their origin and do not count against the caller's fault latch.

- **Failed resumes count toward the session's fault latch.** Self-caused runtime failures are recorded before the resume route returns an error. Buffered writes stay uncommitted and the suspension remains unresolved.
