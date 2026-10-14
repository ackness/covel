### Added

- **Self-hosters get a SQLite Docker stack, and it is the default.** `docker/docker-compose.sqlite.yml` runs one app container with no database service. The SQLite file, its media files and the installed worlds and plugins live in a named volume (`SQLITE_PATH=/home/node/.covel/data/covel.db`), so they survive recreating the container. It keeps the loopback binding and `DEPLOYMENT_TIER=self`, and it refuses to start without `COVEL_MEDIA_TOKEN_SECRET`. Run it with `pnpm docker:build`; details in `docs/reference/env-registry.md#docker-compose`.

### Changed

- **`pnpm docker:*` now runs the SQLite stack; PostgreSQL moved to `pnpm docker:pg:*`.** `docker:up`, `docker:build`, `docker:down`, `docker:down-all` and `docker:logs` use `docker/docker-compose.sqlite.yml`. The PostgreSQL stack in `docker/docker-compose.yml` is unchanged and has the same five commands as `docker:pg:up`, `docker:pg:build`, `docker:pg:down`, `docker:pg:down-all` and `docker:pg:logs`.
- **`.env.example` has the PostgreSQL variables commented out.** SQLite needs none of them. Uncomment the "PostgreSQL (optional)" block before `pnpm db:up`, `pnpm dev:pg`, `pnpm test:pg` or `pnpm docker:pg:build`.

### Upgrade notes

- If you run the PostgreSQL Docker stack, replace `pnpm docker:build` / `up` / `down` / `down-all` / `logs` with the `docker:pg:` commands. The old names now start a separate SQLite stack on the same default port.
