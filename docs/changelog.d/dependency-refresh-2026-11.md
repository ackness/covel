### Security

- **The desktop app runs on Electron 45.2.1, which embeds Node 24.22.1.** The packaged backend and the shell now get the Node 24.22.1 and Chromium 156.0.8078.75 security fixes that Electron 45.0.0 lacked. Provider and sidecar requests use Undici 8.12.3. See [runtime and HTTP client updates](../en/internals/security.md#runtime-and-http-client-updates).

### Changed

- **Stable dependencies are refreshed within the seven-day release-age policy.** Hono 4.13.16, Vite 8.3.5, electron-builder 26.18.1, i18next 26.7.1, react-i18next 17.1.11, lucide-react 1.66.0, json-render 0.21.4, TanStack Router, Dexie, parse5, Turbo, oxlint and fallow move to their latest eligible patch or minor releases. PostgreSQL's `postgres` client stays on 3.x.
