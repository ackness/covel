### Breaking

- **`operation.failed` now requires `messages: { messageId, count }[]`.** Update server and Web together. The total count still covers the whole execution; target receipts identify only stories with saved notices.

### Added

- **Stories retain a notice when attached operations did not take effect.** Chat and stage display a localized count after reload, history paging, forks and checkpoint restore. Delayed resume completions retain recovered notices, and observing tabs load saved stories and notices even while another runtime remains suspended. The host footer stays outside plugin theme scopes in chat, stage and history. Later successes never clear the original notice. The player sees a fixed count notice without an execution error, and the calling agent receives failed operation summaries on its next player or continuation execution; a sub-agent that made the operation receives them the next time it is called. Existing messages need no reset and remain unannotated; there is no backfill or data schema version change.
