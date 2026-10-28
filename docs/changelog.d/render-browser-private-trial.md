### Added

- **Players on a public trial see where their saves and keys go.** When `/api/health` reports a shared server whose saves stay in the browser, the web app shows a dismissible notice: saves and API keys are kept in the browser, the server never writes keys to disk, a database or its logs, and the server may restart at any time. It links to the new "Play on a public trial" page and, when configured, to the exact source commit the instance runs. Each provider's key form in Settings → LLM → Providers & Models keeps the docs link after the notice is dismissed.
- **`/api/health` reports `deployment`.** `deployment.form` is `personal`, `browser-private` or `hosted`; `deployment.source` carries `COVEL_SOURCE_REPOSITORY` and `COVEL_SOURCE_COMMIT` (falling back to Render's `RENDER_GIT_COMMIT`) when they are valid. Fields: `docs/reference/api.md`.

### Changed

- **The Render blueprint deploys a playable public trial on the free plan.** `render.yaml` now runs the browser-private form (`DEPLOYMENT_TIER=self`, `STORE_BACKEND=memory`) instead of an operator-only `demo` host, listens on Render's port 10000, caps the V8 heap for 512 MB instances and names its source repository. Steps and limits: `docs/start/deploy-render.md`.
- **The Docker image starts one Node process.** The container runs `node --import tsx src/index.ts` instead of `pnpm exec tsx`, which saves about 100 MB at idle and delivers stop signals to the server directly.
- **`operatorTokenRequired` is `true` on every shared form.** A browser-private server now reports it, so the web settings show "Operator Access" and hide the media library there, as on hosted tiers.

### Security

- **The browser-private form keeps open only what visitors do with their own keys and saves.** Approving or running community plugin server code, diagnostics (including `GET /api/provider-keys`), model database refresh, host configuration and media cleanup now need the operator token, and server settings cannot be written. Creating sessions, generating worlds and listing or testing models stay open. Model endpoints may no longer resolve to loopback or private addresses there, and the Host check is off because session owner tokens are the boundary. Rules: `docs/internals/security.md#host-profile`.

### Documentation

- **New pages explain the public trial.** "Play on a public trial" (`docs/start/hosted-trial.md`) tells players what stays in the browser, what lives only in server memory, how their API key is used and who could obtain it. "Deploy a trial on Render" (`docs/start/deploy-render.md`) gives the operator's steps, free-plan limits and what not to configure. `docs/internals/storage.md` lists the browser-private data that never reaches a checkpoint, and `docs/internals/security.md` documents the in-memory credential handoff to background jobs.

### Upgrade notes

- **A browser-private server refuses to start with `COVEL_ALLOWED_HOSTS`.** The Host check no longer runs on a production server with `STORE_BACKEND=memory`, so the setting has no effect; remove it.
