### Breaking

- **Session event producers must capture their incarnation.** Server EventBus instances reject untagged events, and subscription envelopes and oversized transport references carry `sessionIncarnation`. Upgrade and restart all server processes together. Existing session metadata remains valid; no database recreation is needed.

### Fixed

- **Subscriptions no longer read the session for every frame (F-201).** Producer incarnation tags and ordered deletion controls isolate replay and live events across same-ID recreation. Transport loss triggers a recheck and reconnect; mismatched frames never reach another session owner.
