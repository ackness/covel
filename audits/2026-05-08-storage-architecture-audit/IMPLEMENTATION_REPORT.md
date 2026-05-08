# Storage architecture implementation report

Date: 2026-05-08

## Key decision

The remediation does not force all storage into IndexedDB.

The intended boundary is:

- Browser `local` mode stores user business records in browser IndexedDB.
- Browser `remote` mode calls the server API; the server persists through
  `STORE_BACKEND=memory|sqlite|pg`.
- Server and desktop deployments keep `sqlite` as the default durable backend.
- `idb` is exposed by `@covel/store` for browser-capable callers and tests.

So "IDB consolidation" means browser-side local persistence and browser caches
are governed through one facade and migration policy. It does not replace
server SQLite/PostgreSQL.

## What changed

### 1. Store package surface

Implemented the package-level storage surface described by R0.1 and R0.2.

Changed files:

- `packages/store/src/factory.ts`
- `packages/store/src/index.ts`
- `packages/store/src/media-store.ts`
- `packages/store/src/types.ts`
- `packages/store/src/indexeddb/idb-store.ts`
- SQL / memory mapper files under `packages/store/src/**`

How:

- `createStore({ backend: "idb" })` now works through a lazy dynamic import,
  keeping server bundles SSR-safe.
- Package-level IDB defaults now use the unified browser database name
  `covel-browser`, matching the web storage facade.
- `createStoreFromEnv()` still reads `STORE_BACKEND` and defaults to `sqlite`.
- `createMediaStoreFromEnv()` centralizes media backend selection in
  `@covel/store`.
- Server env accepts `MEDIA_BACKEND=mirror|memory|sqlite|pg|none`.
- Browser IDB media and S3 media remain explicit factory paths rather than
  server env backends.
- World/session record types were widened so browser local mode can persist
  the UI fields it already uses without `any` mapper casts.

### 2. Frontend storage modes

Implemented the web facade direction from R1.2 and R1.3 without removing the
storage switch.

Changed files:

- `apps/web/src/services/storage/**`
- `apps/web/src/services/data-service.ts`
- `apps/web/src/services/app-kv-store.ts`
- `apps/web/src/main.tsx`
- `apps/web/src/lib/browser-media-adapter.ts`

How:

- `apps/web/src/services/storage/` owns browser data-store creation, media-store
  creation, storage-mode resolution, and legacy key declarations.
- `storageMode` remains `local | remote`.
- `local` creates `LocalDataService` and uses browser IndexedDB.
- `remote` creates `RemoteDataService` and delegates CRUD to the server API.
- Browser-local data, browser media, app-KV records, and the media render cache
  now share one IndexedDB database: `covel-browser`.
- First boot on the unified browser schema deletes early local databases
  (`covel-game`, `covel-app`, `covel-media`, `covel-media-store`, and
  `covel-store`) plus old frontend localStorage data keys instead of attempting
  a complex user-data migration.
- The browser reset is scoped to the current browser/WebView origin; desktop
  SQLite files, media directories, `settings.json`, and `keys.env` remain under
  the desktop path contract.
- Frontend boot now prefers `/api/health.storage.data.frontendMode`; older
  servers still work through the legacy `/api/health.storeBackend` fallback.

### 3. Server storage composition

Implemented server-side media/backend consolidation and structured health
reporting.

Changed files:

- `apps/server/src/app.ts`
- `apps/server/src/routes/api/bootstrap.ts`
- `apps/server/src/routes/api/health.ts`

How:

- Server startup creates the DataStore with `createStoreFromEnv()`.
- Server startup creates the MediaStore with `createMediaStoreFromEnv()`.
- `bootstrapApi()` receives the active data/media/vector backend descriptors
  instead of re-reading environment variables inside route code.
- `/api/health` now returns:
  - legacy `storeBackend`
  - legacy `vector`
  - structured `storage.data`
  - structured `storage.media`
  - structured `storage.vector`
  - `storage.migrations`

The legacy fields remain for compatibility with older web bundles and scripts.

### 4. Desktop path contract

Implemented the shared desktop path direction from R2.1.

Changed files:

- `apps/desktop/src/main.ts`
- `apps/desktop/src/paths.ts`
- `apps/desktop-tauri/src-tauri/src/main.rs`
- `docs/guide/desktop-config.md`
- `docs/guide/desktop-config.en.md`

How:

- Electron and Tauri now align on the same `data_root` contract.
- User worlds resolve under `<data_root>/worlds`.
- SQLite, logs, server port state, and user-authored worlds move together when
  `data_root` is changed.
- Small config and secret files remain under the user config root.

### 5. Env and docs hygiene

Implemented the env cleanup from R3.x.

Changed files:

- `.env.example`
- `packages/shared/src/env/registry.ts`
- `docs/architecture/storage.md`
- `docs/reference/api.md`
- `CLAUDE.md`

How:

- `.env.example` is grouped by Data Store, PostgreSQL, Media Store, Vector,
  Desktop, Server Runtime, and related domains.
- `STORE_BACKEND=sqlite` is documented as the default.
- `SQLITE_PATH` derives from `<COVEL_DATA_ROOT>/covel.db` when `COVEL_DATA_ROOT`
  is set.
- `VECTOR_BACKEND=embedded|none|external` is registered and documented.
- Storage docs explicitly state that browser IDB is one frontend mode, while
  server SQLite/PostgreSQL remain selectable.

### 6. Long-term items

Implemented the first stable version of the P3 direction.

Changed files:

- `packages/store/src/vector-factory.ts`
- `packages/store/src/storage-capabilities.ts`
- `packages/store/src/migrations.ts`
- `apps/server/src/routes/api/health.ts`

How:

- `createVectorStore()` and `createVectorStoreFromEnv()` expose vector search
  as a sibling capability to DataStore.
- `VECTOR_BACKEND=embedded` uses the active DataStore vector capability.
- `VECTOR_BACKEND=none` disables vector search cleanly.
- `VECTOR_BACKEND=external` is reserved for a future injected adapter and fails
  fast when no adapter is supplied.
- `describeStorageCapabilities()` builds a structured descriptor for data,
  media, vector, and migrations.
- The migration registry currently records non-destructive descriptors:
  SQL migrations remain explicit server migrations; IDB migrations remain
  browser `openDB` upgrade callbacks.
- External vector adapters and S3 production env wiring remain out of scope for
  this batch.

### 7. Local development data reset

Performed the explicit local reset requested for this early-stage development
environment.

Reset scope:

- Stopped the local dev server before touching SQLite files.
- Removed the active local SQLite database:
  - `~/.covel/data/covel.db`
  - `~/.covel/data/covel.db-wal`
  - `~/.covel/data/covel.db-shm`
- Removed the matching local media payload directory:
  - `~/.covel/data/media`
- Removed stale local runtime state:
  - `~/.covel/data/server.port`
- Removed the Electron/Chromium desktop profile so desktop WebView IndexedDB,
  local storage, session storage, and cache state are regenerated under the new
  browser storage layout:
  - `~/Library/Application Support/Covel`
- Recreated the expected empty data directories:
  - `~/.covel/data/logs`
  - `~/.covel/data/media`
  - `~/.covel/data/worlds`

Preserved files:

- `~/.covel/config.toml`
- `~/.covel/keys.env`
- `~/.covel/llm.toml`
- `~/.covel/settings.json`
- `~/.covel/window-state.json`
- `~/.covel/plugins/`

Verification after reset:

- `find ~/.covel/data -maxdepth 1 -name 'covel.db*' -print` returned no files.
- `~/.covel/data/media` and `~/.covel/data/worlds` are empty directories.
- `~/Library/Application Support/Covel` no longer exists and will be recreated
  by the desktop app on next launch.
- Legacy desktop support paths `~/Library/Application Support/@covel` and
  `~/Library/Application Support/com.covel.app` are absent.

## Testing performed

Commands run:

```bash
mise exec -- pnpm --filter @covel/shared test
mise exec -- pnpm --filter @covel/store test
mise exec -- pnpm --filter @covel/server test -- --run apps/server/tests/api/session-state.test.ts
mise exec -- pnpm --filter @covel/web test -- --run apps/web/src/services/__tests__/api-worlds-approvals.test.ts apps/web/src/lib/__tests__/browser-media-adapter.test.ts
mise exec -- pnpm --filter @covel/web test -- --run apps/web/src/lib/__tests__/media-cache.test.ts apps/web/src/lib/__tests__/media-resolve.test.ts apps/web/src/components/__tests__/Media.test.tsx apps/web/src/lib/__tests__/browser-media-adapter.test.ts apps/web/src/services/__tests__/api-worlds-approvals.test.ts
mise exec -- pnpm --filter @covel/shared lint
mise exec -- pnpm --filter @covel/store lint
mise exec -- pnpm --filter @covel/server lint
mise exec -- pnpm --filter @covel/web lint
git diff --check
```

Observed results:

- `@covel/shared` tests: 10 files, 52 tests passed.
- `@covel/store` tests: 8 files, 511 tests passed.
- `@covel/server` tests: 43 files, 391 passed, 5 skipped.
- `@covel/web` tests: 26 files, 199 tests passed.
- All four package lint/typecheck commands exited successfully.

## Remaining risks

- `VECTOR_BACKEND=external` has a contract and fail-fast path, while the actual
  external adapter remains future work.
- S3 media remains an explicit factory path. `MEDIA_BACKEND=s3` still requires a
  future production client factory before it can be accepted through env config.
- The local development machine was reset directly because the project is still
  early-stage. A release-grade migration and rollback procedure remains future
  work before shipping this storage change to users with existing data.
