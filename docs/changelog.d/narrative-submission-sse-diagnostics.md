### Added

- **Subscription disconnects now carry correlated, content-free diagnostics.** Server and browser logs distinguish stream endings, invalidations, queue/write failures and deliberate cancellation. Diagnostic observer failures cannot block cancellation or reader cleanup. Backoff, heartbeats, deadlines and reconnect behavior are unchanged. See the [protocol](../en/reference/protocol.md).
