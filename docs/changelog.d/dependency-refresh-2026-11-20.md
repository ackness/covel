### Security

- **Server upgrades `@hono/node-server` to 2.1.8.** Patches the WebSocket upgrade `ECONNRESET` crash (`GHSA-qv5m-9pm6-hqp3`) and backslash request-path handling advisory (`GHSA-jpvv-r467-5p4w`) within the seven-day release-age policy.
- **Desktop upgrades to Electron 45.3.1 (Node 24.22.2, Chromium 156.0.8078.96) and Undici 8.12.4.** Picks up the eMudhra revoked RSA intermediate blocklist and latest Node 24/Undici patches. See [runtime and HTTP client updates](../en/internals/security.md#runtime-and-http-client-updates).

### Changed

- **Workspace dependencies are refreshed within the seven-day release-age policy.** Upgrades Hono 4.13.18, Vite 8.3.8, Vitest 5.1.0, `@json-render/*` 0.22.0, `i18next` 27.1.1, `react-i18next` 18.0.1, `jsdom` 31.0.1, `lucide-react` 1.72.0, `react-resizable-panels` 4.22.0, Tailwind CSS 4.3.5, Playwright 1.65.0, Mermaid 12.3.0, Turbo 2.11.11, oxlint 1.93.0, fallow 3.42.0, and Prettier 3.10.1. PostgreSQL's `postgres` client stays on 3.x.
