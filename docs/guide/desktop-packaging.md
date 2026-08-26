# Packaging — Covel Desktop

This document describes how to build Covel desktop artifacts. The official GitHub Release workflow intentionally publishes unsigned macOS Apple Silicon and Windows x64 artifacts because the project does not hold platform signing certificates. macOS Gatekeeper and Windows SmartScreen may therefore warn players on first launch. The local electron-builder config can still build Linux artifacts on its native platform.

## One-off prep

1. Install the Node toolchain and dependencies at the repo root (`pnpm install`).
2. Stage resources: `pnpm --filter @covel/desktop build` (produces `apps/desktop/dist/`, `apps/desktop/staging/`). A clean checkout copies the committed LiteLLM snapshot and verifies `node_modules/@covel/ai-provider/data/model-db.json` is present in staging. The build performs no model-database network request.

The bundled snapshot is generated from the fixed LiteLLM commit declared in `packages/ai-provider/model-db-source.json`. To update it, change the 40-character revision and its commit timestamp, run `pnpm --filter @covel/ai-provider update-model-db`, review the generated JSON diff, and commit the manifest and snapshot together. Release preflight rejects an untracked snapshot or manifest, and the final installer verifier checks that the snapshot survives packaging. The Settings refresh action remains the opt-in path for downloading newer data into the user's configuration directory.

Running `pnpm --filter @covel/desktop dist` after that invokes electron-builder.

## macOS

### Official unsigned build

The committed config sets `mac.identity: null` and `mac.notarize: false`; release CI also sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. No signing or Apple account secrets are required.

```bash
pnpm --filter @covel/desktop dist:mac
```

Artifacts land in `release/electron/` as `.dmg` and `.zip`. The current release config targets `arm64`. Because the app is unsigned and not notarized, players may need to confirm the first launch through macOS privacy and security controls.

### Optional future signing

If a future maintainer obtains an Apple Developer certificate, local signing uses the electron-builder variable names below. Official release CI does not consume them.

| Var                           | Purpose                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `CSC_LINK`                    | Path (or https URL) to the Developer ID Application `.p12` bundle                            |
| `CSC_KEY_PASSWORD`            | Password for the `.p12`                                                                      |
| `APPLE_ID`                    | Apple Developer account email                                                                |
| `APPLE_APP_SPECIFIC_PASSWORD` | [App-specific password](https://support.apple.com/en-us/102654) (NOT your Apple ID password) |
| `APPLE_TEAM_ID`               | Developer Team ID (10-character, e.g. `ABCDE12345`)                                          |

To create a local signed and notarized build, replace `identity: null` with the intended Developer ID identity (or remove it to enable certificate discovery), then configure notarization:

Edit `apps/desktop/electron-builder.yml`, change:

```yaml
mac:
  identity: null
  notarize: false
```

to:

```yaml
mac:
  identity: "Developer ID Application: Your Name (TEAMID)"
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

### Entitlements

`apps/desktop/resources/entitlements.mac.plist` is required by the hardened runtime. It allows V8 JIT, Node sidecar spawning (`com.apple.security.cs.allow-dyld-environment-variables`), and loopback networking for the bundled API server. Do not strip entries without understanding why they are needed.

## Windows

### Official unsigned build

Release CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and does not provide certificate secrets.

```bash
pnpm --filter @covel/desktop dist:win
```

The NSIS installer and portable build land in `release/electron/`.

### Optional future signing

If a future maintainer obtains a Windows code-signing certificate, local builds can use these variables. Official release CI does not consume them.

| Var                        | Purpose                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `CSC_LINK`                 | Path (or https URL) to the `.pfx` code-signing bundle                     |
| `CSC_KEY_PASSWORD`         | Password for the `.pfx`                                                   |
| `WIN_CSC_TIMESTAMP_SERVER` | Optional RFC 3161 timestamp URL (default `http://timestamp.digicert.com`) |

```bash
CSC_LINK=/path/to/cert.pfx \
CSC_KEY_PASSWORD=... \
  pnpm --filter @covel/desktop dist:win
```

### SmartScreen

Unsigned official builds trigger Windows SmartScreen on first launch. Options:

1. Accept the "Run anyway" step in the SmartScreen dialog during early adoption.
2. Add code signing in a future release after purchasing a suitable certificate.

## Linux

```bash
pnpm --filter @covel/desktop dist:linux
```

Produces artifacts under `release/electron/`:

- `Covel-electron-<version>-linux-x64.AppImage` and
  `Covel-electron-<version>-linux-arm64.AppImage`
- `Covel-electron-<version>-linux-x64.deb`

GPG signing is not currently wired up. If required for distribution:

```bash
# After building
dpkg-sig --sign builder release/electron/*.deb
```

## Verifying a build locally

The cleanup story is **two-phase** so the unpacked tree stays available
for verification during a CI build but the user-facing `pnpm build:electron`
still lands on two files:

1. **Phase 1** — the `afterAllArtifactBuild` hook
   (`apps/desktop/scripts/cleanup-artifacts.mjs`) drops only the auto-update metadata
   (`*.blockmap`, `latest-*.yml`, `builder-*.yml`). The `mac-arm64/`
   unpacked dir survives so `apps/desktop/scripts/verify-release.mjs` can inspect
   `Covel.app/Contents/Resources/...`.
2. **Phase 2** — `node apps/desktop/scripts/cleanup-artifacts.mjs
--strip-unpacked`, chained onto the root `build:electron` script
   _after_ `electron-builder` returns. This wipes `mac-arm64/` and the
   `*-unpacked/` siblings so the local user is left with the `.dmg`
   and the `.zip` only. CI does **not** call this script — it runs
   `electron-builder` directly so the unpacked tree persists for the
   `Verify unpacked release resources` step before `actions/upload-artifact`
   picks just the distributables (`.dmg` + `.zip` on macOS, `.exe` on
   Windows).

Release CI verifies the unpacked application resources on each platform before uploading only the distributable files. Signature checks are intentionally absent while official builds are unsigned.

## Auto-update publishing

Auto-update is **off** by default. `apps/desktop/electron-builder.yml` ships with
`publish: null` and `apps/desktop/scripts/cleanup-artifacts.mjs` strips `latest-*.yml` /
`*.blockmap`. The intentional output is two files only: the `.dmg`
installer and the `.zip` containing the `.app`.

To enable auto-update later:

1. Remove (or override to a real provider config) `publish: null` in
   `apps/desktop/electron-builder.yml`.
2. Update `apps/desktop/scripts/cleanup-artifacts.mjs` to keep `latest-*.yml` and
   `*.blockmap` (currently part of the drop list).
3. Pass `GH_TOKEN` (or the matching provider credential) in CI. The Release
   workflow's `--publish=never` flag will need to flip to `--publish=always`.

In-app update checks are not currently wired up (the earlier `apps/desktop/src/auto-updater.ts`
module was removed as dead scaffolding). Re-adding them requires an
`electron-updater` dependency, an `apps/desktop/src/main.ts` startup call, and the `publish`
config above.

## Release checklist

- [ ] Bump workspace package versions, including root `package.json` and `apps/desktop/package.json`
- [ ] Update `docs/CHANGELOG.md` with the target version
- [ ] Bump `ONBOARDING_VERSION` in `apps/web/src/components/onboarding-wizard.tsx` if the tutorial changed
- [ ] Run `pnpm release:preflight`
- [ ] Run `pnpm lint` and `pnpm test` green
- [ ] Run `pnpm --filter @covel/desktop build`
- [ ] Confirm the release notes disclose that macOS and Windows artifacts are unsigned
- [ ] Smoke test on a clean machine (not your dev machine)
- [ ] Tag the release: `git tag v$(node -p "require('./apps/desktop/package.json').version")`
- [ ] Push `main` and the `v*` tag; the release workflow publishes the GitHub Release
- [ ] Verify the published release notes and `.dmg` / `.zip` / `.exe` assets
