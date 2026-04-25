# Packaging & Signing — Covel Desktop

This document describes how to build signed, notarized Covel desktop artifacts for macOS, Windows, and Linux.

## One-off prep

1. Install the Node toolchain and dependencies at the repo root (`pnpm install`).
2. Stage resources: `pnpm --filter @covel/desktop build` (produces `dist/`, `staging/`).

Running `pnpm --filter @covel/desktop dist` after that invokes electron-builder.

## macOS

### Required environment variables

| Var | Purpose |
|---|---|
| `CSC_LINK` | Path (or https URL) to the Developer ID Application `.p12` bundle |
| `CSC_KEY_PASSWORD` | Password for the `.p12` |
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App-specific password](https://support.apple.com/en-us/102654) (NOT your Apple ID password) |
| `APPLE_TEAM_ID` | Developer Team ID (10-character, e.g. `ABCDE12345`) |

### Enable notarization

Edit `electron-builder.yml`, change:

```yaml
mac:
  notarize: false
```

to:

```yaml
mac:
  notarize:
    teamId: "${env.APPLE_TEAM_ID}"
```

Then run:

```bash
CSC_LINK=/path/to/cert.p12 \
CSC_KEY_PASSWORD=... \
APPLE_ID=you@example.com \
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx \
APPLE_TEAM_ID=ABCDE12345 \
  pnpm --filter @covel/desktop dist:mac
```

Artifacts land in `release/` as `.dmg` and `.zip` for both `arm64` and `x64`.

### Entitlements

`resources/entitlements.mac.plist` is required by the hardened runtime. It allows V8 JIT, Node sidecar spawning (`com.apple.security.cs.allow-dyld-environment-variables`), and loopback networking for the bundled API server. Do not strip entries without understanding why they are needed.

## Windows

### Required environment variables

| Var | Purpose |
|---|---|
| `CSC_LINK` | Path (or https URL) to the `.pfx` code-signing bundle |
| `CSC_KEY_PASSWORD` | Password for the `.pfx` |
| `WIN_CSC_TIMESTAMP_SERVER` | Optional RFC 3161 timestamp URL (default `http://timestamp.digicert.com`) |

### Build

```bash
CSC_LINK=/path/to/cert.pfx \
CSC_KEY_PASSWORD=... \
  pnpm --filter @covel/desktop dist:win
```

NSIS installer + portable build land in `release/`.

### SmartScreen

Until you have a purchased reputation (or an EV certificate), Windows SmartScreen will warn users on first launch. Options:
1. Purchase an EV code-signing certificate from DigiCert / Sectigo / SSL.com
2. Accept the "Run anyway" step in the SmartScreen dialog during early adoption

## Linux

```bash
pnpm --filter @covel/desktop dist:linux
```

Produces:
- `Covel-<version>.AppImage` (portable, x64 and arm64)
- `Covel-<version>.deb` (x64)

GPG signing is not currently wired up. If required for distribution:
```bash
# After building
dpkg-sig --sign builder release/*.deb
```

## Verifying a build locally

Run signing checks **immediately after `electron-builder` finishes** — the
`afterAllArtifactBuild` cleanup hook (`scripts/cleanup-artifacts.mjs`) wipes the
`mac-arm64/` unpacked directory once the dmg/zip are produced, so the
`Covel.app` directory only exists for that brief window. To re-verify later,
expand the zip first:

```bash
# macOS — re-extract the .app from the shipped zip first
unzip -q release/electron/Covel-electron-*-mac-arm64.zip -d /tmp/covel-verify
codesign --verify --deep --strict --verbose=2 "/tmp/covel-verify/Covel.app"
spctl --assess --verbose "/tmp/covel-verify/Covel.app"

# Windows (PowerShell)
Get-AuthenticodeSignature release\Covel-Setup-*.exe
```

## Auto-update publishing

Auto-update is **off** by default. `electron-builder.yml` ships with
`publish: null` and the `cleanup-artifacts.mjs` hook strips `latest-*.yml` /
`*.blockmap`. The intentional output is two files only: the `.dmg` installer
and the `.zip` containing the `.app`.

To enable auto-update later:

1. Remove (or override to a real provider config) `publish: null` in
   `electron-builder.yml`.
2. Update `scripts/cleanup-artifacts.mjs` to keep `latest-*.yml` and
   `*.blockmap` (currently part of the drop list).
3. Pass `GH_TOKEN` (or the matching provider credential) in CI. The Release
   workflow's `--publish=never` flag will need to flip to `--publish=always`.

To enable in-app update checks, add `electron-updater` as a dependency and wire it up in `apps/desktop/src/main.ts`:

```ts
import { autoUpdater } from "electron-updater";
autoUpdater.checkForUpdatesAndNotify();
```

## Release checklist

- [ ] Bump `apps/desktop/package.json` `version`
- [ ] Bump `ONBOARDING_VERSION` in `onboarding-wizard.tsx` if the tutorial changed
- [ ] Run `pnpm lint` and `pnpm test` green
- [ ] Run `pnpm --filter @covel/desktop build`
- [ ] Sign + notarize per the instructions above
- [ ] Smoke test on a clean machine (not your dev machine)
- [ ] Tag the release: `git tag v$(node -p "require('./apps/desktop/package.json').version")`
- [ ] Upload artifacts to the release page
