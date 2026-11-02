### Added

- **Subscription disconnects now carry correlated, content-free diagnostics.** Server and browser logs distinguish stream endings, invalidations, queue/write failures and deliberate cancellation. Backoff, heartbeats, deadlines and reconnect behavior are unchanged; the original repeated-reconnect trigger remains unresolved. See the [protocol](../reference/protocol.md).

### Fixed

- **Named dialogue can quote a request after a colon without a false perspective rejection.** Explicit narrative reporting clauses and quotation suffixes remain checked. See [story output](../en/reference/plugins.md#story-output).
- **Agents see completion-field rules before their first submission.** Default system schema descriptions and localized submission guidance explain valid combinations and omission outside setup. Contradiction checks, bounded repair and commit semantics remain enforced; this does not guarantee valid upstream JSON. See [submission acceptance](../ship/real-model.md#submission-acceptance).
