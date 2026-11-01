### Breaking

- **`operation.failed` now requires `messages: { messageId, count }[]`.** Update server and Web together. The total count still covers the whole execution; target receipts identify only stories with saved notices.

### Added

- **Stories retain a notice when attached operations did not take effect.** Chat and stage display a localized count after reload, history paging, forks and checkpoint restore. Later successes never clear the original notice. Existing messages need no reset and remain unannotated; there is no backfill or data schema version change.
