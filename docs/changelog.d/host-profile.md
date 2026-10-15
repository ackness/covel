### Breaking

- **A misspelled `DEPLOYMENT_TIER` stops the server at startup.** A value other than `self`, `demo` or `commercial` (case and surrounding spaces do not count) was read as `commercial`; the server now refuses to start and the error lists the accepted values. A hosted tier also refuses to start with `COVEL_ALLOWED_HOSTS` (the Host check runs only on `self`), and `commercial` with `COVEL_MEDIA_CLEANUP_ENABLED` (the cleanup endpoint stays closed there). Remove the setting or correct the tier. Rules: `docs/internals/security.md#host-profile`.

### Changed

- **The deployment form is decided once, at startup.** The server combines the tier, the storage it runs on and the tokens into a host profile (`apps/server/src/host-profile.ts`); route guards, media routes, server settings, a request's own model settings and trace retention ask it instead of reading environment variables. `@covel/ai-provider` receives its local-network and community-wire rules from the host (`configureProviderHostPolicy`) and no longer reads `DEPLOYMENT_TIER`. The desktop app always starts its server with `DEPLOYMENT_TIER=self`. A test lists every API route with the host actions it needs.
- **`POST /api/llm-config/reload` refuses a missing desktop token with `desktop_rest_token_invalid`**, the same code as the other desktop config routes (it was `unauthorized`; the status stays `401`).

### Security

- **Forking a session on a hosted tier needs the operator token (F-204).** `POST /api/sessions/:id/fork` creates a session, so it now asks what `POST /api/sessions` asks: on `demo` / `commercial` a session owner can no longer mint new sessions by forking their own. On `self` and the production MemoryStore, an owner still forks freely.
