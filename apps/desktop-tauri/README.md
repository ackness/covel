# @covel/desktop-tauri

Experimental Tauri-based desktop shell, parallel to `@covel/desktop`
(Electron). Shares the same Node sidecar boot contract so we can swap
shells without touching the server.

## Why

- Bundle is 60–70% smaller than Electron (system WebView instead of Chromium)
- Rust main process has lower idle memory footprint
- Keeps the Electron app intact — no migration required

## Prereqs

- Rust toolchain (`rustc --version` works)
- Node 20+
- Depends on the Electron app's staging output — `pnpm --filter @covel/desktop build`
  will run automatically if `apps/desktop/staging/server` is missing

## Run

```bash
# Stage sidecar (downloads Node binary on first run, caches in
# src-tauri/binaries/.cache/)
pnpm --filter @covel/desktop-tauri prepare:sidecar

# Dev (auto-runs prepare:sidecar)
pnpm --filter @covel/desktop-tauri dev

# Build a macOS arm64 bundle
pnpm --filter @covel/desktop-tauri build:mac:arm64
```

## Layout

```
apps/desktop-tauri/
  splash/              # loading page shown before sidecar is ready
  scripts/
    prepare-sidecar.mjs  # download node + ensure apps/desktop staging
  src-tauri/
    Cargo.toml
    tauri.conf.json
    build.rs
    src/
      main.rs          # Tauri main, spawn sidecar + open window
      sidecar.rs       # Node sidecar lifecycle
    binaries/          # (gitignored) downloaded node binary
    icons/             # bundle icons (generate via `tauri icon` before build)
    resources/         # (gitignored) staged via prepare-sidecar
```

## Sidecar contract

Mirrors `apps/desktop/src/main.ts`:

- Bundled `bin/node` + `server/node_modules/tsx/dist/cli.mjs` + `server/src/index.ts`
- Env: `SERVER_PORT`, `STORE_BACKEND=sqlite`, `SQLITE_PATH`,
  `SERVE_STATIC=true`, `STATIC_DIR`, `COVEL_LLM_TOML`,
  `COVEL_USER_{PLUGINS,WORLDS,CONFIG}_DIR`, `COVEL_WORLDS_DIR`,
  `COVEL_MEMORY_V1=1`
- Poll `GET /api/health` up to 30s
- Webview navigates to `http://127.0.0.1:<port>/session`

## Known gaps (MVP)

- Icons: placeholder — run `pnpm tauri icon <path/to/source.png>` to fill in
- Auto-update: not wired
- Native menus: not wired (Electron app has them)
- Only tested on Mac arm64 so far
