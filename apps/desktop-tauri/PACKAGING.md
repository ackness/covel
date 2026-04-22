# Packaging & Signing — Covel Desktop (Tauri)

This document describes how to build distributable Covel desktop artifacts via the Tauri shell. The Tauri shell sits alongside the Electron shell (`@covel/desktop`, see [apps/desktop/PACKAGING.md](../desktop/PACKAGING.md)) and shares the same Node sidecar contract.

> Tauri is currently **experimental**. Only macOS arm64 has been smoke-tested through the full signing flow. The Windows and Linux sections below reflect the Tauri bundle targets declared in `src-tauri/tauri.*.conf.json` but have not been end-to-end verified.

## One-off prep

1. Install the Rust toolchain. `rustc --version` must resolve.
   - macOS: `xcode-select --install`, then `curl https://sh.rustup.rs -sSf | sh`.
2. Install Node 20+ and run `pnpm install` at the repo root.
3. Confirm the Electron shell's staging output is present (the Tauri shell reuses it). If missing, `pnpm --filter @covel/desktop build` populates `apps/desktop/staging/`.
4. Stage the sidecar into `src-tauri/binaries/`: `pnpm --filter @covel/desktop-tauri prepare:sidecar`. First run downloads the Node binary into `src-tauri/binaries/.cache/` (cached for later runs).

Running `pnpm --filter @covel/desktop-tauri build` auto-runs `prepare:sidecar` first.

## Commands

```bash
# Dev (opens a Tauri window, starts the sidecar)
pnpm --filter @covel/desktop-tauri dev

# Single host-target build
pnpm --filter @covel/desktop-tauri build

# macOS (arm64 and x64 targets build separately — universal isn't wired)
pnpm --filter @covel/desktop-tauri build:mac:arm64
pnpm --filter @covel/desktop-tauri build:mac:x64
```

Each `build:mac:*` script chains three steps: `prepare-sidecar.mjs <target>` → `tauri build --target <triple>` → `stage-release.mjs <triple>`.

Build output lands in two places:

| Path | Contents |
|------|----------|
| `apps/desktop-tauri/src-tauri/target/<triple>/release/bundle/` | Raw Tauri bundle output (`.app`, `.dmg`, `.deb`, `.AppImage`, `.nsis`). |
| `release/tauri/<triple>/` | Stage-release copies distributable artefacts here so Electron and Tauri outputs live side-by-side with `release/electron/`. |

## macOS

### Bundle config

`src-tauri/tauri.macos.conf.json` keeps the minimum viable macOS bundle:

```json
{
  "bundle": {
    "resources": {
      "binaries/node": "bin/node"
    }
  }
}
```

Root `src-tauri/tauri.conf.json` sets `bundle.targets = ["app", "dmg"]` and `bundle.macOS.minimumSystemVersion = "10.15"`.

### Signing and notarization

Tauri uses its own env vars, **not** the `CSC_*` variables `electron-builder` expects. Set these before running `build:mac:arm64` or `build:mac:x64`:

| Var | Purpose |
|-----|---------|
| `APPLE_SIGNING_IDENTITY` | The signing identity string, e.g. `Developer ID Application: Your Name (ABCDE12345)`. `security find-identity -v -p codesigning` lists available identities. |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` (alternative to using the keychain directly). |
| `APPLE_CERTIFICATE_PASSWORD` | Password for `APPLE_CERTIFICATE`. |
| `APPLE_ID` | Apple Developer account email (for notarization). |
| `APPLE_PASSWORD` | [App-specific password](https://support.apple.com/en-us/102654), **not** your Apple ID password. |
| `APPLE_TEAM_ID` | Developer Team ID (e.g. `ABCDE12345`). |

Then:

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: ... (ABCDE12345)" \
APPLE_ID=you@example.com \
APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=ABCDE12345 \
  pnpm --filter @covel/desktop-tauri build:mac:arm64
```

Tauri v2 notarizes in-line when the Apple credentials above are present — there is no separate notarize step. The produced `.dmg` ships stapled to the notarization ticket.

### Entitlements

Not currently maintained as a standalone file (Electron keeps `resources/entitlements.mac.plist`; the Tauri shell has not needed a custom entitlement set yet). If the bundle grows to need JIT or sandbox-expanded behaviour, add an entitlements file under `src-tauri/entitlements/` and reference it from `tauri.macos.conf.json`.

> **TODO — confirm with shipping owner**: final entitlements set for Tauri once notarized builds ship. The Electron hardened-runtime entitlements are documented at [apps/desktop/PACKAGING.md#entitlements](../desktop/PACKAGING.md#entitlements) for reference.

## Windows

The Windows target is declared in `src-tauri/tauri.windows.conf.json`:

```json
{
  "bundle": {
    "targets": ["nsis"],
    "resources": {
      "binaries/node.exe": "bin/node.exe"
    }
  }
}
```

Tauri uses these env vars for signing:

| Var | Purpose |
|-----|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Base64-encoded `.pfx` or PEM code-signing key. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the key. |

Standard `pnpm --filter @covel/desktop-tauri build` on a Windows host produces an NSIS installer under `src-tauri/target/release/bundle/nsis/`.

SmartScreen applies to Tauri NSIS installers the same way it does to Electron NSIS installers — until you have reputation or an EV certificate, first-launch users see a warning. See [apps/desktop/PACKAGING.md#smartscreen](../desktop/PACKAGING.md#smartscreen).

> **TODO — confirm with shipping owner**: there is no `build:win:*` pnpm script yet. Wire one up when Windows is formally supported.

## Linux

The Linux target is declared in `src-tauri/tauri.linux.conf.json`:

```json
{
  "bundle": {
    "targets": ["appimage", "deb"],
    "resources": {
      "binaries/node": "bin/node"
    }
  }
}
```

Produces `.AppImage` and `.deb` under `src-tauri/target/release/bundle/`. GPG signing is not currently wired up. For `.deb` signing: `dpkg-sig --sign builder release/*.deb` after the build.

> **TODO — confirm with shipping owner**: no `build:linux` pnpm script yet; AppImage signing flow is TBD.

## Icons

`src-tauri/tauri.conf.json` references five icon files under `src-tauri/icons/`:

- `32x32.png` · `128x128.png` · `128x128@2x.png` · `icon.icns` · `icon.ico`

Current icons are placeholders. Regenerate from a single source image:

```bash
pnpm --filter @covel/desktop-tauri exec tauri icon path/to/source-1024.png
```

(You can also run `pnpm --filter @covel/desktop-tauri tauri icon <path>`.) The command writes all required formats into `src-tauri/icons/` in place.

## Known platform gotchas

- **`withGlobalTauri: true`** (`tauri.conf.json`) exposes `window.__TAURI__` to the splash page. The main UI is served by the Node sidecar on localhost, so the global is only in scope while the splash is showing.
- **Sidecar start-up** (`src-tauri/src/sidecar.rs`) spawns `bin/node server/node_modules/tsx/dist/cli.mjs server/src/index.ts` with the Covel env (`SERVER_PORT`, `STORE_BACKEND=sqlite`, `SQLITE_PATH`, `SERVE_STATIC=true`, `STATIC_DIR`, `COVEL_LLM_TOML`, `COVEL_USER_{PLUGINS,WORLDS,CONFIG}_DIR`, `COVEL_WORLDS_DIR`, `COVEL_MEMORY_V1=1`) and polls `GET /api/health` for up to 30 s before the webview navigates to `http://127.0.0.1:<port>/session`.
- **ABI rebuild**: `prepare-sidecar.mjs` rebuilds `better-sqlite3` against the bundled Node binary's ABI — Tauri never mutates Electron's `apps/desktop/staging/` directly.
- **macOS x64**: `tauri build --target x86_64-apple-darwin` on an arm64 host requires the x86_64 Rust target installed (`rustup target add x86_64-apple-darwin`) and Rosetta-aware linker settings. If the build fails with a linker error, confirm the target is installed and try a fresh `cargo clean`.
- **No auto-update wired**: unlike Electron (where `electron-updater` is on the roadmap), the Tauri shell has no update channel. A future release will expose `tauri-plugin-updater` once keys are provisioned.

## Verifying a build locally

```bash
# macOS — check signing + notarization
codesign --verify --deep --strict --verbose=2 "release/tauri/aarch64-apple-darwin/Covel.app"
spctl --assess --verbose "release/tauri/aarch64-apple-darwin/Covel.app"
xcrun stapler validate "release/tauri/aarch64-apple-darwin/Covel_0.0.1-beta_aarch64.dmg"
```

## Release checklist

- [ ] Bump `apps/desktop-tauri/package.json` and `apps/desktop-tauri/src-tauri/tauri.conf.json` `version` in lockstep.
- [ ] Bump `apps/desktop/package.json` if shipping both shells from the same release.
- [ ] Run `pnpm lint` and `pnpm test` green.
- [ ] `pnpm --filter @covel/desktop build` to refresh the shared staging output.
- [ ] `pnpm --filter @covel/desktop-tauri build:mac:arm64` (and `:x64` if shipping Intel).
- [ ] Verify signing + notarization per the commands above.
- [ ] Smoke test on a clean machine (not your dev machine).
- [ ] Tag the release and upload artefacts from `release/tauri/<triple>/`.
