### Breaking

- **One plugin-data value is capped at 256 KiB on every write path.** `PUT /api/sessions/:id/plugin-data/...` used to refuse values over 64 KB and now refuses values over 256 KiB (HTTP 413); world-package `worldData` records over 256 KiB now fail the import with an error diagnostic instead of being stored. Split an oversized record into several records or keys.
