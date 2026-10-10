### Breaking

- **An unknown `STORE_BACKEND`, `MEDIA_BACKEND` or `VECTOR_BACKEND` stops the server from starting.** Before, a typo such as `STORE_BACKEND=postgres` silently ran on a local SQLite file. The error names the variable and the accepted values; fix the value in `.env`, the shell or the desktop config. `NODE_ENV` keeps its fallback. See `docs/guide/env-registry.md`.

### Fixed

- **A package update that cannot be recovered no longer stops the server from starting.** The server logs the package and the reason, writes the reason where the install pages show it, keeps the update's directories untouched for the next start, and continues without applying it.
- **The memory plugin no longer retries a failed model call on top of the gateway.** During an outage one extraction could make up to 24 requests; it now makes the gateway's own attempts only.
