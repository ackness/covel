# Desktop packaging and release

This page explains how to build the Covel desktop app installer, how to check it locally, and which steps to follow to publish a release. It is written for maintainers and for contributors who want to package the app themselves.

The official GitHub Release publishes only two kinds of artifacts: macOS Apple Silicon and Windows x64. Neither one is **signed**, because the project has no platform signing certificate. The first time a player opens the app, macOS Gatekeeper and Windows SmartScreen may show a warning. You can build the Linux artifacts yourself on a Linux machine with the same electron-builder configuration.

## One-off prep

1. Install the toolchain and dependencies in the repository root:

   ```bash
   pnpm install
   ```

2. Prepare the resources for packaging:

   ```bash
   pnpm --filter @covel/desktop build
   ```

   It generates `apps/desktop/dist/` and `apps/desktop/staging/`. The build does not download the model database over the network. It copies the LiteLLM snapshot that is committed in the repository, and it checks that `node_modules/@covel/ai-provider/data/model-db.json` exists in staging.

3. Call electron-builder to package the app:

   ```bash
   pnpm --filter @covel/desktop dist
   ```

   Each platform has its own command. See [macOS](#macos), [Windows](#windows), and [Linux](#linux) below. Running `pnpm build:electron` in the repository root has the same effect, and it also deletes the unpacked directory at the end, so only the installer is left.

### Update the built-in model database

The built-in snapshot comes from the LiteLLM commit written in `packages/ai-provider/model-db-source.json`. To update it:

1. Change the 40-character commit hash and the commit time in this file.
2. Run `pnpm --filter @covel/ai-provider update-model-db`. It regenerates the snapshot, and it records again which reasoning levels each model name supports.
3. Check the differences in the generated JSON, and the differences in `packages/ai-provider/tests/__snapshots__/reasoning-characterization.snap.txt`.
4. Commit the manifest file, the snapshot, and this record together.

`pnpm release:preflight` rejects a snapshot or manifest that is not under version control. The final installer check also confirms that the snapshot still exists after packaging. When a player wants newer data, they can refresh it manually in Settings. The new data is downloaded into the user's config directory.

### Behavior at app startup

Things that the packager needs to know:

- The desktop app allows only one instance. It takes the single-instance lock first, and only then starts the built-in server process. If you open a second instance, the existing window is brought to the front.
- The page's local storage uses the default session that Electron persists. The server process prefers the last port it used, so the page's origin address stays the same.
- When the server process restarts, the current page stays on screen, and the app shows the status.
- The native menu items "Import plugin" and "Import world" open **Settings → Install & manage**. Choosing a ZIP, validation, authorization, and the success or failure messages all go through the shared install flow. Copying a folder by hand is not an install method.

### How the packaged server starts

- The built-in server process runs the precompiled `server/src/index.js` directly, in Electron's Node mode. The framework modules do not need to be transpiled at startup.
- The build compiles every workspace package in staging next to its source, and it points the package exports to the generated `.js` files. So the relative location of the model data and prompt files, as computed from `import.meta.url`, does not change.
- The `tsx` loader is still kept. It loads the TypeScript plugin code that is imported dynamically.
- After the HTTP port starts listening, the child process sends one private `covel:ready` message to the parent process, with the port number. When the desktop app receives it, it loads the app right away.
- Waiting for readiness fails in three cases: the child process exits, the IPC connection drops, or 30 seconds pass.

### Rules for the staging directory

- The staging directory owns its own files. After `pnpm deploy`, the build first replaces the hard links with independent copies, and only then rewrites the resource or cache output. Packaging and restoring the Turbo cache must not change the workspace source or the pnpm package store.
- The Turbo desktop task waits until the server build finishes. Its cache inputs include the server code, the workspace packages, the built-in plugins, the prompts, and the worlds. Generated output, dependency directories, and task logs are not inputs.
- The build does not package the developer's `llm.toml` or other private server configuration. The staging check and the check of the unpacked installer both reject these files if they appear in the server resource root.
- The installed app always reads `llm.toml` from the user's config directory. This is true even if the file is created only after the first launch.
- If the built-in resource directory is missing, its position in the discovery order does not change. A user plugin does not get built-in plugin trust just because installed resources are missing.

### Startup smoke test

The startup smoke test runs twice: once with a generated temporary configuration, and once with no configuration at all. Neither run needs a model key, and neither calls a model. They check that:

- The ready message is received.
- The process exits cleanly when it receives a shutdown request, and also exits cleanly when the parent process disconnects.
- No built-in plugin fails to load, including a failure in the `[plugin-entry]` factory initialization.

> [!NOTE]
> A successful health check alone does not mean the test passed. A plugin can fail to load while the server keeps running normally.

## macOS

Electron 44 requires macOS 13 (Ventura) or later. The packaging configuration sets `mac.minimumSystemVersion: "13.0.0"` to match this requirement. The current build does not support macOS 12. See the [Electron 44 release notes](https://github.com/electron/electron/releases/tag/v44.0.0).

### Official unsigned build

The configuration in the repository sets `mac.identity: null` and `mac.notarize: false`. The release CI also sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. No signing certificate or Apple account is needed.

```bash
pnpm --filter @covel/desktop dist:mac
```

The artifacts are a `.dmg` and a `.zip` under `release/electron/`, for the `arm64` architecture. The app is not signed or notarized, so when a player opens it for the first time, they may need to confirm it in macOS "Privacy & Security".

### Optional future signing

If a maintainer gets an Apple Developer certificate in the future, use these electron-builder variables for a local signed build. The official release CI does not read them.

| Variable                      | Use                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`                    | Path (or https address) of the Developer ID Application `.p12` certificate                                  |
| `CSC_KEY_PASSWORD`            | The password of the `.p12`                                                                                  |
| `APPLE_ID`                    | The email address of the Apple Developer account                                                            |
| `APPLE_APP_SPECIFIC_PASSWORD` | An [app-specific password](https://support.apple.com/en-us/102654) (not the login password of the Apple ID) |
| `APPLE_TEAM_ID`               | The developer team ID (10 characters, for example `ABCDE12345`)                                             |

To make a signed and notarized build locally, first edit `apps/desktop/electron-builder.yml`. Change:

```yaml
mac:
  identity: null
  notarize: false
```

to the following (or delete the `identity` line, so it looks for a certificate automatically):

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

`apps/desktop/resources/entitlements.mac.plist` is the permissions file that the hardened runtime needs. It allows three things:

- V8's JIT.
- Starting a Node child process (`com.apple.security.cs.allow-dyld-environment-variables`).
- The local loopback network used by the built-in API server.

If you are not sure why an entry is needed, do not delete it.

## Windows

### Official unsigned build

The release CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and does not provide a certificate.

```bash
pnpm --filter @covel/desktop dist:win
```

The artifacts are an NSIS installer and a portable version, both x64, under `release/electron/`.

### Optional future signing

If a maintainer gets a Windows code signing certificate in the future, local builds can use these variables. The official release CI does not read them.

| Variable                   | Use                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CSC_LINK`                 | Path (or https address) of the `.pfx` code signing certificate                                         |
| `CSC_KEY_PASSWORD`         | The password of the `.pfx`                                                                             |
| `WIN_CSC_TIMESTAMP_SERVER` | Optional. The address of an RFC 3161 timestamp server (the default is `http://timestamp.digicert.com`) |

```bash
CSC_LINK=/path/to/cert.pfx \
CSC_KEY_PASSWORD=... \
  pnpm --filter @covel/desktop dist:win
```

### SmartScreen

The unsigned official build triggers Windows SmartScreen the first time it starts. There are two ways to handle this:

1. For now, have the player click "Run anyway" in the SmartScreen dialog.
2. In the future, buy a suitable certificate and add code signing in a later release.

## Linux

```bash
pnpm --filter @covel/desktop dist:linux
```

The artifacts are under `release/electron/`:

- `Covel-electron-<version>-linux-x64.AppImage` and `Covel-electron-<version>-linux-arm64.AppImage`
- `Covel-electron-<version>-linux-x64.deb`

GPG signing is not set up yet. If you need it for distribution:

```bash
# After building
dpkg-sig --sign builder release/electron/*.deb
```

## Verifying a build locally

### Two-step cleanup

Cleanup after packaging has two steps. This way, during a CI build the unpacked directory is still there for checking, and when you run `pnpm build:electron` locally, only the installer is left at the end.

1. **Step one**: the `afterAllArtifactBuild` hook (`apps/desktop/scripts/cleanup-artifacts.mjs`) deletes only the metadata used by auto-update: `*.blockmap`, `latest-*.yml`, and `builder-*.yml`. The unpacked directory `mac-arm64/` is kept, and `apps/desktop/scripts/verify-release.mjs` can check `Covel.app/Contents/Resources/...`.
2. **Step two**: `node apps/desktop/scripts/cleanup-artifacts.mjs --strip-unpacked`. The `build:electron` script in the root runs it **after** `electron-builder` returns. It deletes `mac-arm64/` and each `*-unpacked/` directory. Locally, only the `.dmg` and `.zip` are left.

CI does **not** run step two. It runs `electron-builder` directly, keeps the unpacked directories until the `Verify unpacked release resources` step, and then `actions/upload-artifact` uploads only the installers (on macOS, the `.dmg` and `.zip`; on Windows, the `.exe`).

### What the release CI checks

- On each platform, it checks the unpacked app resources first, and then uploads only the installers.
- The official build is unsigned, so there is no signature check.
- The release job writes a `SHA256SUMS.txt` for every `.dmg`, `.zip`, and `.exe`, and attaches it to the GitHub Release. Players verify a downloaded file with `shasum -a 256 -c SHA256SUMS.txt` (macOS) or `sha256sum -c SHA256SUMS.txt`. This list shows that the files match what the build job uploaded. It does not show who built them.
- The release job also records a build provenance attestation for the same set of files. `gh attestation verify <file> --repo ackness/covel` can confirm that a downloaded file was built by this repository's release workflow, and which commit it came from.

### Check the resources that electron-builder actually copied

After you make an unpacked macOS arm64 build locally, you can use the same smoke test to check the resources that electron-builder actually copied in:

```bash
node apps/desktop/scripts/verify-staging.mjs --electron-node \
  --resources release/electron/mac-arm64/Covel.app/Contents/Resources
```

Add `--no-llm-toml` to check the default behavior with no configuration, and the cleanup after the parent process disconnects. The smoke test's data goes into a temporary directory under the desktop staging directory. The app resources and user data are only read, never written.

> [!NOTE]
> The unpacked directory only exists before the second cleanup step. It is deleted once `pnpm build:electron` finishes. To keep it, run `pnpm --filter @covel/desktop dist:mac`.

### Offline startup

The packaged Web app does not send requests to a font service or to any third party when it starts:

- The Latin fonts (`@fontsource-variable/*`, about 530 KB of WOFF2, licensed under SIL OFL 1.1) are packaged in `dist/web/assets`.
- The built page ships with a content security policy. See [security boundaries](./security.md).

So the first launch looks the same with no network as it does online.

## Sidecar shutdown

The sidecar is the built-in server child process that the desktop app starts.

- When you quit the app normally, Electron ends only after the sidecar has exited. A restart goes through the same wait.
- On each platform, the server is asked to shut down by a private IPC message between the parent and child processes. SIGTERM is used as a fallback only when IPC is not available (on Windows, this fallback is a forced kill).
- When the sidecar finds that its IPC connection to the parent has dropped, it runs the same shutdown. So a crashed desktop app does not leave an orphan process holding the database.
- If the parent exits while the sidecar is still starting, the sidecar finds at the end of its initialization that IPC is already disconnected, and it shuts down right away.

Time limits:

| Stage                                                         | Limit                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| The server's own shutdown                                     | 10 seconds. After that, it forces an exit                                                     |
| The desktop app waits for the sidecar to finish shutting down | 12 seconds. After that, it sends SIGKILL                                                      |
| Confirming the exit after SIGKILL                             | Waits 1 more second. If no exit is seen, it reports an error and does not start a new sidecar |

An error while sending the signal does not count as "exit confirmed". The case where the operating system force-quits the app is outside this shutdown path.

The regression tests for process shutdown and repeated exits:

```bash
pnpm --filter @covel/desktop test
```

## Auto-update publishing

Automatic download and installation of updates is **not enabled**.

- `apps/desktop/electron-builder.yml` has `publish: null`.
- `apps/desktop/scripts/cleanup-artifacts.mjs` deletes `latest-*.yml` and `*.blockmap`.
- The final installers: on macOS, a `.dmg` disk image and a `.zip` containing the `.app`; on Windows, two `.exe` files, the NSIS installer and the portable version; a local Linux build produces the `.AppImage` and `.deb` set in the configuration.

The packaged app already checks GitHub once at each launch for a newer stable release. It then lets the player choose to open the download page or ignore that version. This notice does not download or install anything. See [desktop configuration](../reference/desktop-config.md#new-version-prompt).

To enable automatic updates in the future:

1. Delete `publish: null` in `apps/desktop/electron-builder.yml`, or replace it with a real publishing configuration.
2. Change `apps/desktop/scripts/cleanup-artifacts.mjs` to keep `latest-*.yml` and `*.blockmap`. They are on the delete list now.
3. Pass `GH_TOKEN` (or the credentials of the publishing service) in CI. Change `--publish=never` in the Release workflow to `--publish=always`.
4. Add the `electron-updater` dependency, and connect it in `apps/desktop/src/main.ts`.

## Release checklist

Follow the steps in order. Finish each step before you start the next one.

1. **Set the version number.** In a clean working tree, first run `pnpm release:prepare <version> --dry-run`, and then run `pnpm release:prepare <version>`. It does these things:
   - Sets the versions of the root, `apps/*`, and `packages/*`. Plugins and worlds keep their own versions, and they are not changed.
   - Updates the version badges and the "source version" line in `README.md` and `README.zh-CN.md`.
   - Compiles the changelog (the next step).
   - It refuses to run if the version is lower than the current one, or if the working tree has uncommitted changes. It does not commit, tag, or push.
   - Running it again with the same version only adds the fragments that were merged since the last run.
2. **Check the changelog.** This step inside `pnpm release:prepare` (running `pnpm changelog:release <version>` alone does only this step) moves the fragments in `docs/changelog.d/` and the entries under `[Unreleased]` into the `## [<version>] - <date>` section of `docs/CHANGELOG.md`, and then deletes the fragments. What you need to do:
   - Write a summary under the heading.
   - Check the `Breaking changes in v<version>` and `Upgrade notes for v<version>` sections that the README links to.
   - If new fragments are merged later, run this again before you create the tag.
3. **Update the upgrade notice in the README.** Rewrite the upgrade sentence for the current version in `README.md` and `README.zh-CN.md`. The script only changes the badges and the "source version" line, and it points out which lines still have the old version number. Check the Release links.
4. **Onboarding.** When the onboarding flow changes, increase `ONBOARDING_VERSION` in `apps/web/src/components/onboarding-wizard/constants.ts` by one.
5. **Local checks.** Run `pnpm check`, `pnpm test`, `pnpm test:pg`, `pnpm e2e`, and `pnpm release:preflight` in turn. Fix any known failures before you push.
6. **Build the desktop resources.** Run `pnpm --filter @covel/desktop build`.
7. **Player flow check.** Use isolated data and a real model to complete the [player flow check before a release](./e2e-testing.md#player-flow-acceptance-before-a-release). Deterministic tests and startup health checks cannot show that the game can be played.
8. **Restart smoke test.** In a session that has a desktop environment, run `pnpm --filter @covel/desktop smoke:restart`. Confirm that the version in preload is correct, and that the page moves to the new backend port.
9. **Release notes.** Confirm that the release notes say the macOS and Windows artifacts are not signed.
10. **Push and wait for CI.** After the local checks pass, push the reviewed pull request, and wait for CI and the PostgreSQL integration tests to pass.
11. **Trial package.** On the candidate branch, run the `Build Desktop` workflow by hand, with `publish_release=false`. Both platform jobs check the staging resources and the startup. Windows also runs a regression test of the package install API.
12. **Create the tag.** Merge the pull request, confirm that `main` is healthy, and then create and push an annotated `v*` tag on that merge commit. Pushing the tag triggers the build and publishes the GitHub Release.
13. **Check the checksum file.** Confirm that `SHA256SUMS.txt` is next to the installers in the Release. Run `gh attestation verify <installer> --repo ackness/covel` on one installer, and confirm that it passes.
14. **Download and review.** Download the published `.dmg`, `.zip`, installer, and portable `.exe`. Check the version and the digests, and repeat the startup check and the plugin lifecycle check on the downloaded packages.

The rules of the release workflow:

- A manually triggered build resolves the ref you give only once, and passes the resulting immutable commit to all the jobs.
- A release needs all of the following at once: an existing semantic version tag, a matching framework package version, the matching section in the changelog, and no fragments left in `docs/changelog.d/`.
- The workflow never creates or moves a tag.
- A trial run (`publish_release=false`) only builds the artifacts. It does not create a GitHub Release.

> [!IMPORTANT]
> Record the operating systems and the player flows that you actually verified. A successful build and passing API tests on Windows do not replace playing through the whole game on Windows.
