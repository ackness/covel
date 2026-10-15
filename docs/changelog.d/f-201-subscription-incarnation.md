### Breaking

- **Session event producers must capture their incarnation.** Server EventBus instances log and drop untagged events, and subscription envelopes and oversized transport references carry `sessionIncarnation`. Upgrade and restart all server processes together. Existing session metadata remains valid; no database recreation is needed.

### Fixed

- **Subscriptions no longer read the session for every frame (F-201).** Producer incarnation tags and ordered deletion controls isolate replay and live events across same-ID recreation. Transport resets trigger a recheck and reconnect; stale frames are dropped while a still-current subscription stays open. Unauthorized connections cannot evict replay state, and hidden writes and empty batches avoid event-related session reads.
