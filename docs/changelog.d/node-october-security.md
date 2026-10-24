### Security

- **Source and Docker deployments use Node 26.12.1.** The minimum supported Node 26 version, mise, CI and Docker pins now include the October 2026 security fixes, including the native Brotli decoder fix. The Docker image remains pinned by digest.
- **Malformed compressed HTTP responses no longer terminate Covel through the affected Undici client.** Provider traffic and the desktop shell's sidecar client use npm Undici 8.12.2. Transitive Undici 6.x and 7.x copies receive their corresponding security releases without changing major versions. Exact reviewed security versions bypass the usual seven-day dependency delay.

### Fixed

- **Development desktop shells no longer offer to restart an externally managed backend.** The Desktop and Install & manage panes explain that the developer must restart `pnpm dev`; direct restart requests are rejected without changing the server or port.
- **Quick desktop restarts cancel an in-flight update check.** A stalled GitHub response no longer consumes the backend's shutdown budget and prevents its storage-close phase.

### Upgrade notes

- **Update the runtime as well as the source or dependencies.** Source deployments need Node 26.12.1 or a newer 26.x security release; rebuild and restart Docker deployments. Desktop users need a rebuilt application to receive its Node, Electron, and HTTP-client updates; they do not need to install Node separately. No save-data recreation is required.

### Breaking

- **macOS desktop builds now require macOS 13.5 or later.** This declared minimum remains in place when the backend uses Electron RunAsNode.
- **Desktop staging checks no longer accept `--electron-node` or `COVEL_SMOKE_HOST_NODE`.** They always verify and run bundled Electron with RunAsNode and SQLite; missing or mismatched runtime resources fail the build.
