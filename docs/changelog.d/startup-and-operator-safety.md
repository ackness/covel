### Breaking

- **An unknown `STORE_BACKEND`, `MEDIA_BACKEND` or `VECTOR_BACKEND` stops the server from starting.** Before, a typo such as `STORE_BACKEND=postgres` silently ran on a local SQLite file. The error names the variable and the accepted values; fix the value in `.env`, the shell or the desktop config. `NODE_ENV` keeps its fallback. See `docs/guide/env-registry.md`.

### Fixed

- **A package update that cannot be recovered no longer stops the server from starting.** The server logs the package and the reason, writes the reason where the install pages show it, keeps the update's directories untouched for the next start, and continues without applying it.
- **The memory plugin no longer retries a failed model call on top of the gateway.** During an outage one extraction could make up to 24 requests; it now makes the gateway's own attempts only.
- **A second server process on the same SQLite file is refused at start.** The server keeps `<SQLITE_PATH>.lock` (pid and start time) next to the database; a second process, for example a dev server started against the desktop app's Covel home, fails with a message naming the file and the owner's pid. A lock left by a killed process is taken over. See `docs/architecture/storage.md`.

### Added

- **Settings says when the environment overrides a saved provider key.** On desktop, a provider key in the shell, `.env` or `.env.llm` outranks the key saved in Settings. `GET /api/llm-config` now lists such providers in `envKeyOverrides`, and the API keys page shows a notice under the key. Precedence is unchanged (`docs/reference/api.md`).
