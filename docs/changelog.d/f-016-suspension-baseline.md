### Breaking

- **A suspension also records what its saved writes would change.** `pendingContinuation.takenUnder.writes` holds, for every plugin data key, state field, character, character schema and lorebook entry the buffered proposals write, a digest of its content when the runtime suspended. The field is required: development suspensions and browser checkpoints that hold a suspension from an earlier build must be recreated.

### Changed

- **A runtime has one waiting suspension.** When a runtime suspends again, its older suspension is voided in the same transaction, settled like an abandon (its turn may count and release held-back jobs). The resume-time `superseded` reason of `suspension_outdated` is gone, and the web client drops the older item when the new `turn.suspended` arrives.

### Fixed

- **A resume no longer overwrites a write made after the suspension.** When a background job, a manual run or any other commit changed a record the suspension would write, the resume answers `409 suspension_outdated` with `details.reason: "data-changed"`, voids the suspension and writes nothing; the record keeps the newer value. The check runs before the runtime and again inside the commit transaction. A write to another key does not block the resume. Rules: `docs/reference/api.md` (Out-of-date suspended items).
- **A suspended setup runtime no longer uses up its retries.** Its attempt is recorded as suspended instead of successful, so a setup runtime with `maxTriggerCount: 1` no longer becomes `blocked` as soon as it suspends. When the suspension is abandoned, expires or is voided, the attempt ends `failed` and the runtime goes back to `pending` (or `blocked` when the retries are used up), so it can be retried or skipped.
