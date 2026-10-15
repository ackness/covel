### Breaking

- **A suspension records what it was taken under.** Each suspension now saves the number of player turns in the history and its plugin's version (`pendingContinuation.takenUnder`). Development suspensions and browser checkpoints that hold a suspension from an earlier build must be recreated.

### Changed

- **An out-of-date suspension is withdrawn instead of resumed.** When the player has played another turn or the plugin changed version, `POST /api/sessions/:id/suspensions/:suspensionId/resume` voids the suspension and answers `409` with `code: "suspension_outdated"`; the web client removes it and tells the player. Rules: `docs/reference/api.md` (Out-of-date suspended items).

### Fixed

- **Abandoning or expiring the last suspension of a turn ends that turn.** The turn now counts and the detached background jobs it held back are queued, as when the last suspension resumes; before, they were dropped. The expiry sweep settles each record under its session lock.
- **Progress jobs of a suspended runtime no longer wait forever.** Jobs a function runtime reported before suspending end `succeeded` when the resume commits and `cancelled` when the suspension is abandoned, expires or is voided.
