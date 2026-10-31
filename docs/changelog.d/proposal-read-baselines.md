### Breaking

- **Pending development work needs current read evidence.** Cancel or recreate unresolved suspensions, pending or retryable runtime jobs, and checkpoints or snapshots containing previous pending proposals. Explicit retries recompute from current reads. Committed values, characters and completed sessions need no database reset or migration.

### Added

- **The host guards read-derived replacements against stale same-key data.** Explicit reads capture private content baselines, including absence, with separate invocation and provider-call scopes. Hooks cannot erase or redirect guards. Checks run at the serialized transaction mutation boundary and survive suspension and resume.

### Changed

- **Derived replacements can be rejected with `conflict`.** Guards include `merge`, `upsertItem` and delete, protecting an entire `inc` plus derived `merge` list. Pure relative lists and blind writes keep their existing semantics. Auxiliary conflicts discard their unit; a failed story-attached operation preserves story text and unrelated operations. Retries are explicit and conflicts do not increment plugin fault counts. Cross-key and phantom protection are excluded.
