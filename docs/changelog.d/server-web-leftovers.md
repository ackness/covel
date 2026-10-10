### Added

- **One request restores all plugin data of a session.** `GET /api/sessions/:id/plugin-data` returns the readable rows of every active plugin with the same visibility rules as the per-plugin and per-namespace reads; the web client uses it for reconnect, return to the tab and reset instead of one request per active plugin. See `docs/reference/api.md`.

### Security

- **The web client sends only the provider keys its requests can reach.** `X-Provider-Keys` carries the providers that the model roles resolve to (saved binding, otherwise the server's provider) and any provider a request names directly, instead of every saved key. Until the server's roles and presets are loaded it still sends all keys. See `docs/architecture/security.md`.
- **Rate limits cannot be evaded by rotating path parameters, and their table is bounded.** The limiter counts per client address and route template, and keeps at most 10,000 counters, evicting the oldest.
