### Changed

- **Desktop backends use the packaged Electron 45.0.0 executable with RunAsNode.** The backend remains a separate child process with private lifecycle IPC. Standalone Node downloads, the extra executable and license, and runtime-selection configuration are removed. Source and Docker deployments keep Node 26.12.1; macOS still requires 13.5 or later.

- **Windows release validation exercises Electron 45 directly.** Desktop regressions run on Windows, and the shipped ZIP backend is checked after extraction into a path with spaces and Chinese characters. ZIP/portable UI checks cover reload and record artifact sizes. Backend smoke checks bound HTTP requests, wait for child termination before cleanup, and retain ZIP backend logs on failure.

### Security

- **Electron 45 includes the eMudhra certificate blocklist and the verified Chromium Brotli decoder fix.** Its embedded Node 24.22.0 is not equivalent to the full Node 24.22.1 security release. Core npm Undici 8.12.2, URL normalization, and `dns.lookup` reduce exposure, while native plugin networking and specialized direct PostgreSQL configurations retain residual risk. See the runtime boundaries in `docs/internals/security.md`.

- **Desktop packaging disables Node CLI debugging arguments and restricts the app entry point to ASAR.** RunAsNode and custom-CA environment support remain enabled; managed child startup strips `NODE_OPTIONS`. These fuse settings do not provide signing or cryptographic ASAR integrity verification. Loopback sidecar HTTP requests also reject redirects.

### Upgrade notes

- **Rebuild the complete desktop application to receive the runtime change.** Target and actual Electron/Node versions, RunAsNode capability, main-bundle/ASAR binding, and child environment cleanup remain verified. Players do not need a separate Node installation, and existing save data does not need recreation.
