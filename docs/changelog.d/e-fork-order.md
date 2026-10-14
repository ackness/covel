### Fixed

- **Forks preserve the parent conversation’s message order.** Messages written in the same millisecond keep their write order across repeated forks and browser checkpoint pagination, instead of being re-sorted by random IDs.
