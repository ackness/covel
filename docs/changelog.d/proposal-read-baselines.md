### Breaking

- **Pending development work needs current read evidence.** Cancel or recreate unresolved suspensions, pending or retryable runtime jobs, and checkpoints or snapshots containing previous pending proposals. Explicit retries recompute from current reads. Committed values, characters and completed sessions need no database reset or migration.

### Added

- **The host guards read-derived replacements against stale same-key data.** Explicit reads capture private content baselines, including absence, with separate invocation and provider-call scopes. Own data injected through `io.selfData` also counts as reads when the agent holds write tools for that namespace; only injected keys are guarded, using their full stored values before model projection or summary truncation. Payload fields cannot override the host's target identity. Hooks cannot erase or redirect guards; vetoing a guarded prefix rolls back the batch and its success notifications. Checks run at the serialized transaction mutation boundary and survive suspension and resume. Accepted sub-agent reads through inherited world views contribute character baselines to the caller; failed or cancelled children discard them.

### Changed

- **Derived replacements can be rejected with `conflict`.** Guards include `merge`, `upsertItem` and delete, protecting an entire `inc` plus derived `merge` list. Pure relative lists and blind writes keep their existing semantics. Auxiliary conflicts discard their unit; malformed auxiliary payloads fail ordinary proposal validation and preserve valid story text. A failed story-attached operation preserves story text and unrelated operations. Retries are explicit and conflicts do not increment plugin fault counts. Cross-key and phantom protection are excluded.
