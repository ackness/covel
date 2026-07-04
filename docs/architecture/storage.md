# Storage Architecture

Covel storage has four separate contracts:

| Category                  | Contract                    | Main implementations                           | Owner                                              |
| ------------------------- | --------------------------- | ---------------------------------------------- | -------------------------------------------------- |
| Business records          | `DataStore`                 | memory, sqlite, pg, idb                        | `@covel/store`                                     |
| Binary assets             | `MediaStore`                | memory, sqlite, pg, idb                        | `@covel/store`                                     |
| User preferences and keys | `SettingsStore`, `keys.env` | localStorage, Electron IPC, desktop REST files | `@covel/shared`, desktop shells, server config API |
| Frontend caches           | app KV, media cache         | browser IndexedDB databases                    | `apps/web` storage facade                          |

## Backend Selection

`STORE_BACKEND` selects the server primary `DataStore`. The default is `sqlite`.
When `SQLITE_PATH` is omitted and `COVEL_DATA_ROOT` is set, SQLite resolves to
`<COVEL_DATA_ROOT>/covel.db`; otherwise the legacy default is `./data/covel.db`.

| Value    | Tier                                      | Notes                                                                                                                                        |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory` | tests, ephemeral demos                    | Process-local and lost on restart. The web frontend switches to local IDB mode when `/api/health.storage.data.frontendMode` reports `local`. |
| `sqlite` | local dev, desktop, single-node self-host | Uses `SQLITE_PATH`, default `./data/covel.db`.                                                                                               |
| `pg`     | multi-process/server deployment           | Requires `DATABASE_URL`; server session locks use PostgreSQL advisory locks.                                                                 |
| `idb`    | browser-capable callers                   | Available through `createStore({ backend: "idb" })`; it is a package factory backend, not a server env backend.                              |

The browser still has a user-visible mode switch. `local` means business
records are saved in the user's browser IndexedDB. `remote` means the frontend
uses the HTTP API and the server persists through its configured
`STORE_BACKEND` (`memory`, `sqlite`, or `pg`). `/api/health.storage.data`
publishes the resolved `backend` and `frontendMode`.

`MEDIA_BACKEND` selects the `MediaStore`. The default is `mirror`, which follows
`STORE_BACKEND`.

| Value    | Behavior                                                                           |
| -------- | ---------------------------------------------------------------------------------- |
| `mirror` | `memory -> memory`, `sqlite -> sqlite`, `pg -> pg` on the server env path.         |
| `memory` | Process-local media, useful for tests.                                             |
| `sqlite` | File blobs under `MEDIA_ROOT`, or a `media/` directory beside `SQLITE_PATH`.       |
| `pg`     | Media records and bytes in PostgreSQL; unavailable when `DATABASE_URL` is missing. |
| `idb`    | Browser IndexedDB media store through explicit factory calls.                      |
| `none`   | Disables media routes through the existing `mediaStore` absent path.               |

## Desktop Paths

Electron uses this desktop path contract:

```text
~/.covel/
  config.toml
  llm.toml
  keys.env
  settings.json
  plugins/

<data_root>/                  # default ~/.covel/data
  covel.db
  worlds/
  logs/
  server.port
```

`[paths] data_root` in `config.toml` moves SQLite, logs, server port state, and
user-authored worlds together. Small config and secrets remain under
`~/.covel/`.

## Browser Storage

The web tier now has a storage facade under `apps/web/src/services/storage/`:

- `data-store.ts` owns browser `DataStore` creation (`covel-browser`).
- `media-store.ts` owns browser `MediaStore` creation (`covel-browser`).
- `mode.ts` owns `covel:storageMode`.
- `legacy-keys.ts` registers storage-related localStorage keys and prefixes.

The unified browser database is `covel-browser`. It contains local-mode
business records, the browser `MediaStore`, frontend app-KV records, and the
read-through media render cache under one IndexedDB schema version. On first
boot of this early pre-release storage layout, the web app deletes legacy
browser-origin databases (`covel-game`, `covel-app`, `covel-media`,
`covel-media-store`, and `covel-store`) and removes old frontend data
localStorage keys. The reset does not touch desktop SQLite files, media
directories, `settings.json`, `keys.env`, or other files outside the
browser/WebView origin.

Desktop uses the same web bundle, so its WebView can still create
`covel-browser` for frontend-only UI state and media render cache. Desktop
business records and durable media continue to use `remote` mode by default:
the web layer calls the local server API, and the sidecar persists through
SQLite under `<data_root>`.

## Capabilities And Migrations

`/api/health` exposes a structured `storage` descriptor:

- `storage.data` reports the server DataStore backend, durability, and browser
  `frontendMode`.
- `storage.media` reports the configured and effective MediaStore backend.
- `storage.vector` reports `VECTOR_BACKEND`, whether vector search is available,
  and the concrete driver (`in-memory`, `sqlite-vec`, `pgvector`, `external`,
  or `none`).
- `storage.migrations` lists registered migration domains and current versions.

`VECTOR_BACKEND=embedded` uses the active DataStore vector capability. `none`
disables vector search. `external` is reserved for a future injected adapter;
without that adapter the vector factory fails fast instead of pretending the
DataStore owns an external vector service.

## Session And World Metadata

`WorldRecord.metadata.dimensions` is projected onto `WorldRecord.dimensions`
by the store layer so server and web records expose the same shape.

`SessionRecord.presetId` is stored through `SessionRecord.metadata.presetId`.
This keeps SQL schemas forward-compatible while allowing local browser mode,
memory, SQLite, PostgreSQL, and IndexedDB to share one typed contract.
