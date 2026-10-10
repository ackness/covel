### Added

- **One request restores all plugin data of a session.** `GET /api/sessions/:id/plugin-data` returns the readable rows of every active plugin with the same visibility rules as the per-plugin and per-namespace reads; the web client uses it for reconnect, return to the tab and reset instead of one request per active plugin. See `docs/reference/api.md`.
