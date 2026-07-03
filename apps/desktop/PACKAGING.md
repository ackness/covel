# Packaging & Signing — Covel Desktop

This document describes how to build signed, notarized Covel desktop artifacts. The official GitHub Release workflow currently publishes macOS Apple Silicon artifacts; the local electron-builder config can still build Windows and Linux artifacts on their native platforms.

## One-off prep

1. Install the Node toolchain and dependencies at the repo root (`pnpm install`).
2. Stage resources: `pnpm --filter @covel/desktop build` (produces `dist/`, `staging/`).

Running `pnpm --filter @covel/desktop dist` after that invokes electron-builder.

## macOS

### Required environment variables

| Var                           | Purpose                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `CSC_LINK`                    | Path (or https URL) to the Developer ID Application `.p12` bundle                            |
| `CSC_KEY_PASSWORD`            | Password for the `.p12`                                                                      |
| `APPLE_ID`                    | Apple Developer account email                                                                |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App-specific password](https://support.apple.com/en-us/102654) (NOT your Apple ID password) |
| `APPLE_TEAM_ID`               | Developer Team ID (10-character, e.g. `ABCDE12345`)                                          |

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

Artifacts land in `release/electron/` as `.dmg` and `.zip`. The current release config targets `arm64`.

### Entitlements

`resources/entitlements.mac.plist` is required by the hardened runtime. It allows V8 JIT, Node sidecar spawning (`com.apple.security.cs.allow-dyld-environment-variables`), and loopback networking for the bundled API server. Do not strip entries without understanding why they are needed.

## Windows

### Required environment variables

| Var                        | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `CSC_LINK`                 | Path (or https URL) to the `.pfx` code-signing bundle                     |
| `CSC_KEY_PASSWORD`         | Password for the `.pfx`                                                   |
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

The cleanup story is **two-phase** so the unpacked tree stays available
for verification during a CI build but the user-facing `pnpm build:electron`
still lands on two files:

1. **Phase 1** — the `afterAllArtifactBuild` hook
   (`scripts/cleanup-artifacts.mjs`) drops only the auto-update metadata
   (`*.blockmap`, `latest-*.yml`, `builder-*.yml`). The `mac-arm64/`
   unpacked dir survives so `verify-release.mjs` (and any local
   `codesign`) can inspect `Covel.app/Contents/Resources/...`.
2. **Phase 2** — `node apps/desktop/scripts/cleanup-artifacts.mjs
--strip-unpacked`, chained onto the root `build:electron` script
   _after_ `electron-builder` returns. This wipes `mac-arm64/` and the
   `*-unpacked/` siblings so the local user is left with the `.dmg`
   and the `.zip` only. CI does **not** call this script — it runs
   `electron-builder` directly so the unpacked tree persists for the
   `Verify unpacked release resources` step before `actions/upload-artifact`
   picks just the `.dmg` + `.zip`.

```bash
# macOS — between phase 1 and phase 2 the unpacked .app is still on disk:
codesign --verify --deep --strict --verbose=2 "release/electron/mac-arm64/Covel.app"
spctl --assess --verbose "release/electron/mac-arm64/Covel.app"

# After `pnpm build:electron` (phase 2 has run), expand the zip first:
unzip -q release/electron/Covel-electron-*-mac-arm64.zip -d /tmp/covel-verify
codesign --verify --deep --strict --verbose=2 "/tmp/covel-verify/Covel.app"

# Windows (PowerShell)
Get-AuthenticodeSignature release\Covel-Setup-*.exe
```

## Auto-update publishing

Auto-update is **off** by default. `electron-builder.yml` ships with
`publish: null` and `cleanup-artifacts.mjs` strips `latest-*.yml` /
`*.blockmap`. The intentional output is two files only: the `.dmg`
installer and the `.zip` containing the `.app`.

To enable auto-update later:

1. Remove (or override to a real provider config) `publish: null` in
   `electron-builder.yml`.
2. Update `scripts/cleanup-artifacts.mjs` to keep `latest-*.yml` and
   `*.blockmap` (currently part of the drop list).
3. Pass `GH_TOKEN` (or the matching provider credential) in CI. The Release
   workflow's `--publish=never` flag will need to flip to `--publish=always`.

In-app update checks are not currently wired up (the earlier `auto-updater.ts`
module was removed as dead scaffolding). Re-adding them requires an
`electron-updater` dependency, a `main.ts` startup call, and the `publish`
config above.

## Release checklist

- [ ] Bump workspace package versions, including root `package.json` and `apps/desktop/package.json`
- [ ] Update `docs/CHANGELOG.md` with the target version
- [ ] Bump `ONBOARDING_VERSION` in `onboarding-wizard.tsx` if the tutorial changed
- [ ] Run `pnpm release:preflight`
- [ ] Run `pnpm lint` and `pnpm test` green
- [ ] Run `pnpm --filter @covel/desktop build`
- [ ] Sign + notarize per the instructions above
- [ ] Smoke test on a clean machine (not your dev machine)
- [ ] Tag the release: `git tag v$(node -p "require('./apps/desktop/package.json').version")`
- [ ] Push `main` and the `v*` tag; the release workflow publishes the GitHub Release
- [ ] Verify the published release notes and `.dmg` / `.zip` assets
