# Desktop packaging and release

This page explains how to build the Covel desktop app installer, how to check it locally, and which steps to follow to publish a release. It is written for maintainers and for contributors who want to package the app themselves.

The official GitHub Release publishes only two kinds of artifacts: macOS Apple Silicon and Windows x64. Neither has a **publisher certificate signature**, because the project has no platform signing certificate. macOS still retains the ad-hoc signature required to run on the machine. The first time a player opens the app, macOS Gatekeeper and Windows SmartScreen may show a warning. You can build the Linux artifacts yourself on a Linux machine with the same electron-builder configuration.

## One-off prep

1. Install the toolchain and dependencies in the repository root:

   ```bash
   pnpm install
   ```

2. Prepare the resources for packaging:

   ```bash
   pnpm --filter @covel/desktop build
   ```

   It generates `apps/desktop/dist/` and `apps/desktop/staging/`. The build does not download the model database over the network. It copies the LiteLLM snapshot that is committed in the repository, and it checks that `node_modules/@covel/ai-provider/data/model-db.json` exists in staging. The build acquires and verifies the target platform's Electron runtime.

   Desktop pins Electron 45.0.0. The backend uses the installer's own Electron executable. No extra Node executable or standalone Node license is downloaded or packaged. Players do not need to download a runtime or install Node at first launch.

3. Call electron-builder to package the app:

   ```bash
   pnpm --filter @covel/desktop dist
   ```

   Each platform has its own command. See [macOS](#macos), [Windows](#windows), and [Linux](#linux) below. Running `pnpm build:electron` in the repository root has the same effect, and it also deletes the unpacked directory at the end, so only the installer is left.

<a id="select-the-backend-runtime"></a>

### Backend runtime

The packaged app always starts its own Electron executable with `ELECTRON_RUN_AS_NODE=1`, running the backend in a separate child process. There is no runtime-selection configuration, environment override, or fallback Node. Development mode still uses an externally managed server. Source and Docker deployments retain their Node 26.12.1 requirement.

The build checks the actual Electron executable's Electron/Node versions, target platform and architecture, and RunAsNode fuse, not just its npm package version. Actual versions must match `ELECTRON_VERSION` (from the desktop package dependency) and `EMBEDDED_NODE_VERSION` compiled into `src/backend-runtime.ts`; target metadata does not store versions. RunAsNode must be enabled, and a mismatch fails. Electron 45.0.0 embeds Node 24.22.0, which must not be treated as containing every Node 24.22.1 fix based on its version. See [runtime and HTTP client updates](./security.md#runtime-and-http-client-updates) for verified patches and remaining boundaries.

Digests bind the main-process bundle to target resources. Reusing an old bundle or mixing target resources is rejected. Artifact verification reads the actual entry point and main bytes inside `app.asar`, not files from the source checkout. Every desktop-owned startup, restart, and crash recovery revalidates them. After upgrading Electron, rebuild the complete installer and run the artifact verification and startup smoke below. The upgrade alone does not establish platform runtime verification or signing support.

Packaging explicitly enables `runAsNode` and `enableNodeOptionsEnvironmentVariable`; the latter preserves `NODE_EXTRA_CA_CERTS` support. Child startup still strips `NODE_OPTIONS`. `enableNodeCliInspectArguments: false` disables Node CLI debugging arguments, and `onlyLoadAppFromAsar: true` restricts the app entry point to ASAR. These settings require verification in actual installers. Restricting the ASAR entry point does not provide signing or cryptographic ASAR integrity verification.

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
- When the server process restarts, the current page stays on screen, and the app shows the status. Windows backend launches hide the extra console window.
- Desktop health checks read only the response status and release unused response bodies within the request deadline, so polling does not retain connections.
- The native menu items "Import plugin" and "Import world" open **Settings → Install & manage**. Choosing a ZIP, validation, authorization, and the success or failure messages all go through the shared install flow. Copying a folder by hand is not an install method.

### How the packaged server starts

- The built-in server uses this installer's Electron executable with RunAsNode to execute precompiled `server/src/index.js`. It does not search the player's PATH or transpile framework modules at startup.
- Before every start, restart, or recovery, the app checks the main digest, target platform and architecture, actual Electron/Node versions, and RunAsNode fuse. Large-file hashing and fuse scanning read asynchronously. The child process starts only after verification finishes, and previous verification results are never reused. Missing, damaged, or mismatched resources produce a reinstall message, never a substitute runtime. After merging environment configuration, the app strips `NODE_OPTIONS`, `NODE_PATH`, and inherited Electron mode controls while retaining legitimate proxy settings, provider keys, and `NODE_EXTRA_CA_CERTS`.
- The build compiles framework modules beside their source in staging with at most four concurrent tasks. Only after all compilation succeeds does it rewrite runtime exports and remove successfully compiled `.ts` files. On failure it waits for active tasks to settle before reporting the error, without pruning. Relative model-data and prompt paths computed from `import.meta.url` stay unchanged.
- The `tsx` loader and its target esbuild executable remain in `resources/server/node_modules/` for dynamically imported TypeScript plugins. The loader is read only from `tsx/dist/loader.mjs` in that directory; a missing loader fails startup. The desktop main process no longer ships a separate dependency tree.
- After the HTTP port starts listening, the child process sends one private `covel:ready` message to the parent process, with the port number. When the desktop app receives it, it loads the app right away.
- Waiting for readiness fails in three cases: the child process exits, the IPC connection drops, or 30 seconds pass.

### Rules for the staging directory

- The staging directory owns its own files. After `pnpm deploy`, the build first replaces the hard links with independent copies, and only then rewrites the resource or cache output. Packaging and restoring the Turbo cache must not change the workspace source or the pnpm package store.
- After compilation, pruning removes only reviewed test, snapshot, and declaration locations. It retains third-party runtime source, Zod's source exports, every target architecture's native libraries, plugin and world content, language resources, and licenses. Before removing the duplicate `.pnpm` directory, it checks retained links and explicit runtime paths; a dependency on removed or host-only files fails the build.
- Main and preload npm dependencies are bundled and listed as desktop development dependencies. The build checks that emitted imports are only Node built-ins or Electron, and that retained server license texts and versions match the actual bundle inputs.
- The Turbo desktop task waits until the server build finishes. Its cache inputs include the server code, the workspace packages, the built-in plugins, the prompts, and the worlds. Generated output, dependency directories, and task logs are not inputs.
- The build does not package the developer's `llm.toml` or other private server configuration. The staging check and the check of the unpacked installer both reject these files if they appear in the server resource root.
- The installed app always reads `llm.toml` from the user's config directory. This is true even if the file is created only after the first launch.
- If the built-in resource directory is missing, its position in the discovery order does not change. A user plugin does not get built-in plugin trust just because installed resources are missing.
- Each target platform and architecture gets its own `staging/backend-runtime/<os>-<arch>/` directory. The packaging hook selects the actual target rather than copying the build host's runtime into another architecture's installer. Staging and unpacked-resource verification check Electron/Node versions, platform, architecture, and resource and digest rules.

### Startup smoke test

The startup smoke test runs twice: once with a generated temporary configuration, and once with no configuration at all. Each preflight checks resources and scans the RunAsNode fuse once before probing versions; the next smoke run checks everything again. Neither run needs a model key, and neither calls a model. They check that:

- The actual bundled Electron RunAsNode and SQLite are used, and sqlite-vec is available. A missing runtime or failed verification is an error, not a fallback to host Node or the memory backend.

- The ready message is received.
- The process exits cleanly when it receives a shutdown request, and also exits cleanly when the parent process disconnects.
- No built-in plugin fails to load, including a failure in the `[plugin-entry]` factory initialization.

Health and plugin-list requests each have a five-second deadline covering the response body and reject redirects. On failure, the check waits for the child to exit before deleting its temporary database. Windows ZIP backend checks preserve output logs on both success and failure.

> [!NOTE]
> A successful health check alone does not mean the test passed. A plugin can fail to load while the server keeps running normally.

## macOS

The desktop app still requires macOS 13.5 (Ventura) or later, with `mac.minimumSystemVersion` kept at `"13.5.0"`. Removing the extra Node runtime does not lower the declared system requirement; older versions need separate validation.

### Official unsigned build

The configuration in the repository sets `mac.identity: null` and `mac.notarize: false`. The release CI also sets `CSC_IDENTITY_AUTO_DISCOVERY=false`. No signing certificate or Apple account is needed.

“Unsigned” here means no Developer ID publisher signature and no notarization. It does not mean the executable lacks an ad-hoc signature. Changing fuses invalidates the existing ad-hoc signature of an Apple Silicon binary. `electronFuses.resetAdHocDarwinSignature: true` resets it afterward; otherwise macOS can terminate startup with `SIGKILL (CODESIGNING)`. An ad-hoc signature neither proves publisher identity nor removes Gatekeeper warnings.

```bash
pnpm --filter @covel/desktop dist:mac
```

The artifacts are a `.dmg` and a `.zip` under `release/electron/`, for the `arm64` architecture. The app has no Developer ID signature or notarization, so when a player opens it for the first time, they may need to confirm it in macOS "Privacy & Security".

### Optional future signing

Official macOS builds retain only ad-hoc signing; Developer ID signing and notarization have not been verified. Removing the extra Node executable does not establish publisher-signing support.

Changing `identity` / `notarize` alone does not prove signing works. A future integration must verify whole-app signing and notarization, the RunAsNode fuse, unpacked resources, and actual launch. Preserve the digest binding between the main-process bundle and resources.

### Entitlements

`apps/desktop/resources/entitlements.mac.plist` retains these declarations for review in a future signing flow:

- Exceptions for V8 JIT, unsigned executable memory, and disabled library validation.
- `com.apple.security.cs.allow-dyld-environment-variables` lets the dynamic linker use `DYLD_*` environment variables; it is not permission to start child processes.
- Outbound networking and inbound networking for the built-in API server.

Official artifacts have no Developer ID signature and are not Mac App Store sandboxed apps. Keeping these plist entries and the `hardenedRuntime` setting does not establish signed runtime hardening for current artifacts. Their necessity and actual effect require verification in a future signing flow.

## Windows

### Official unsigned build

The release CI sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and does not provide a certificate.

```bash
pnpm --filter @covel/desktop dist:win
```

The artifacts are under `release/electron/`, all x64:

| File                                            | Purpose                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Covel-electron-<version>-win-x64.exe`          | Recommended NSIS installer. After installation, the portable launcher does not extract the app again.                  |
| `Covel-electron-<version>-win-x64.zip`          | No-install folder. Choose “Extract All”, then run `Covel.exe` from that folder and keep its other files together.      |
| `Covel-electron-<version>-win-x64-portable.exe` | Single-file self-extractor. Extracts on every launch and cleans up on exit; it does not cache the previous extraction. |

The single-file build uses NSIS `portable.splashImage` to show a static preparation notice during extraction. This is not a progress bar and cannot guarantee visibility before SmartScreen or antivirus scanning. Electron starts after the notice closes, so a gap between them remains possible. ZIP avoids repeated extraction, not the app's or backend's startup time. All three forms use the same data-directory rules; saves do not move beside the EXE.

After editing `apps/desktop/resources/portable-splash.svg`, run this command to generate a 640×300, 24-bit BMP. Inspect its text and colors, then commit it with the SVG. NSIS reads the BMP directly; the generator does not run on players' machines:

```bash
pnpm --filter @covel/desktop exec electron scripts/generate-portable-splash.mjs
```

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

Linux installers depend on the system libraries required by Electron and server native modules. The deb uses electron-builder's nine default dependencies without a `deb.depends` override or extra `libatomic1` / `libstdc++6` declarations for standalone Node. AppImage users still need the required libraries installed on the host. This is neither a musl/Alpine runtime nor a package independent of system libraries. Verify each architecture's installer on its corresponding platform. A startup check on the build host does not verify another architecture.

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

CI does **not** run step two. It runs `electron-builder` directly, keeps the unpacked directories until the `Verify unpacked release resources` step, and then `actions/upload-artifact` uploads only distribution files (on macOS, `.dmg` and `.zip`; on Windows, `.exe` and `.zip`).

### What the release CI checks

- On each platform, it checks the unpacked application's entry point and resources, then boots the backend with its Electron RunAsNode to verify SQLite, the vector extension, and plugin loading. Only then are installers uploaded. Each bundled plugin must retain its root `PLUGIN.md`; a nested manifest or translation file alone cannot replace it.
- Windows also runs `apps/desktop/scripts/verify-windows-artifacts.mjs`, launching the real ZIP's `Covel.exe` and the single-file self-extracting EXE separately. It requires native preparation feedback, an actually visible, non-minimized app window in the owned process tree, the world list and an actionable session-start button, then checks that the entire process tree exits. It uses isolated data directories and makes no paid model call. The ZIP is extracted into a path with spaces and Chinese characters; its own `Covel.exe` first boots the backend with and without configuration, before UI and reload checks. Evidence includes `size.json` with the artifact size and, for the ZIP, total extracted file bytes. The Windows release job also runs desktop regressions and plugin/world installation API tests; the latter do not exercise the NSIS installer wizard.
- This Windows check needs an interactive, unlocked desktop; unavailable native pixels or visible windows fail it. Screenshots and logs upload separately as `covel-windows-startup-evidence`, not as release installers. A macOS build, API checks, or renderer screenshots cannot replace this native Windows evidence.
- Official builds have no publisher certificate signature, so publisher identity is not verified. Actual macOS startup must still validate the ad-hoc signature after fuse changes.
- The release job writes a `SHA256SUMS.txt` for every `.dmg`, `.zip`, and `.exe`, and attaches it to the GitHub Release. Players verify a downloaded file with `shasum -a 256 -c SHA256SUMS.txt` (macOS) or `sha256sum -c SHA256SUMS.txt`. This list shows that the files match what the build job uploaded. It does not show who built them.
- The release job also records a build provenance attestation for the same set of files. `gh attestation verify <file> --repo ackness/covel` can confirm that a downloaded file was built by this repository's release workflow, and which commit it came from.

### Check the resources that electron-builder actually copied

After you make an unpacked macOS arm64 build locally, you can use the same smoke test to check the resources that electron-builder actually copied in:

```bash
node apps/desktop/scripts/verify-staging.mjs \
  --resources release/electron/mac-arm64/Covel.app/Contents/Resources
```

Add `--no-llm-toml` to check the default behavior with no configuration, and the cleanup after the parent process disconnects. The smoke test's data goes into an isolated directory under the operating system's temporary directory. The app resources and user data are only read, never written.

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
- An in-flight version check responds to backend shutdown by cancelling its network request. This prevents a quick restart from exhausting the drain budget on that request and skipping storage cleanup.
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
- The final distribution files: on macOS, a `.dmg` disk image and a `.zip` containing the `.app`; on Windows, two `.exe` files for the NSIS installer and self-extractor, plus a no-install folder `.zip`; a local Linux build produces the `.AppImage` and `.deb` set in the configuration.

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
9. **Release notes.** Confirm that release notes state that macOS artifacts have no Developer ID signature or notarization, and Windows artifacts have no publisher certificate signature.
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
