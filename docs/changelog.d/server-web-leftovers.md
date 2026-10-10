### Added

- **One request restores all plugin data of a session.** `GET /api/sessions/:id/plugin-data` returns the readable rows of every active plugin with the same visibility rules as the per-plugin and per-namespace reads; the web client uses it for reconnect, return to the tab and reset instead of one request per active plugin. See `docs/reference/api.md`.

### Security

- **The web client sends only the provider keys its requests can reach.** `X-Provider-Keys` carries the providers that the model roles resolve to (saved binding, otherwise the server's provider) and any provider a request names directly, instead of every saved key. Until the server's roles and presets are loaded it still sends all keys. See `docs/architecture/security.md`.
- **Rate limits cannot be evaded by rotating path parameters, and their table is bounded.** The limiter counts per client address and route template, and keeps at most 10,000 counters, evicting the oldest.

### Breaking

- **A plugin action can no longer write a player submission, and its turn-message read is bounded.** `savePlayerInput` is removed from the store view of `registerRpc` handlers (`PluginRpcStore` in `@covel/plugin-handlers-utils`), so an action cannot store input that skips form validation for another plugin to trust. `listTurnMessages(limit?)` there now returns the most recent committed messages, at most 200, instead of the whole history; use `readTurnMessages` in a function runtime for paging. No bundled plugin used either. A community plugin that called `savePlayerInput` must submit through the form flow instead. See `docs/reference/api.md`.

### Documentation

- **The security page states that `resolveSlot` hands a plugin any slot's key.** `ctx.gateway.resolveSlot()` returns credentials for any slot name by design (custom wires need them) and plugin server code is not sandboxed, so approving a community package already means trusting its author with the provider keys; see `docs/architecture/security.md`.

### Added

- **Releases attach a `SHA256SUMS.txt` for the installers.** The release workflow lists the SHA-256 of every `.dmg`, `.zip` and `.exe`, so an unsigned download can be checked against it. See `docs/guide/desktop-packaging.md`.
