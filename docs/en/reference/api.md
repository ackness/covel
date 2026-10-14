# HTTP API

The Covel server has one HTTP JSON API. The web app and the desktop app both use it. So you can play a whole game without the interface, just by sending HTTP requests.

This page lists every endpoint, request field, response, and error code. Use it when you write a script, build your own client, or find out why a request failed. If this is your first time, follow the [Quick start](#quick-start) first.

**How to call it on your machine**

- Address: after `pnpm dev:server` starts, it is `http://localhost:3001/api/`.
- Request body: JSON, with `Content-Type: application/json`.
- Authentication: a local machine needs no token by default. Only a hosted deployment (`DEPLOYMENT_TIER=demo` or `commercial`) needs the session's owner token or the operator token. See [Authentication: session owner token](#authentication-session-owner-token).
- A turn is not a plain request and response. Sending a message, starting a game, and submitting a choice all go through `POST /api/actions`. The response is an SSE stream.

**How this page is organized**

| Section                                                   | What it covers                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Overview](#overview)                                     | Storage backends, the shared format for responses and errors, authentication |
| [Personal configuration API](#personal-configuration-api) | Model configuration, server settings, whether provider keys are set          |
| [Quick start](#quick-start)                               | Using `curl` from creating a session to several rounds of conversation       |
| [Endpoint list](#endpoint-list)                           | All endpoints grouped by feature, one line each                              |
| [Details](#details)                                       | Fields, examples, and error codes for the common endpoints                   |
| [SSE protocol](#sse-protocol)                             | Event types and the envelope format                                          |
| [Storage modes](#storage-mode-notes)                      | Three ways to deploy, environment variables, config file endpoints           |

**Find an endpoint by task**

| I want to...                                         | Endpoint                                                 | Section                                                        |
| ---------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| Check that the server is running                     | `GET /api/health`                                        | [Health check](#health-check)                                  |
| List, create, or change worlds                       | `GET` / `POST /api/worlds`, `PATCH /api/worlds/:id`      | [World management](#world-management)                          |
| Create, list, or delete a session                    | `POST` / `GET /api/sessions`, `DELETE /api/sessions/:id` | [Session management](#session-management)                      |
| Start a game, send a message, submit a choice        | `POST /api/actions`                                      | [Turn execution](#turn-execution)                              |
| Interrupt or steer a turn that is running            | `POST /api/sessions/:id/abort`, `/steer`                 | "Mid-turn control (W4)" in the endpoint list                   |
| Answer a form or choice shown during a turn          | `POST /api/actions` (`submit_interaction`)               | [Player interaction](#player-interaction)                      |
| Read the chat history                                | `GET /api/sessions/:id/messages`                         | [Message history](#message-history)                            |
| Read state tables and characters                     | `GET /api/sessions/:id/state`, `/characters`             | [State query](#state-query), [Character data](#character-data) |
| Turn plugins on or off for a session                 | `PUT` / `DELETE /api/sessions/:id/plugins/:pluginId`     | [Session plugin management](#session-plugin-management)        |
| Call a plugin's manual feature                       | `POST /api/sessions/:id/plugin-rpc`                      | [Plugin RPC channel](#plugin-rpc-channel)                      |
| Approve or reject a plugin's request                 | `POST /api/approvals/:approvalId/decision`               | [RPC approval flow](#rpc-approval-flow)                        |
| Read and write a plugin's own data                   | `/api/sessions/:id/plugin-data/...`                      | "Plugin Data" in the endpoint list                             |
| Save a game, branch a game                           | `POST /api/sessions/:id/snapshots`, `/fork`              | "Snapshot / Fork" in the endpoint list                         |
| Subscribe to live events for a session               | `GET /api/events/stream?sessionId=...`                   | [Event system](#event-system)                                  |
| Test a model connection, or have AI generate a world | `POST /api/ai/ping`, `/api/ai/generate-world`            | [AI generation](#ai-generation)                                |
| See what happened in a turn                          | `GET /api/traces/:sessionId`                             | [Trace debugging](#trace-debugging)                            |
| Manage images and other media                        | `/api/media/...`                                         | [Media management](#media-management)                          |
| Install a plugin or a world                          | `/api/install/...`                                       | "Plugin and world install" in the endpoint list                |
| View or change configuration                         | `/api/config/...`, `/api/llm-config`                     | [Configuration info](#configuration-info)                      |

**Basic checks on the request body**

- For endpoints that expect a JSON object, a `null`, an array, or a single value gets `400` at once. It never reaches the handler.
- An approval decision first checks that `decision` and `scope` are valid values. Only then is the pending approval used up.
- An event injection first checks that each identifier is a string and that `payload` is an object. Only then is the event published.

## Overview

- **Base URL**: `http://localhost:3001/api/`
- **Protocol**: HTTP JSON API (`Content-Type: application/json`)
- **Server framework**: [Hono](https://hono.dev/)

### Storage backends

The environment variable `STORE_BACKEND` decides where the server keeps its data:

| Backend    | Value              | Use                                                                                       |
| ---------- | ------------------ | ----------------------------------------------------------------------------------------- |
| SQLite     | `sqlite` (default) | Local development and single-machine deployment. Data is in `./data/covel.db`             |
| Memory     | `memory`           | Tests, and temporary runs in browser private mode. Data is lost when the process restarts |
| PostgreSQL | `pg`               | Production. Needs `DATABASE_URL`                                                          |

Two more points:

- In browser private mode, the server uses `memory`. The data is kept by BrowserVault in the browser.
- When you run several instances with `pg`, the `pg_advisory_lock` session lock is turned on automatically. Different Node processes never write to the same session at the same time.

> [!NOTE]
> `idb` is not a storage backend for the server. It is used only in the browser, to store data for MediaStore and BrowserVault. Server deployments use only `memory`, `sqlite`, and `pg`.

### Limits of running several instances

When you choose `pg`, the data is shared, and some coordination between processes is also in place. But not every feature becomes a shared service.

| Feature                              | Memory / SQLite                                           | PostgreSQL with several instances                                                     |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Write lock for a session             | A lock inside the process, for single-process deployments | An advisory lock on the shared database                                               |
| Delivering events to SSE subscribers | Broadcast only within the current process                 | Forwarded through PG `LISTEN/NOTIFY`                                                  |
| `steer` / `abort` for an active turn | Works on the execution handle the current process holds   | Still valid only inside the process                                                   |
| Background job `_runtime_jobs`       | Whether a job survives depends on the storage backend     | Claimed through CAS and a renewable lease                                             |
| Media binary data                    | Decided by the separate `MEDIA_BACKEND`                   | `mirror` stores it in PG; files in a local media backend are not shared automatically |

Details for the PostgreSQL column:

- **Event delivery**: if `LISTEN/NOTIFY` fails to start, the server refuses to start. It does not quietly fall back to broadcasting inside the process.
- **`steer` / `abort`**: the request must reach the instance that is running that turn. If it reaches another instance, it returns `409`, even when the database shows the turn as running.
- **Background jobs**: this includes detached stages, and runtimes that run in the background when triggered manually or by an event. Tasks in `claimed` / `running` / `committing` whose lease has expired are marked `orphaned`. Their effects, which already went out, are not replayed automatically.

So a deployment that must control the current turn reliably should use a single instance. Or it must make sure that an action and its `steer` / `abort` requests are routed to the same instance. When an instance exits, its execution handle in memory cannot move elsewhere. The database is shared, but that does not mean another instance can take over a turn that is running.

For how jobs recover, see [Protocol](./protocol.md). For which side, the browser or the server, holds the data of record, see [Storage Architecture](../internals/storage.md).

### Response format

All normal JSON endpoints use the same outer structure:

| Case                                              | Response                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| Get, create, or replace one resource              | Returns the resource object directly, with no `{ resource: ... }` wrapper |
| List a collection                                 | `{ "items": [...] }`                                                      |
| Command or delete that makes no separate resource | `{ "ok": true, ... }`, with only the useful confirmation fields           |
| Aggregate view                                    | Keeps its own fields. It is not a plain resource list                     |

- When a collection is paged by cursor, it has one more opaque string, `nextCursor`. To get the next page, pass it back unchanged: `?cursor=<nextCursor>`.
- Examples of aggregate views: the `tables` of state, the `turns` of a trace, the `slots` of a UI spec, and the `slots` / `providers` of LLM config.

Success status codes:

| Status code    | When                               |
| -------------- | ---------------------------------- |
| `201 Created`  | Usually a new resource was created |
| `202 Accepted` | Accepted, handled asynchronously   |
| `200 OK`       | Other successful requests          |

Every failure uses a non-2xx status code, plus this error envelope:

```jsonc
{
  "error": "string", // Required: a human-readable error message
  "code": "snake_case", // Optional: a stable, machine-readable error code
  "details": {}, // Optional: structured diagnostics (for example, an array of Zod validation errors)
}
```

`error` is always present. Endpoints that clients must handle by error code (such as `plugin-rpc` and `media`) also return `code`.

Some errors are the same across the whole site:

| Status code | Response body                                                          | When                                                |
| ----------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| 413         | `{ "error": "Payload Too Large" }`                                     | The request body is over the limit                  |
| 503         | `{ "error": "Session is busy, please retry", "code": "session_busy" }` | Waiting for this session's execution lock timed out |
| 404         | `{ "error": "Session not found: <id>", "code": "session_not_found" }`  | The session does not exist                          |

- **Request body limit.** A request over the limit never reaches the handler. A request with `Content-Length` and a streamed request without it share the same allowance.

  | Path                                           | Limit  |
  | ---------------------------------------------- | ------ |
  | Normal API                                     | 1 MiB  |
  | `/api/install` and its sub-paths, `/api/media` | 20 MiB |
  | `PUT /api/sessions/:id/browser-checkpoint`     | 64 MiB |

- **`session_busy` can be retried. It is not a server fault.** Any route that times out waiting for the lock (30 seconds by default on a PG deployment) returns it. For example, when the background is generating media, the lock is normally held for several minutes. During that time a player's action runs into it. Do not count it as a 5xx failure in monitoring. The original error message includes the sessionId and an internal module name. It is written to the log only, and is not returned to the caller.
- **`session_not_found` is the same on every session endpoint.** Session endpoints with `:id` in the path, and endpoints that put the session ID in the query or the body, all return the same `code`.
- **`plugin-rpc` 4xx and 5xx responses use this envelope too.** The `status` field in its response appears only in 2xx business results.
- **Unknown exceptions return 500.** The plugin RPC and install routes handle only the errors they recognize locally: validation, authorization, queue, and HTTP domain errors. Other exceptions go to the global handler. The log records the method, the redacted URL, and the stack. In production, an unknown exception returns only `500 Internal server error`. File permission errors and database errors are not rewritten to 400 by the installer.
- **`200` with `ok: false` is not an API failure.** A connectivity probe or a config reload may return `200 { "ok": false, "error": "..." }`. That means "the request ran successfully, but the thing being probed is not available."

### Authentication: session owner token

On your own machine (`DEPLOYMENT_TIER=self`, the default) and in the desktop app, you can use every endpoint without any token. The rules below mainly affect hosted deployments.

**What the owner token is**

When `POST /api/sessions` creates a session, the server generates an owner token that cannot be guessed. It is returned in the `ownerToken` field of the response. It appears only in that one response. The server stores only its SHA-256 hash.

Metadata private to the framework never appears in any response. The owner hash, approval and session incarnation, lifecycle, and delete lease are removed from the session create, read, update, and delete responses, from snapshots, and from the virtual tables in `/state`.

**How each deployment tier is checked**

| `DEPLOYMENT_TIER`          | Behavior                                                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `self` (default) / desktop | Usually not checked. A token, if sent, is not verified. For the exception, see "Production MemoryStore exception" below |
| `demo` / `commercial`      | Checked every time                                                                                                      |

`self` and the desktop rely on network boundaries. By default the server listens only on the loopback address (`COVEL_BIND_HOST=127.0.0.1`, see [env-registry](./env-registry.md)), and it answers only requests whose `Host` is `localhost`, `127.0.0.1`, `[::1]` or listed in `COVEL_ALLOWED_HOSTS`. Other requests get `403 { code: "host_not_allowed" }`.

Rules for `demo` / `commercial`:

- For every session-scoped endpoint, a missing or wrong token returns `401 { code: "session_owner_required" }`. If the session does not exist, it returns 404.
- "Session-scoped" covers two kinds:
  - Paths that include the session ID: session create, read, update, and delete, messages, traces, actions, plugin-rpc, steer / abort, SSE subscribe, snapshots, state, and so on.
  - Endpoints where the session ID is in the query or body, or is referenced indirectly: the approvals list, revoke, and decision; `POST /api/media?sessionId=`; `/api/worlds/:id/world-data/preflight`, `sync-data`, and `sync-dimensions`; `GET /api/ui-specs?sessionId=`.
- Historical sessions with no saved hash are always refused.
- `GET /api/sessions` returns content only to callers with the operator token. Anyone else gets an empty list.
- `POST /api/sessions` to create a session needs the operator token. If it is missing, it returns `401 { code: "operator_token_required" }`.

> [!NOTE]
> Creating a session needs the operator token. This is a gate for "only one operator." Full user identity, tenant isolation, and quotas are not built yet.

**Production MemoryStore exception**

Even when `DEPLOYMENT_TIER=self`, if `NODE_ENV=production` and the storage actually in use is MemoryStore:

- Sessions still require the owner token.
- Creating, changing, and deleting global worlds, importing dimensions, and saving after server-side generation all require the operator token.
- If no operator token is configured, world writes stay off. Public reads and valid session access still work as usual.

This check looks at the storage backend the server actually injected. It does not look at the request parameters, or at the `STORE_BACKEND` environment variable, which may not match the running instance.

**How to send the token** (choose one):

1. `Authorization: Bearer <ownerToken>`
2. `X-Session-Token: <ownerToken>`
3. `?session_token=<ownerToken>` query parameter (for EventSource and SSE clients that cannot set headers)

**Operator master token**

After `COVEL_DESKTOP_REST_TOKEN` is set, treat its value as a Bearer token:

- It passes the owner check of any session. Admin tools and the e2e harness use it.
- On hosted tiers, it is also the credential for these operations:
  - Creating a session
  - Writing worlds, importing dimensions
  - AI world generation
  - Probing and refreshing models
  - Checking whether a provider key is set (`GET /api/provider-keys`)
  - Activating the server code of a community plugin

The ESM code of a community plugin registers global capabilities inside the server process. So on hosted tiers, activating it requires both the owner token and the operator token. This is the current "one operator" trust model. It does not provide a code sandbox for multiple tenants.

If `DEPLOYMENT_TIER=demo|commercial` starts without this token configured, `validateSecurityPosture` refuses to start.

A web-only client can enter or clear this token under **Settings → Operator Access**:

- The credential is stored only in the `localStorage` of the current browser.
- It is sent as `Authorization: Bearer <token>` only on same-origin requests that need the operator token, as listed above.
- After saving or clearing, the client reloads, and uses the new credential to fetch sessions and world data again.
- Development mode and the desktop single-user mode can still run without a token. Production MemoryStore follows the exception above.

**How the web client saves the owner token**

If you write your own client, you can follow this approach:

- Where it is stored: by sessionId, in a separate IndexedDB database named `covel-browser-credentials`. It is not put in the display cache, the game checkpoint, or the settings export. The client does not read tokens in the old format from localStorage. Development sessions that use an old-format credential must be rebuilt.
- Creation: the create operation returns only after the credential write finishes. If a late response arrives for the same ID, it must not overwrite a newer credential that another operation has already saved.
- Reads and writes are both asynchronous. `clearSessionToken(sessionId, capturedToken)` checks and then deletes the captured token in one transaction. If the current token is unknown or different from it, it is left alone.
- Deleting a session: the HTTP request uses the same captured token. Only when the request succeeds, or when a 404 confirms the session is gone, is the credential cleaned up. Auth failures and other failures keep the credential. A failed cleanup does not undo the delete on the server. If a second delete then gets 404, you can retry the cleanup.
- Retries and cancellation: transport retries of the same request reuse the request headers already captured. A failure to store the credential is not treated as a network failure and is not retried. If reading the credential is cancelled, no request is sent.

Checks when deleting a world:

- Whether the world delete succeeds, partly fails, or the world is already gone, the client checks the session credentials saved in this browser.
- Each check request carries the captured owner token. Only when a session `GET` clearly returns `404` with `code: "session_not_found"` is the captured value cleaned up.
- The session list on the server may hide sessions. So it cannot be used as proof that a session does not exist. The credential table also does not record which world a session belongs to.
- Sessions deleted earlier, or deleted on another device, are reclaimed as well. Records that still exist, fail auth, or cannot be confirmed are kept.
- All check requests share a 3-second deadline, and are not retried.
- A failed check or cleanup does not change the result of the world delete itself. Logs for a failed check report only a count. Storage read failures report only a generic diagnostic. Neither contains credentials, identities, or response bodies.

Checks after creating a session:

- The create response must include the current `incarnation`.
- After the credential is saved, the client uses the token it just received to check this identity. This handles the case where the create response arrives later than the cleanup from a world delete.
- If the session is confirmed not to exist, or its identity has changed: clean up the captured value, and report that this creation is no longer valid.
- If the check cannot be made: keep the credential that was created and saved, and record a diagnostic.
- These checks are not a distributed transaction between client and server. If the client is offline, or the session is deleted later somewhere else, you still have to wait for the next operation to confirm it.

**Server-code grant for a community plugin is per session, but takes effect per process**

When a player approves a community plugin to run server code, two things happen with different scopes.

The approval record is saved by `(sessionId, session incarnation, pluginId, action)`. The `session incarnation` is a random nonce private to the server (for historical sessions, the hash of the owner token is used instead). It does not appear in API responses.

The action it approves is to `import()` the plugin's server code into the Node process. An ESM module loads only once, and the entry factory runs only once (remembered by pluginId). So the first session that approves this plugin installs the tools, RPC handlers, and media wires it registers into a **process-level** registry. Later sessions do not need to approve it again to see those registrations.

So the boundary has two layers:

| Layer                                                  | Scope                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **Code loading / capability registration**             | Process-level, one time, cannot be revoked. One session's approval is enough |
| **Calls (RPC dispatch / runtime loading / hook runs)** | The grant is still checked each time, for the session that makes the request |

A session without approval does not pass the `covel:plugin-server-code` and `runtime:<name>` checks. Hooks are also skipped (they return `continue`).

**Revoke boundary**

`DELETE /api/sessions/:id/approvals` and disabling a plugin both revoke the grant. They do this by:

1. Inside the session lock, rotating the saved session and plugin grant generation.
2. Clearing the grants cached per session in the current process, the one-time grants, and the pending approvals.

Result:

- Other pods that still hold an old grant in memory refuse it, because the generation does not match.
- Making a decision with an old approvalId returns `409 approval_scope_changed`.
- Revoking does **not** unload modules that were already imported, and does not unregister the tools, RPC handlers, and wires already registered. JavaScript has no reliable way to unload a module. Code already in the process goes away only after a restart.
- A process restart clears all volatile grants (see the [Snapshot / Fork](#snapshot--fork) section).

Under the "one operator" model this is acceptable. Approving community code means trusting it to run in this process. Isolation between tenants needs a real code sandbox, which is not built yet.

> [!IMPORTANT]
> CORS (`CORS_ORIGIN`) is only a browser policy. **It is not authentication.** The real authorization boundaries are the owner token, the deployment tier, and loopback listening.

CORS can only stop a web page from reading a response. So there is a separate check on where writes come from:

- Applies to: `POST` / `PUT` / `PATCH` / `DELETE` requests that carry an `Origin` header.
- Rule: if the `Origin` is not in the allow list, and is not the host the request is for (`Host` or `X-Forwarded-Host`), it returns `403 { "code": "origin_not_allowed" }` before any route runs.
- Non-browser clients that send no `Origin` header are not affected.

## Personal configuration API

This section covers the endpoints for model configuration and personal settings.

**`GET /api/llm-config`** returns the model slots in effect now. Fields:

| Field                              | Description                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverKeyConfigured` in each slot | Boolean. Whether the server has a key configured for it                                                                                                                            |
| `source`                           | `{ kind: "file" \| "builtin", path }`. Whether the config comes from a file or from the built-in defaults                                                                          |
| `error`                            | Optional. An error from loading the config                                                                                                                                         |
| `envKeyOverrides`                  | A list of provider IDs. On the desktop app, when a key saved in Settings is overridden by a server environment variable, the ID is listed here, and Settings shows a notice for it |

**`POST /api/llm-config/reload`** reads the config file again. If the TOML is valid, it takes effect in place. If it is invalid, it returns `ok: false` and keeps using the config currently in effect.

Settings in the interface are only override values sent along with the request. They are not written into the TOML.

**Differences on hosted tiers (`demo` / `commercial`)**

- The public `GET /api/llm-config` still returns the model catalog that the client needs at startup, but without `source`, `envKeyOverrides`, the load `error`, or slot `baseUrl` values. `GET /api/presets` also omits `baseUrl`. Only a request with the operator token can see these fields.
- The public `GET /api/config/info` returns `isDesktop: false` and `requiresAuth: true`, and all path fields are `null`. A request with the operator token gets the full deployment paths.
- Responses on your own `self` machine and in the desktop app are not affected.

### Server settings

"Server settings" are settings that the server runs itself. They are the entries with `scope: "server"` in the settings registry. See [`settings-store.md`](./settings-store.md).

**`GET /api/config/server-settings`**

Every tier can call it. It needs no token, and it contains no secrets. For each server setting, it returns three things: the value in effect, where the value came from, and whether writing it now will take effect.

```json
{
  "settings": {
    "diagnostics.traceRetention": {
      "value": "30",
      "source": "default",
      "settable": true
    }
  }
}
```

| Field      | Description                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `value`    | The value in effect now                                                                                         |
| `source`   | `env` (an environment variable set by the operator), `setting` (a value that was saved), or `default`           |
| `settable` | `false` when an environment variable fixes this key. In `demo` / `commercial` deployments, every key is `false` |

When `source` is `env`, `value` may be a value that the settings screen does not offer to the player. For example, `COVEL_TRACE_RETENTION_DAYS=14` gives `"14"`.

**`PUT /api/config/server-settings`**

The request body is `{ "entries": { "<key>": <value> | null } }`. It saves each value (`null` deletes the saved value), and returns the same response body as `GET`.

- It is accepted only when `DEPLOYMENT_TIER=self`.
- If the desktop shell has set a bearer token, you must send it. Otherwise it returns `401 desktop_rest_token_invalid`.
- If even one entry in a request is rejected, nothing is written.
- A saved value takes effect at the next submit or cleanup. No restart is needed.

| Status code | `code`                          | When                                                             |
| ----------- | ------------------------------- | ---------------------------------------------------------------- |
| 403         | `server_settings_operator_only` | `demo` / `commercial`, whatever token the caller sends           |
| 400         | `invalid_server_settings_body`  | The request body is not `{ entries: object }`                    |
| 400         | `unknown_server_setting`        | A key is not a server setting (see `details.key`)                |
| 400         | `invalid_server_setting_value`  | A value does not match that setting's schema (see `details.key`) |
| 409         | `server_setting_fixed`          | An environment variable fixes this key (see `details.key`)       |

**Other rules for config endpoints**

- File system errors in the config and failures to start the file manager are passed to the global error handler and written to the log. In production, the response is a generic 500.
- When the submitted TOML or proxy config is invalid, it still returns a 400 with a specific diagnostic.
- When an existing config cannot be read, the original config is kept. It is not treated as "bad input."

**`GET /api/provider-keys`**

It returns only `{ providers: { [provider]: { configured: true } } }`, with the data from the runtime's current credential table. The raw value or a masked form of any key never goes through this endpoint, even for a request with desktop auth. The browser does not import these server defaults into personal keys.

**File management API on the desktop app**

- `COVEL_HOME` is used only to choose a directory.
- The desktop app's file system management API is enabled only when `COVEL_DESKTOP_REST=1` is set explicitly. Electron provides its own sidecar token.
- A normal browser that connects to a server with this feature turned on still uses the settings in its own localStorage.

## Quick start

The steps below walk through the full flow with `curl`: start the server, create a session, start the game, have a few rounds of conversation, and finally delete the session.

### 1. Start the server

```bash
# Install dependencies
pnpm install

# Start the development server (SQLite is the default backend, port 3001)
pnpm dev:server
```

### 2. Health check

```bash
curl http://localhost:3001/api/health
```

### 3. Browse available worlds

```bash
curl http://localhost:3001/api/worlds
```

### 4. See the available plugins

```bash
curl http://localhost:3001/api/plugins
```

### 5. Create a game session

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{
    "worldId": "mistport",
    "locale": "zh-CN",
    "plugins": ["pregame", "narrator", "codex"]
  }'
```

Note the `id` in the response. Its format is `{worldId}-{uuid8}`, for example `mistport-a1b2c3d4`. You use it in every request that follows.

### 6. Start the game (activate plugins and run setup)

A turn has only one entry point: [`POST /api/actions`](#post-apiactions). There is **no** session-level `/turn` endpoint. The response is an SSE stream with only `data:` lines, so `curl` needs `-N` to turn off buffering.

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-001",
    "type": "start_session",
    "sessionId": "<sessionId>",
    "payload": {}
  }'
```

### 7. Run the first turn (the player speaks)

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-002",
    "type": "send_message",
    "sessionId": "<sessionId>",
    "payload": { "content": "我环顾四周，观察这个陌生的世界" }
  }'
```

### 8. Check the game state

```bash
# Check the state tables
curl http://localhost:3001/api/sessions/<sessionId>/state

# Check the character list
curl http://localhost:3001/api/sessions/<sessionId>/characters

# Check the message history
curl http://localhost:3001/api/sessions/<sessionId>/messages
```

### 9. Keep talking

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-003",
    "type": "send_message",
    "sessionId": "<sessionId>",
    "payload": { "content": "走向远处的城镇" }
  }'
```

### 10. Submit a player interaction (if the turn returned pendingInputs)

Sometimes a turn stops to wait for the player's answer, for example to choose one of several options. Then submit the answer as `submit_interaction`. The `turnId` and `interactionId` come from the previous SSE stream.

```bash
curl -N -X POST http://localhost:3001/api/actions \
  -H "Content-Type: application/json" \
  -d '{
    "requestId": "req-004",
    "type": "submit_interaction",
    "sessionId": "<sessionId>",
    "payload": {
      "turnId": "<turnId>",
      "submissions": [
        {
          "interactionId": "<interactionId>",
          "type": "choice",
          "values": { "selectedId": "option_1", "selectedLabel": "接受任务" }
        }
      ]
    }
  }'
```

### 11. Delete the session

```bash
curl -X DELETE http://localhost:3001/api/sessions/<sessionId>
```

> [!CAUTION]
> This deletes the session and all of its saved data (messages, state, snapshots, and so on). It cannot be undone.

## Endpoint list

This section lists every endpoint by topic. After each table come the rules that apply to that group. Request bodies, response examples, and error codes are in the [Details](#details) section below.

### Health check

| Method | Path          | Description  |
| ------ | ------------- | ------------ |
| GET    | `/api/health` | Health check |

### World management

| Method | Path                                    | Description                                                                                             |
| ------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/worlds`                           | List a summary of every world (without `lore` / `dimensions`)                                           |
| GET    | `/api/worlds/:id`                       | Get the full record of a world                                                                          |
| POST   | `/api/worlds`                           | Create a world. If the ID already exists, returns `409 world_already_exists`                            |
| PATCH  | `/api/worlds/:id`                       | Partly update a world (supports top-level `dimensions`; `metadata` is merged with existing values)      |
| DELETE | `/api/worlds/:id`                       | Delete a world and all of its sessions. The rules are below                                             |
| GET    | `/api/worlds/:id/dimensions/export`     | Export the world's dimensions (YAML / JSON)                                                             |
| POST   | `/api/worlds/:id/dimensions/import`     | Import the world's dimensions                                                                           |
| POST   | `/api/worlds/:id/sync-dimensions`       | Sync the world's dimensions to active sessions                                                          |
| POST   | `/api/worlds/:id/world-data/preflight`  | Dry-run a worldData import, read-only                                                                   |
| POST   | `/api/worlds/:id/sync-data`             | Sync the worldData rows that the importer manages. Supports dry-run and force                           |
| POST   | `/api/worlds/:id/translate`             | Use the configured model to add one language version to a world package in the user worlds folder (SSE) |
| GET    | `/api/worlds/:id/gallery`               | List the images that come with the world package (scenes, portraits)                                    |
| GET    | `/api/media/library`                    | The player's media library (`self` / desktop app only)                                                  |
| POST   | `/api/media/library/delete`             | Delete media the player selected, or all media that no session uses                                     |
| GET    | `/api/worlds/:id/gallery/:source/:file` | Read one image from the gallery list                                                                    |

A few more notes:

- `POST /api/worlds/:id/sync-dimensions` writes the dimensions into the `plugin_data` and lorebook constant entries of active sessions, and removes old keys.
- `POST /api/worlds/:id/world-data/preflight` builds the import plan for worldData but does not write it. It returns the diagnostics, the number of planned writes, and a summary of the targets.
- `POST /api/worlds/:id/sync-data` uses the provenance ledger to decide which rows the importer manages.
- `GET /api/worlds/:id/gallery` lets the world list and world details show images even when no session exists yet.
- `GET /api/media/library` lists stored media by page, along with the sessions that use each item and the space that can be freed.

#### Deleting a world

Limits on `DELETE /api/worlds/:id`:

- A built-in world (`source: "file"`) returns `403`.
- A file world is located by its storage binding and manifest ID. If it cannot be found, or the match is ambiguous, it returns `409 world_package_unresolved`.
- Hosted tiers (`demo` / `commercial`) and production MemoryStore need the operator token.

The delete runs in several steps:

1. The server holds the world lock briefly, records a "deleting" state, and then releases the world lock.
2. It runs the full session delete flow for each session one by one. That means waiting for writes in progress, running lifecycle hooks, and clearing media references and in-process state.
3. It deletes the world record and the matching package files.

The package is moved out of discovery before its record and files are deleted. See [world installation](./world-installation.md#updates-and-data-protection) for startup recovery after an interruption.

> [!NOTE]
> The low-level `DataStore.deleteWorld` deletes only the world record. Any call that also needs to clean up sessions must go through this API.

While a world is "deleting":

- It can still be read.
- A world PATCH, dimension import, session creation, fork, or browser checkpoint write returns `409 world_deleting`. A checkpoint checks both the original world and the target world.
- Startup loading and file watching do not overwrite the deletion state. They also do not rebuild a deleted file world from old data that was read before the lock was taken.
- `metadata.worldDeletion` is managed by the server. A client cannot set or clear it through a world write or a checkpoint.

Lock order:

- Server-side session creation, fork, and checkpoint writes commit in the order "session lock, then world lock."
- A world DELETE never holds the world lock while it waits for a session lock, a background run, or a plugin hook.
- Browser private mode's Web Locks are a separate client protocol with their own lock order. See [Browser-private workspace](#browser-private-workspace).

Cascade delete is not one database transaction that covers all sessions:

- If some cleanup fails, the sessions already deleted are not restored. The world keeps a marker that can be retried.
- A second DELETE continues the cleanup. A normal retry after a failure does not repeat a SessionEnd that already finished.
- A lifecycle hook that is running, such as SessionStart, can make the delete return `409 session_lifecycle_busy`.
- A delete lease left behind when the process was interrupted can be taken over by a later DELETE after 10 minutes.

### Session management

| Method | Path                | Description                                                |
| ------ | ------------------- | ---------------------------------------------------------- |
| GET    | `/api/sessions`     | List all sessions (optional `?worldId=` filter)            |
| POST   | `/api/sessions`     | Create a new session                                       |
| GET    | `/api/sessions/:id` | Get session information                                    |
| PATCH  | `/api/sessions/:id` | Update session fields (`status` / `runtimeModelOverrides`) |
| DELETE | `/api/sessions/:id` | Delete a session                                           |

#### Session identity `incarnation`

The responses for the session list, create, detail, and PATCH all include `incarnation`. It is a marker for the identity of one saved session:

- It is stable and opaque. Changing ordinary fields does not change it.
- If a session is deleted and then rebuilt with the same ID, it gets a new marker, even when the creation time happens to be the same.
- A client only checks whether two values are equal. It does not derive any business meaning from the value.
- It does not grant any permission, and it does not replace the owner token.
- The server derives it from an internal identity. A client cannot set it. The internal nonce and the credential hash are not exposed.
- A server session must already have a saved incarnation nonce. Development data that lacks this field must be rebuilt.

#### Display cache of the web client (remote mode)

This section describes the behavior of the web client itself. A client that calls the API directly can skip it.

In remote mode, the form submission markers and the history of the execution timeline are kept in a separate browser cache (IndexedDB). They do not exist on the server.

How the cache confirms ownership:

- Every cache call carries the session identity the interface had at that moment (`id`, `worldId`, `incarnation`).
- When reading, when first claiming ownership, and when changing ownership, it checks with the server once (one more session GET). A display update whose ownership has been verified is stored directly in the browser. Each chunk of streaming output does not make a request to the server.
- Every operation checks two things inside an IndexedDB transaction: the deletion timing of the session and the world, and whether the cache is already bound to another session with the same ID.
- A response with no valid identity breaks the contract, and the cache operation fails.
- A network error or an auth error is not treated as "session does not exist." Old cache data does not stand in for the server's data.

What the cache stores:

- Form deltas are merged inside a transaction. The timeline stores display snapshots.
- In both remote and local mode, the timeline cache for each session keeps at most the latest 1000 execution records. Older records are removed in the order they were first written.
- Local and remote mode each use their own cache table. Remote mode reads only the current format (cache database v2, which records the session identity and the world it belongs to). Display history builds up again from the current session. Game state on the server is not affected by the cache.

How deletion cleans up:

- A remote delete invalidates the related cache operations both before and after it sends the server request. Afterwards it checks the cached sessions and removes records that have disappeared or been replaced.
- When only part of a world is deleted, it also cleans up the part that was confirmed deleted. It keeps failed responses and cache entries that are still valid.
- A cache error does not undo the server's delete. A later delete or cache read can retry the cleanup.
- This coordination uses IndexedDB only. It does not need Web Locks.
- When a session is deleted on another device, this browser cleans it up the next time it checks. An offline browser is not guaranteed to clear it right away.

For front-end developers: the four form and timeline cache methods of `DataService` require the caller to pass the session object that was current when the operation started (`id`, `worldId`, `incarnation`). They must not infer ownership again after an async wait. Front end and back end are updated together under the current contract. Mixed versions are not supported.

### Browser-private workspace

These two endpoints are the internal sync protocol of the web `LocalDataService`. They are not a general remote storage API.

- They are available only in the browser-private profile, which uses `STORE_BACKEND=memory`.
- Authentication is the same as for other session endpoints: it uses the owner token.

| Method | Path                                   | Description                                                                            |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------- |
| PUT    | `/api/sessions/:id/browser-checkpoint` | Body `{ checkpoint }`. Replaces the temporary MemoryStore workspace in one transaction |
| POST   | `/api/sessions/:id/browser-commit`     | Body `{ actionId, baseRevision }`. Exports the next full checkpoint                    |

- `browser-checkpoint` rejects an outdated revision. It also rejects a fork where the revision is the same but the head is different.
- `browser-commit` is idempotent for a repeated `actionId`, and returns the same commit.
- The shape of `SessionCommit` is `{ baseRevision, revision, actionId, checkpoint }`.

#### Validation and errors

| Status code | `code`                             | When                                                                                                                     |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 400         | `invalid_checkpoint`               | The checkpoint structure is not valid, including duplicate message IDs in `checkpoint.messages`                          |
| 400         | `invalid_checkpoint_scope`         | The checkpoint's `sessionId` does not match `:id` in the path, or `profile` is not `browser-private`                     |
| 400         | `session_record_scope_conflict`    | The global record ID of a snapshot, a pending record, or a world import ledger already belongs to another session        |
| 401         | `operator_token_required`          | An ordinary owner refers, through a checkpoint, to a world the server does not have yet (see "Shared deployments" below) |
| 401         | —                                  | The owner of the session changed while the request was queued                                                            |
| 409         | `browser_private_profile_required` | The server's storage is not MemoryStore                                                                                  |
| 409         | `unsupported_browser_mutation`     | When a durable detached job exists, the upload deletes or rewrites the execution domain, or changes the session identity |
| 409         | `world_deleting`                   | The original world or the target world is being deleted                                                                  |
| 409         | —                                  | No checkpoint has been uploaded yet, a revision conflict, the session instance changed, or the session is being deleted  |
| 413         | —                                  | The `browser-checkpoint` request body is over 64 MiB                                                                     |

Validation rules:

- The `schemaVersion` of the current `BrowserCheckpoint` is `2`. Other versions are rejected outright.
- At the boundary, it checks the required session clock, the canonical `origin` / `commitStatus`, and the snapshot schema.
- All external records have their structure checked with Zod.
- Session-domain records at the top level and inside snapshots must belong to the checkpoint's `sessionId`, and `world.id` must equal `session.worldId`. A violation returns `400`.
- `session_record_scope_conflict` rolls back the whole checkpoint write.
- A duplicate message ID check names the duplicate's `messages[index].id`. It rejects the request before the replacement transaction, before deleting the original session, and before writing the world. This is the identity rule of the messages table. It does not require different record domains or history references in snapshots to use different IDs.
- A checkpoint cannot carry provider keys, owner tokens, or other credentials.

Both endpoints, after they get the session lock, check the owner, the session instance, and the deletion state again. Only then do they read the revision or the idempotency cache. A new session with the same ID does not inherit the revision, head, or commit of the old instance.

#### Request body limit

- The full JSON request body of `PUT /api/sessions/:id/browser-checkpoint` is limited to **64 MiB**. It includes all messages, traces, and snapshots. Over the limit returns `413`.
- This allowance applies only to `PUT` on this path. Normal APIs such as `browser-commit` are still **1 MiB**.
- The protocol does not support chunked upload, so a full checkpoint must fit within this allowance.
- When a request body reaches 80% of the allowance, the web client shows the player a notice once (once per session, per page load).

#### Idempotent replay cache

- Each session caches up to the latest 16 full commits for idempotent replay.
- When a session is deleted successfully, the revision, head, and all replay payloads held by this API instance are released together. The retry cache of other sessions is not affected.
- If the delete fails and the session still exists, the cache is kept. The cache is cleared only when the data was actually deleted.

#### Uploading a checkpoint when background jobs exist

If the server already has a verified head, and a durable detached job exists, the checkpoint upload keeps the server's job, lease, and execution result. It accepts only these changes from the last head:

- New user messages.
- The session's `status` and model overrides.
- Authorized world changes.

In other cases:

- A delete, a rewrite of the execution domain, or a change of session identity returns `409 unsupported_browser_mutation`.
- A successful response carries `reconcileRequired: true`. An idempotent retry of the same upload carries it too.
- The client must first persist a `hydrate:<revision>` pending marker. Then it downloads and applies the matching browser commit. Only after that can it continue execution.
- A first sync with no existing head, and recovery after a server restart, are still rebuilt from a full browser checkpoint.

#### Shared deployments

For shared deployments that have session owner auth turned on, and for a `self` deployment that runs production with MemoryStore:

- An ordinary checkpoint sync keeps the global world record the server already has, and ignores the uploaded world content. Later commits return the server's world version.
- Creating or changing a global world through a checkpoint needs the operator token as well.
- When an ordinary owner refers to a world the server does not have yet, it returns `401 operator_token_required`. This also applies when the checkpoint leaves out the `world` content.

On development and desktop single-user modes, worlds still sync along with the checkpoint as usual.

When the browser prepares or restores an existing world, it syncs the world automatically:

- On an exact `401 operator_token_required`, it keeps the shared world on the server and continues syncing the session.
- Other auth, network, and server errors are returned to the caller as usual.
- Creating a local world that the server does not have yet still needs admin credentials.
- An explicit world editing API does not treat "write rejected" as success.

#### Coordination in the web client (private mode)

The following describes the behavior of the web client itself. It is written for people who change the front end.

**The full flow of one action.** In web private mode, a cross-tab Web Lock is taken by vault database and session ID. The following steps all run while that lock is held:

1. Recover the pending work left over from last time.
2. Persist this input.
3. Upload the checkpoint.
4. Record this pending work.
5. Run.
6. Download the commit and clear the pending work.

- Ordinary local checkpoint changes and session deletion use the same lock.
- An action that has become invalid while queued does not persist its new input.
- Other sessions can still run independently.
- Closing the page releases the lock, and another page can pick up and recover. An operation still held by an active page is not exported early as an old result.
- The session lock and revision check of a single server request cannot replace this whole client-side coordination.

**`actionId` conflicts.** The client's `applySessionCommit` rejects a commit where the same `actionId` carries different content. It throws `ActionIdConflictError`. The caller identifies a conflict by the error class and its `sessionId` and `actionId`. This local error has no `code` field. The error codes in HTTP responses are defined by each endpoint.

**World lock and session lock.** The order is fixed: world first, then session.

- Creating, changing, deleting, and running full workspace operations on a session hold the world's shared lock.
- Changing world fields, saving a whole generated result, and deleting a world hold the world's exclusive lock.
- Different sessions can still run in parallel. A world change waits for sessions that are running to finish, so an old world copy in a checkpoint cannot overwrite new data.
- When a world is deleted, it first waits for all admitted session operations to finish, and only then lists and cleans up the sessions. A new session created after the deletion checks again whether the world exists, and fails if it does not.
- A patch to world fields merges into the latest record inside the lock. `saveGeneratedWorld` is an explicit full replacement.

**Sample world.** The browser's sample world is inserted only when a new vault is first initialized and the world list is empty.

- The sample and the initialization marker are committed in the same transaction. Initialization happens only once across tabs. A failure can be retried, and no part of the sample is left behind.
- After all worlds are deleted and the page is refreshed, the list stays empty.
- The Dexie schema v5 upgrade keeps the existing list (including an empty list), and does not add the sample again.
- Only an explicit clearing of the whole vault resets the initialization marker.

**Display history, forms, and timeline cache.** These live in a separate cache database. They do not replace the checkpoint, and they do not replace game state.

- Display history for state changes: reads query IndexedDB directly. Each single append is merged in a read-write transaction, and counts as complete only after the transaction commits.
- Appends and saves follow the world and session locks. After the queue ends, the code checks whether the session still exists. A late append or save fails, and does not rebuild the cache of a deleted session.
- Form and timeline saves copy their input before they are queued. Forms are merged inside a transaction. A timeline replaces the display snapshot.
- Deleting a session (including cleaning up its sessions when a world is deleted) waits until the display history, form, and timeline caches are all cleaned up.
- A cache failure does not undo a committed game state or a session delete. When cleanup fails, a warning is printed in development. A second delete can retry the cleanup.
- Remote mode does not get this local vault lifecycle coordination.

**Runtime environment.**

- Browser-private execution needs HTTPS or localhost with Web Locks supported. If this is missing, it reports a workspace error before any action is sent. It does not fall back to queuing only in the current tab.
- The lock coordinates only pages that share the same-origin vault. It does not cross separate browsers, and it does not cross origins. Remote storage mode is still coordinated by the server.
- The workspace callbacks of `LocalDataService` provide input and sync operations that already hold the lock. The caller must wait for these operations to finish. Do not call a public method inside a callback that would take the local world lock or session lock.

### Session snapshots

| Method | Path                      | Description                                                                 |
| ------ | ------------------------- | --------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/view`  | Get the aggregate session view, used for client restore and reconnect       |
| GET    | `/api/sessions/:id/turns` | List the saved turn execution records (`turn_results`). Returns `{ items }` |

`GET /api/sessions/:id/turns`:

- Each item carries `commitStatus` and `origin`.
- The upper limit of `?limit=n` is 500.
- For a runtime that declares `io.concealed`, the `output` and the tool arguments and results in the response are emptied.
- This is a thin route. It is mainly for verifying tools with a real model (see [Verify with a real model](../ship/real-model.md)).

A few things to know about `GET /api/sessions/:id/view`:

- **It contains only the recent window.** By default `messages` and `executionSteps` hold the latest 80 messages and 600 trace events, not the full history.
- **Paging backward.** The view carries an opaque `messagesCursor`. When the front end scrolls up, it passes this value unchanged as `?cursor=` to `GET /api/sessions/:id/messages/page`.
- **Older turns outside the window** do not render an execution timeline.
- **Session clock.** The session object embedded in the view carries the same required clock fields as the session API: `phase`, `completedPlayerTurns`, and `setupRuntimes`. Restore and reconnect judge progress only from these fields.

The view's `submittedInteractions` lists the interactions the player has already answered. Its shape is `{ turnId, interactionId, values }[]`. `values` are the values the server saved.

- It returns only the answers for turns whose messages are inside the `messages` window (matched by the message's `turnId`, or by the form block's own `meta.turnId`). Its purpose is to mark the form blocks in the window. Older forms load with the history pages, and are treated as answered by their position.
- The answer and its follow-up turn are saved and started in the same `submit_interaction` request. So an interaction listed here always has a turn that follows it.
- The client marks the form in the matching message as submitted, fills it in, and does not send it again.
- After a refresh, on another device, or when opened in a second tab, the view matches the browser that submitted it. The browser's own cache is valid only between submitting and the next restore. The server's record is authoritative.
- If the submit response is lost, the client learns from here that the answer was saved. It then watches that turn through the `execution` status.

When restoring an existing session, if the recent window does not overlap the messages already loaded:

- The client uses the same `/messages/page` endpoint to fetch older messages up to the old anchor, and then merges the continuous windows.
- A middle page is not treated as the oldest page in the whole history. Old history and its paging cursor are not overwritten.
- If the backfill fails, the old window is kept and a notice is shown. A retry only does a read-only restore.
- This backfill needs no new API, and it does not resend any turn.

### Refresh and recovery of an unfinished turn

`GET /api/sessions/:id/execution` returns `SessionExecutionStatus`, which says whether a turn is running in this session right now. It uses the same ownership check as the other session endpoints. The optional `execution` field of `GET /api/sessions/:id/view` gives the same status.

| Field         | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `state`       | `idle`, `running`, `completed`, `failed`, or `interrupted`             |
| `turnId`      | Optional                                                               |
| `requestId`   | Optional                                                               |
| `startedAt`   | Optional                                                               |
| `origin`      | Optional                                                               |
| `abortReason` | Optional                                                               |
| `retry`       | Optional, `{ type, payload }`. Used when the player explicitly retries |

This endpoint does not wait for the lock of a long turn. On PostgreSQL it checks with a non-blocking advisory lock. If another process still holds the lock, or a connection cannot be obtained for the moment, it conservatively returns `running`. In that case there may be no turn identifier.

#### Session replaced during the query

`/execution` binds the session incarnation that passed the owner check to the read on the response side. If the session disappears during the query, or a session with the same ID is deleted and rebuilt, it returns:

```json
{
  "error": "Session was replaced while the request was reading",
  "code": "session_incarnation_changed"
}
```

The status code is `409`. The response does not include retry input for the new session. This recheck does not wait for a long turn to end. If the session did not exist when the request started, it still returns `404`. If the owner check fails, it still returns `401`.

#### Status in each situation

- **The player stopped the turn before it was committed.** `state` is `"failed"`, which can be retried, and it carries `abortReason: "aborted-by-player"`. The interface should show it as stopped ("Stopped; turn not committed"), not as a generic error. The stop reason is read from the saved `turn.completed`. It is not lost on refresh, and it is not retried automatically.
- **The web page is refreshed, or the SSE connection drops.** The original turn is not cancelled. The client only queries the status. It restores the committed messages, the clock, and the task steps. It does not call the model again automatically.
- **The server process stops.** In-memory execution in the foreground is lost. When there is no active lock, no committed record, and no end record, the state is `interrupted`.
- **A turn that was committed, but did not get to record its end trace,** is still `completed`.
- **Old steps in the browser** are used only to fill in information missing from the server snapshot. They cannot change a final state back to `running`. The `payload.status` of `runtime.completed` decides whether a step succeeded, failed, was skipped, or is pending.

#### Retry

- `retryFromTurnId` points to the top-level saved record of a logical turn. A recursive run may save child records with the same turnId. The server does not pick a child record as the retry source, and it does not treat child records of the same turn as further story progress. Actions and runtime RPC use the same filter rules.
- When the player explicitly retries, it uses the description in `retry` and a new `requestId`. It also adds `recoverFromTurnId` to the payload.
- The server checks the source turn again inside the session lock. A repeated click, or a source turn that has already ended, does not run again.
- A retry of the opening continuation keeps `origin: continuation`, and does not add to the player's turn count.
- The `turn.started` of the new turn records only the action input needed for recovery. It does not record request headers or credentials.
- For old logs, a retry with no input is offered only when the request's traceId proves that it was the opening continuation. Otherwise the player is asked to enter the input again.
- A batch of helper tasks is recovered with `retry_failed_runtimes`. After an interruption, the same set of targets must be recovered according to the description in `retry`. A successful task that was not committed does not count as recovered, and cannot be used as context.

### Turn execution

The only entry point for turn execution is [`POST /api/actions`](#post-apiactions) (the SSE bridge). There is no session-level turn endpoint.

Some runtimes do not need the turn to wait for them to finish. A safe leaf runtime that declares `schedule.completion.mode: detached` enters the durable queue in the same transaction as the original turn. It becomes a background job (a runtime job). The endpoints below manage these jobs:

| Method | Path                                           | Description                                                                                     |
| ------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/runtime-jobs`               | List the background runtime jobs of this session. Does not return the internal frozen `payload` |
| POST   | `/api/sessions/:id/runtime-jobs/:jobId/cancel` | Cancel a job that is still `queued` / `claimed` / `running`                                     |
| POST   | `/api/sessions/:id/runtime-jobs/:jobId/retry`  | Explicitly create a new queued job for a failed final state. Returns `202` and a new `jobId`    |

### Mid-turn control (W4)

| Method | Path                      | Description                                                   |
| ------ | ------------------------- | ------------------------------------------------------------- |
| POST   | `/api/sessions/:id/steer` | Interject into a turn in progress. Body `{ message: string }` |
| POST   | `/api/sessions/:id/abort` | Stop a turn in progress. Idempotent                           |

Both endpoints return `409` when no turn is in progress.

`steer` (interject):

- The message is merged into the story runtime's next LLM call, and saved to the message history.
- It applies only to runtimes with `outputKind: story`. A plugin runtime runs a structured task and does not accept interjections.
- When an interjection arrives while the final response is streaming, the story runtime adds one more LLM call before it wraps up, to take it in. This call is limited by maxSteps.
- If saving the message fails, that item is withdrawn from the queue and the request returns `500`.

`abort` (stop):

- It cuts the LLM stream in progress at once. It keeps no partial content that was already generated, saves no half-finished proposal, and stops scheduling the runtimes that come after.
- The `execution.completed` payload of that action's SSE carries `abortReason: "aborted-by-player"`.
- If the stop signal arrives before the commit, this run does not commit its messages, domain state, or turn count. A turn that was already committed is not rolled back.
- Before a turn starts, and before it commits, if it is waiting for the previous turn's memory update, it also responds to the stop. It cancels the current wait and releases the session execution lock. The memory update for a previous committed turn finishes on its own.

Limits that apply to both:

- The control registry for a turn lives inside the process. In a multi-pod (PG) deployment, steer and abort can reach only the turn on the same pod. Checking execution status across processes does not change this.
- Registration happens after the session lock is obtained. It covers preparation, model execution, commit, and cleanup, and is released only when the action completes. So a refresh does not wrongly report idle while the commit is still unfinished. A queued request also does not overwrite the control registration of the current turn.
- A stop signal cannot undo a transaction that has already finished.

### Setup runtime control (retry / skip)

When a session is stuck in the setup phase, sending `start_session` again means "retry setup":

- It does not record a player message. It runs only the setup runtimes that are not finished yet. A `pending` runtime runs again. A `done` runtime is left alone.
- Saved form submissions are still read as usual.
- If the player submits a form, closes the page before the next action is sent, and comes back, this is also how they continue.

The web app shows a notice and a button when these three conditions are all true: the session is in setup, no form is waiting on the screen, and no execution is running. When a runtime has recorded a `lastError`, the notice shows a failure and displays the error.

When a setup runtime keeps failing and uses up its retry budget (`maxTriggerCount`), it moves to `blocked`:

- The session stays in the setup phase. Other runtimes of that plugin are skipped, with the reason `skipped: setup-incomplete`.
- A `blocked` runtime is not run again by `start_session`. It must first be unblocked with the endpoints below.
- The web "Retry" button first calls `retry` for each `blocked` runtime, and then sends `start_session`.

These two endpoints use the same owner token authentication as the other session endpoints.

| Method | Path                                       | Description                                                          |
| ------ | ------------------------------------------ | -------------------------------------------------------------------- |
| POST   | `/api/sessions/:id/setup/:runtimeId/retry` | Reset a `blocked` setup runtime to `pending`                         |
| POST   | `/api/sessions/:id/setup/:runtimeId/waive` | Skip a `blocked` setup runtime. The body must be `{ confirm: true }` |

Both endpoints return `{ ok, runtimeId, state }`.

- `retry` writes the runtime back as a new `pending`: `generation + 1`, `attempts = 0`. It runs again the next time it is executed.
- `waive` marks the runtime as `done{resolution:"waived"}`, and adds a downgraded `warning`. This lets the session gate of the plugin it belongs to count as satisfied.
- `:runtimeId` is the full runtime ID (`<pluginId>/<runtimeName>`). It must be URL-encoded.
- Idempotent: `retry` on a target that is already `pending`, and `waive` on a target that is already `waived`, both return `200` with no side effects.
- The two endpoints update only `setupRuntimes`. Switching `phase` is still handled by the finalize transaction of the next turn.

| Status code | `code`             | When                                                                                                                                            |
| ----------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 400         | `confirm_required` | The body of `waive` is missing `{ confirm: true }`                                                                                              |
| 404         | —                  | The session does not exist                                                                                                                      |
| 409         | —                  | The target is not `blocked` (for example `done{completed}` or `pending`). `error` explains that only blocked runtimes can be retried or skipped |

### Player interaction

| Method | Path                                  | Description                                                              |
| ------ | ------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/api/sessions/:id/plugin-rpc`        | The single plugin RPC channel (action / runtime / command / event level) |
| GET    | `/api/sessions/:id/approvals`         | List the RPC requests of this session that are waiting for approval      |
| DELETE | `/api/sessions/:id/approvals`         | Revoke the cached grants of this session. Returns `{ ok, cleared }`      |
| POST   | `/api/approvals/:approvalId/decision` | Submit the player's approval decision (allow / deny + once / session)    |

`DELETE /api/sessions/:id/approvals` can take `?pluginId=` to revoke the grant of just one plugin. After a revoke, the next call prompts for approval again.

### Session plugin management

| Method | Path                                  | Description                                                       |
| ------ | ------------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/sessions/:id/plugins`           | List the session's plugins. Each item carries `active` / `locked` |
| PUT    | `/api/sessions/:id/plugins/:pluginId` | Enable a plugin                                                   |
| DELETE | `/api/sessions/:id/plugins/:pluginId` | Disable a plugin (a required core plugin returns `403`)           |

`GET` only reads the saved session record. It waits neither for a running turn nor for background jobs, so a page refreshed during a turn still gets the plugin panel and the command list at once.

### Global plugins

| Method | Path                          | Description                                                                                                                                          |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/framework/capabilities` | Framework-level capability index: manifest enumeration, tools, proposals, world-data URIs                                                            |
| GET    | `/api/framework/authoring`    | The world authoring surface: world package files, built-in data targets, authoring notes and examples for each data contract, and the plugin catalog |
| GET    | `/api/plugins`                | List the plugins in the registry, with their registration and error status                                                                           |
| GET    | `/api/plugins/:id`            | Get plugin details and the full manifest development contract                                                                                        |
| DELETE | `/api/plugins/:id`            | Uninstall a third-party plugin (deletes `~/.covel/plugins/<id>`)                                                                                     |
| GET    | `/api/plugin-flows`           | Preview data for the pre-game flow (plugin list plus staged steps), shown on the session-prep screen                                                 |

`DELETE /api/plugins/:id`:

- Authentication: the desktop app requires a bearer token. A production deployment with no token requires `COVEL_INSTALL_API_ENABLED=1`.
- On success it returns `{ ok, id, restartRequired: true }`.
- The directory is renamed out of discovery before its files are removed. If the rename fails, the response is 500 and the original package remains complete. Cleanup failure still returns success and logs a warning; the next startup retries cleanup.

| Status code | When                        |
| ----------- | --------------------------- |
| `400`       | The ID format is invalid    |
| `401`/`403` | Authentication failed       |
| `404`       | The plugin is not installed |
| `409`       | The ID is a built-in plugin |

### Plugin and world install (Install)

This group of endpoints installs plugins and worlds. There are two sources:

- Uploading a `.zip` package.
- A GitHub link. Parsing and download follow the existing network proxy settings.

For world packages, see [World catalog and install](./world-installation.md). For plugins, see [Plugin catalog and install](./plugin-installation.md).

Authentication:

- The base authentication is the same as for `DELETE /api/plugins/:id`: the desktop app requires a bearer token. A production deployment with no token requires `COVEL_INSTALL_API_ENABLED=1`.
- On the `demo` / `commercial` tiers, every install management interface must hold the operator token. Turning on the install API does not bypass this check.
- World installs must also meet the authentication for global world writes: production MemoryStore (including `self`) and hosted tiers must hold the operator token. Turning on the install API does not bypass this either.

| Method | Path                                                | Request                        | Description                                                                                            |
| ------ | --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| POST   | `/api/install/plugin`                               | multipart field `file`         | Unzip a plugin `.zip` into the user plugins folder                                                     |
| POST   | `/api/install/world`                                | multipart field `file`         | Unzip a world `.zip` into the user worlds folder                                                       |
| POST   | `/api/install/plugin/github/preview`                | `{ url }`                      | Parse a public GitHub repository or subfolder and return a preview. Does not install or run the plugin |
| POST   | `/api/install/plugin/github`                        | `{ token, acceptRisk: true }`  | Validate the confirmed preview and install                                                             |
| POST   | `/api/install/world/github/preview`                 | `{ url }`                      | Same as above, for a world package                                                                     |
| POST   | `/api/install/world/github`                         | `{ token, acceptRisk: true }`  | Validate the confirmed preview and install the world                                                   |
| POST   | `/api/install/{plugin,world}/github/update/preview` | `{ id, url? }`                 | Check whether a package installed from GitHub has an update                                            |
| POST   | `/api/install/{plugin,world}/github/update`         | `{ token, acceptRisk: true }`  | Apply a previewed update                                                                               |
| DELETE | `/api/install/{plugin,world}/github/update/:id`     | —                              | Cancel an update that has not been applied yet. Returns `{ ok: true }`                                 |
| POST   | `/api/install/github/preview`                       | `{ url }`                      | Preview the plugin, world, or collection members under one link                                        |
| POST   | `/api/install/github/batch`                         | `{ tokens, acceptRisk: true }` | Install the previewed packages as one unit. On failure, roll back this run's writes                    |
| POST   | `/api/install/collection`                           | multipart field `file`         | Import a packaged collection ZIP                                                                       |
| GET    | `/api/install/plugins`                              | —                              | List the packages in the user plugins folder, with their available source records                      |

What each endpoint accepts and returns:

- `POST /api/install/plugin`: accepts a `.zip` with `PLUGIN.md` and `package.json` at the root, or a `.zip` with a multi-runtime layout. Returns `201 { ok, kind: "plugin", id, restartRequired: true, hasServerCode }`.
- `POST /api/install/world`: accepts a `.zip` with `world.yaml` and `WORLD.md` at the root. Returns `201 { ok, kind: "world", id, restartRequired: false }`.
- `POST /api/install/plugin/github/preview`: returns the fixed commit, the summary, and the signed preview.
- `.../github/update/preview`: returns `{ status: "current" }`, `{ status: "pinned" }`, or `{ status: "available", ... }` plus a preview. The full contract of the update endpoints is in [Plugin install](./plugin-installation.md#http-contract) and [World install](./world-installation.md).
- `POST /api/install/plugin/github`: returns `201 { ok, kind: "plugin", id, restartRequired: true }`.
- `POST /api/install/github/preview`: returns `{ collection, items, problems }`. See [Plugin install](./plugin-installation.md#http-contract).
- `POST /api/install/github/batch`: returns `201 { ok, installed, restartRequired }`.
- `POST /api/install/collection`: the response is the same as for batch.

Rollback results for failed batch installations are documented in [Plugin installation](./plugin-installation.md#multi-package-preview-and-batch-install): `details.rolledBack` and `details.retained` list removed and retained packages.

- `GET /api/install/plugins`: the list includes plugins that have not yet been loaded after a restart.

`/api/install/world` checks the worldData diagnostics before it writes the world record:

- If there is an error, it returns `400`, deletes the directory it just created, and creates no record. After the fix, you can retry with the same ID.
- A warning does not block the install.
- Validation reuses the existing descriptor, source, and schema validators. It does not use local overrides, and it does not run community plugin code.

> [!IMPORTANT]
> **Canonical plugin identity**: the only identity of a plugin is the `id` at the root of its manifest. That is the `pluginId` used at runtime.
>
> - The package name in `package.json` takes part in the consistency check only after the exact `plugin-` prefix is removed (`@covel/plugin-foo` matches `id: foo`). A mismatch returns `400`.
> - The check for reserved built-in IDs, the install directory, and the returned `id` all use this canonical ID. `@covel/plugin-narrator` with `id: narrator` hits a reserved ID and returns `409`.
> - Plugin discovery at startup also requires the directory name to equal the root `id` of the manifest. A plugin that does not match is registered with `hostState: "error"`, and no runtime, tool, hook, or wire is loaded.

### State query

| Method | Path                              | Description                                        |
| ------ | --------------------------------- | -------------------------------------------------- |
| GET    | `/api/sessions/:id/state`         | Get all state tables                               |
| GET    | `/api/sessions/:id/state-patches` | Get the list of state change patches (`{ items }`) |

To restore a whole session, use `GET /api/sessions/:id/view`. Creating, listing, and reading materialized saves all use the `/api/sessions/:id/snapshots` resource. See [Snapshot / Fork](#snapshot--fork).

### Message history

| Method | Path                              | Description                                                                               |
| ------ | --------------------------------- | ----------------------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/messages`      | Get the full message list of the session (`{ items }`. For long sessions, prefer `/page`) |
| GET    | `/api/sessions/:id/messages/page` | Messages paged by keyset cursor (the latest window, then load older ones going up)        |
| POST   | `/api/sessions/:id/messages/sync` | Append messages idempotently by stable ID (for external clients)                          |

### Unified translation layer (Runtime Outputs / Interaction Records)

For each execution, the server keeps two canonical kinds of records, so that other runtimes and observability tools can read them:

- For each runtime execution, one `RuntimeOutput` is written.
- For each external input (a player message, a plugin UI action, an RPC call), one `InteractionRecord` is written.

They exist alongside `trace_events`. These two kinds of records are for programs to read. The trace is for people to see the details when debugging.

The built-in web interface does not call the query endpoints below. (The debug page uses `/api/traces/*` and `/api/sessions/:id/view`.) They are meant for observability tools and API clients.

| Method | Path                                                      | Description                                     |
| ------ | --------------------------------------------------------- | ----------------------------------------------- |
| GET    | `/api/sessions/:id/runtime-outputs`                       | List the runtime output records of this session |
| GET    | `/api/sessions/:id/runtime-outputs/:outputId`             | Get one runtime output record                   |
| GET    | `/api/sessions/:id/runtime-outputs/:outputId/full-prompt` | Rebuild the message history for that call       |
| GET    | `/api/sessions/:id/interaction-records`                   | List the external input records of this session |

Query parameters:

| Endpoint              | Filter parameters that can be used                  |
| --------------------- | --------------------------------------------------- |
| `runtime-outputs`     | `?runtimeId=`, `?pluginId=`, `?since=`, `?limit=`   |
| `interaction-records` | `?type=`, `?source=`, `?targetPluginId=`, `?limit=` |

- The `runtime-outputs` list is returned in descending order by `timestamp`.
- `full-prompt` rebuilds the history from `turn_messages`. It is best effort only: it does not include the system prompt or the injected sections.
- When a runtime declares `io.concealed`, the first two endpoints return records where `results` is an empty array, and the `input` / `output` of each item in `metaData.toolCallList` is `null`.

**`RuntimeOutput` structure**:

```ts
{
  id: string,
  sessionId: string,
  turnId: string,
  runtimeResultId?: string,  // the runId of this runtime in turn_results.runtimeResults
  pluginId: string,
  runtimeId: string,         // "{plugin}" or "{plugin}/{runtime}"
  timestamp: string,
  results: [{ text: string, structured?: unknown }],
  metaData: {
    turn: number,
    preGameDone?: boolean,                  // A pre-game runtime declares that its own initialization is done
    outputResponses?: string[],             // The raw text after streamed output is merged
    toolCallList?: [{ tool, input, output, status, durationMs }],
    modelSlot?: string,
    tokenUsage?: { input, output },
  }
}
```

**`InteractionRecord` structure**:

```ts
{
  id: string,
  sessionId: string,
  turnId?: string,
  timestamp: string,
  source: 'player' | 'plugin-ui' | 'external-api',
  channel: 'web' | 'cli' | 'api' | 'external',
  type: 'message' | 'click' | 'form-submit' | 'rpc-call' | 'skill-invoke',
  targetPluginId?: string,
  targetRuntimeId?: string,
  payload: unknown,
  metaData?: { selectionSnapshot?, userAgent? }
}
```

> [!NOTE]
>
> - Writing these two kinds of records is best effort. If a write fails, only a warning is logged. The turn does not fail.
> - `full-prompt` only replays `turn_messages`. After a session has been compacted, the result is also not fully exact. It is enough for rough debugging. For an exact rebuild or an audit, read `trace_events`.

### Plugin data (Plugin Data)

> [!NOTE]
> The built-in web interface reads plugin data only through the GET endpoints here (the right panel, the message-area interface, and the plugin data cache). PUT and DELETE are the write entry points for admin tools and API clients. When a plugin runtime writes its own data, the recommended route is the plugin-data tool, plugin RPC, or a proposal.

| Method | Path                                                      | Description                                                               |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/api/sessions/:id/plugin-data`                           | List, in one call, all readable data of the active plugins in the session |
| GET    | `/api/sessions/:id/plugin-data/:pluginId`                 | List all data of one plugin                                               |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/_index`          | List the keys under each namespace of a plugin, without values            |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace`      | List the data under one namespace                                         |
| GET    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | Get one item of data                                                      |
| PUT    | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | Write or update data                                                      |
| DELETE | `/api/sessions/:id/plugin-data/:pluginId/:namespace/:key` | Delete data                                                               |

The session-level list (the first row):

- Each item in `items[]` carries `pluginId`. The web client uses it to restore all plugin data in one go.
- It includes only plugins that are active in the session and registered. Data of inactive plugins can still be read through the per-plugin path.

The three kinds of list (session-level, per plugin, per namespace) follow the same rules:

- The same visibility: `_hidden.*` and rows owned by the kernel are not returned. Dimension rows return only their public shape.
- The same session access check: on hosted deployments, the owner token is required.

Namespaces that start with `_` are reserved for the kernel:

- PUT / DELETE and the general plugin-data tool cannot change `_dimensions` and `_dimension-settlements`.
- `_hidden.<namespace>` (world data with `visibility: hidden`) does not appear in lists, in `/state`, or in discovery. A single read returns 404.
- A player changes dimensions through the [manual runtime RPC](#dimension-editing-and-recovery-of-pending-settlements). Public reads use the session view. They do not scan the provider's private rules.

### Plugin memory

Story memory is managed by the `memory` plugin. The kernel has no separate memory CRUD routes, and no dedicated storage table for memory blocks.

Reading:

- Committed memory blocks: `GET /api/sessions/:id/plugin-data/memory/blocks`.
- World definitions: the `definitions/world` record of that plugin.

How memory is created and used:

- Background extraction is a detached runtime. It declares a `before-next-execution` barrier, so the next execution waits for it to finish.
- Committed memory blocks enter later prompts through `prompt.segment@1`.

How a plugin reads and writes its own data:

- Inside a plugin, use `ctx.pluginData`, which is bound to the current session and plugin, or `ctx.store` inside RPC.
- If a plugin provides a custom edit operation, it must declare it in `contributes.actions`, and it is called through the general plugin RPC route.
- A public service can only access the provider's own read-only snapshot.

### Lorebook

This group of endpoints creates, reads, updates, and deletes the lorebook entries in a session.

Entries are usually written by plugins through proposals (in the storage layer's `lorebook_entries` table). The management endpoints here are for the player interface and for programs. **They do not go through the proposal system.**

Who owns an entry:

- An entry's identity key is `(sessionId, owner, entryId)`.
- `owner` is `{kind:"world"}`, `{kind:"player"}`, or `{kind:"plugin",pluginId}`. Different owners can use the same ID.
- The list includes entries from all owners.
- Creating, updating, and deleting here always apply to the `player` owner. They cannot overwrite entries imported from the world or entries of a plugin.
- The owner of a plugin's `lorebook.upsert` is decided by the source of the proposal.

| Method | Path                                  | Description                                                    |
| ------ | ------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/sessions/:id/lorebook`          | List all entries of the session, in ascending `insertionOrder` |
| POST   | `/api/sessions/:id/lorebook`          | Create an entry                                                |
| PUT    | `/api/sessions/:id/lorebook/:entryId` | Fully replace an entry, or create one with the given id        |
| PATCH  | `/api/sessions/:id/lorebook/:entryId` | Switch an entry's `enabled`. Body `{ enabled: boolean }`       |
| DELETE | `/api/sessions/:id/lorebook/:entryId` | Delete one entry                                               |

Responses:

| Method   | Response                                                                             |
| -------- | ------------------------------------------------------------------------------------ |
| `GET`    | `{ items: LorebookEntryRecord[] }` (for the type, see `packages/store/src/types.ts`) |
| `POST`   | `201` and `LorebookEntryRecord`                                                      |
| `PUT`    | `LorebookEntryRecord`                                                                |
| `PATCH`  | `{ ok: true, entryId, enabled }`                                                     |
| `DELETE` | `{ ok: true }`                                                                       |

If the session does not exist, or the `entryId` does not exist, it returns 404. This group of endpoints has no feature switch, and is always on.

What happens when you disable an entry (`enabled: false`):

- It is excluded completely: automatic injection, archival keyword search, and vector search no longer use it. You do not have to wait for background ingestion to clean up old vectors.
- The management list still includes it. Disabling does not delete the record, and it does not change the owner of `(sessionId, owner, entryId)`.
- When it is enabled again, it can be searched again. Keyword search does not depend on an index, so it works right away. If the index has already been cleaned up, semantic search comes back only after a later ingestion rebuilds it.

The built-in interface does not use this group of endpoints for now. The "World" tab in the right panel shows WORLD.md (see [ui-panels.md](./ui-panels.md)). A plugin can use them in its own `ui.right` JSON spec.

### Suspend / Resume

| Method | Path                                                 | Description                                                              |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| POST   | `/api/sessions/:id/suspensions/:suspensionId/resume` | Start again the runtime of that suspended item, using the submitted data |
| GET    | `/api/sessions/:id/suspensions`                      | List all unresolved suspended items in the current session               |
| DELETE | `/api/sessions/:id/suspensions/:suspensionId`        | Give up a suspended item (deletes the record)                            |

### Snapshot / Fork

> [!NOTE]
> The server already supports manual snapshots, snapshot lists, and fork. The built-in web interface has no screen for these operations yet. It uses `GET /api/sessions/:id/view` for restore and reconnect.

| Method | Path                                      | Description                                                            |
| ------ | ----------------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/api/sessions/:id/snapshots`             | Create a manual snapshot (kind=`manual`)                               |
| GET    | `/api/sessions/:id/snapshots`             | List snapshot metadata by page (auto / manual / fork, without payload) |
| GET    | `/api/sessions/:id/snapshots/:snapshotId` | Get one snapshot by id (including the full payload)                    |
| POST   | `/api/sessions/:id/fork`                  | Create a new session from the given `snapshotId`                       |

`POST /api/sessions/:id/fork`:

- The new session (the child) copies the state in the snapshot, and the messages up to the cursor.
- The response returns the child's `ownerToken` once, all at once.

When an automatic snapshot is refreshed:

- Within the same session, an existing automatic snapshot is refreshed. Its snapshot ID stays the same, and its payload and capture time `createdAt` are updated.
- Single reads and metadata paging are both sorted by the updated capture time.

Fork and community plugin grants:

- A fork does not inherit the server-code grant of a community plugin. The matching plugin in the child stays inactive. The operator must enable it again in the new session and approve it.
- When the dimension provider bound in a snapshot is a community plugin, the child cannot enable it when it is created:
  - If the snapshot has dimension data or settlement receipts for that provider: fork returns `409 { "code": "dimension_provider_required" }`, and no child session is created.
  - If the snapshot has no dimension data: the child session is created normally, but without this binding.
- After a process restart, volatile grants are not restored either. `GET /api/sessions/:id/plugins` shows a community plugin that lacks its current grant as inactive (`approvalRequired: true`). It keeps the plugin selection saved in the session, so it can be authorized again later.

### Character data

> [!NOTE]
> The built-in web interface gets the character view mainly through `GET /api/sessions/:id/view`. The endpoints in this section are lightweight read and management APIs. Inside a plugin, for a runtime that tracks a batch of characters at once, the recommended tool is `sync-characters`. Other plugins can use the lower-level `create-character` / `update-character` as needed, along with the read tools `list-characters` / `get-character`.

A character `id` only has to be unique within the current session. Different sessions can safely use the same ID.

| Method | Path                           | Description                      |
| ------ | ------------------------------ | -------------------------------- |
| GET    | `/api/sessions/:id/characters` | Get the session's character list |
| POST   | `/api/sessions/:id/characters` | Create or update a character     |

### Actions (SSE bridge)

| Method | Path           | Description                                                                             |
| ------ | -------------- | --------------------------------------------------------------------------------------- |
| POST   | `/api/actions` | SSE action bridge (send a message or run a command → turn execution → SSE event stream) |

### Event system

| Method | Path                               | Description                                                 |
| ------ | ---------------------------------- | ----------------------------------------------------------- |
| GET    | `/api/events/stream?sessionId=xxx` | Live SSE event stream (supports topic filtering and replay) |
| POST   | `/api/events/emit`                 | Inject an external event                                    |

### AI generation

In the table below, "hosted deployment" means `DEPLOYMENT_TIER` is `demo` or `commercial`.

| Method | Path                     | Description                                                                                     |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------------- |
| POST   | `/api/ai/ping`           | Test connectivity to an LLM provider                                                            |
| POST   | `/api/ai/models`         | Read the model IDs that a provider endpoint lists. Hosted deployments need the operator token   |
| GET    | `/api/ai/protocols`      | Configurable protocols: built-in protocols and text protocols registered by loaded plugins      |
| POST   | `/api/ai/generate-world` | Generate a world package with AI. Hosted deployments need the operator token                    |
| POST   | `/api/ai/revise-world`   | Revise a world created in the app from one sentence. Hosted deployments need the operator token |

### Model database (Model DB)

| Method | Path                                                       | Description                                                                 |
| ------ | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| GET    | `/api/model-db`                                            | Get model database information                                              |
| GET    | `/api/model-db/search?q=xxx`                               | Search models                                                               |
| GET    | `/api/model-db/lookup?model=xxx&provider=yyy&protocol=zzz` | Look up model capabilities, the match source, and the nature of the pricing |
| POST   | `/api/model-db/refresh`                                    | Refresh the model database. Hosted deployments need the operator token      |

`GET /api/model-db/search` returns `{ items: ModelSearchResult[] }`.

`GET /api/model-db/lookup`:

- `model` is treated as an opaque ID. The server does not rewrite the model ID you actually request.
- `matchedModelId`, `matchKind`, and `candidates` only explain how the capability data was matched.
- `source` is `known`, `model-database`, or `protocol-default`.
- `pricingKind=reference` means the price is a reference price for an upstream model, matched through an aggregating provider. The actual bill may differ.
- `reasoning` returns the reasoning effort levels, the default value, and the family name, recognized from the upstream model family. The generation-parameter screen uses them.

`POST /api/model-db/refresh`:

- Fetches the latest LiteLLM data online.
- On the desktop app and self-hosted environments, the data is written to the user config directory. On later startups, this cache takes priority over the fixed snapshot bundled with the install package.
- On success, returns `{ ok: true, count, persisted }`.
- If the upstream download or parsing fails, returns `502 { error, code: "model_db_refresh_failed" }`.

### Trace debugging

| Method | Path                                | Description                                                                                    |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------- |
| GET    | `/api/traces/:sessionId`            | The session's most recent trace events, up to 5000 at a time. Use `?cursor` to read older ones |
| GET    | `/api/traces/:sessionId/turns`      | The same window, grouped by turn                                                               |
| GET    | `/api/traces/:sessionId/turns/page` | The recent event window grouped into turns, plus a cursor (load older ones going up)           |

### Media management

| Method | Path                                | Description                                                                           |
| ------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/api/media/:id?token=<signed>`     | Download media by content address (checks the HMAC token and the session reference)   |
| GET    | `/api/sessions/:id/media-token?id=` | Issue a short-lived signed token for a given mediaId, for the download endpoint above |
| POST   | `/api/media?sessionId=<id>`         | The player uploads an image. Returns `201 { id, mime, size }`                         |
| POST   | `/api/media/cleanup`                | A destructive maintenance endpoint. Disabled by default                               |

`POST /api/media?sessionId=<id>` (upload an image):

- The body is the raw bytes of the file. `Content-Type` is the file's MIME type.
- It accepts only `image/*`, up to 20 MB in size.
- The bytes must start with the file header of PNG, JPEG, GIF, WebP, AVIF, or BMP. Otherwise it returns 400.
- The stored MIME type comes from the type judged by the file header, not from the request header.
- The image is stored by content address, and the session's ownership and reference are recorded.

> [!WARNING]
> `image/svg+xml` is always rejected with 400. SVG is a content type that can run executable code. When rendered inline, it would run scripts under the app's origin.

`POST /api/media/cleanup` (clean up media):

- Disabled by default. Turn it on with `COVEL_MEDIA_CLEANUP_ENABLED`.
- The `demo` tier needs the operator token.
- The `commercial` tier returns 503.
- `dryRun:false` (the real delete) also needs the request header `X-Confirm-Cleanup: yes`.

### Configuration info

| Method | Path                           | Description                                                                                 |
| ------ | ------------------------------ | ------------------------------------------------------------------------------------------- |
| GET    | `/api/presets`                 | List the configured model presets (`{ items }`)                                             |
| GET    | `/api/plugins`                 | List plugins (`PluginSummary`)                                                              |
| GET    | `/api/worlds/:id/plugin-plan`  | Return the plugin plan `WorldPluginPlan` for a world                                        |
| GET    | `/api/ui-specs?sessionId=<id>` | List plugins' UI declarations, grouped by slot                                              |
| GET    | `/api/llm-config`              | Return slot configuration and capability information                                        |
| POST   | `/api/llm-config/reload`       | Read `llm.toml` again and apply it, with no restart needed                                  |
| GET    | `/api/provider-keys`           | Return which providers have a key configured, without the key contents                      |
| GET    | `/api/config/info`             | Return the current deployment information (`isDesktop`, `covelHome`, `dataRoot`, and so on) |
| GET    | `/api/config/server-settings`  | All tiers: return the effective value, source, and whether each server setting can be set   |
| PUT    | `/api/config/server-settings`  | `self` tier only: save server settings                                                      |
| GET    | `/api/config/keys`             | Desktop only: list the configured providers as `{ items: string[] }` (no values returned)   |
| PUT    | `/api/config/keys`             | Desktop only: write `<covelHome>/keys.env`. Body `{ provider: value }`                      |
| GET    | `/api/config/settings`         | Desktop only: read `<covelHome>/settings.json` (the unified SettingsStore)                  |
| PUT    | `/api/config/settings`         | Desktop only: write `settings.json` atomically. Body `{ entries: Record<string, unknown> }` |
| GET    | `/api/config/proxy`            | Desktop only: read the proxy mode for outbound requests and its effective status            |
| PUT    | `/api/config/proxy`            | Desktop only: write the proxy and apply it immediately                                      |
| GET    | `/api/app-update/latest`       | Desktop only: query the latest stable Release on GitHub                                     |
| PUT    | `/api/config/data-root`        | Desktop only: rewrite the `data_root` line in `config.toml`. Needs a server restart         |
| POST   | `/api/config/open-folder`      | Desktop only: open the config, data, or logs folder, or `llm.toml` / `keys.env`             |
| GET    | `/api/config/raw`              | List the config files that can be edited as text in the app                                 |
| GET    | `/api/config/raw/:name`        | Read the text and `digest` of one config file                                               |
| PUT    | `/api/config/raw/:name`        | Validate and save the text. Body `{ content, baseDigest }`                                  |

Notes on each endpoint:

- `GET /api/plugins`: the data comes from a snapshot of the registry. Plugins that failed to load are also returned, as an item with `status: "error"`. In that `error` text the server's absolute plugin-directory path is written as `<plugin>` (for example `<plugin>/PLUGIN.md: …`); the full original message goes only to the server log.
- `GET /api/worlds/:id/plugin-plan`: the server resolves the world's plugin policy, the packs, and the default selection.
  - Each `requested` and `defaultPluginIds` list contains only installed plugins.
  - A plugin the world requests but the host does not have is listed in `missing: [{ pluginId, packId? }]`.
- `GET /api/ui-specs`: with `sessionId`, it returns only the plugins active in that session. Without it, it returns all plugins. See [below](#get-apiui-specs) for details.
- `GET /api/llm-config`: if parsing `llm.toml` fails, it falls back to the default config and adds an `error` field.
- `POST /api/llm-config/reload`: applies the change in place to the running gateway, and returns `{ ok, slots, error? }`.
- `GET /api/provider-keys`:
  - Returns only `{ providers: { [provider]: { configured: true } } }`.
  - The status comes from a dynamic scan of all `*_API_KEY` variables. It contains no raw or masked key contents, and the desktop client is the same.
  - The `demo` / `commercial` tiers **need the operator token**, because the list of configured providers is operator information.
- `GET` / `PUT /api/config/server-settings`: these are settings run by the server (`scope: "server"`). The PUT body is `{ entries: { [key]: value | null } }`, validated against the registry. See [Server settings](#server-settings) above.
- `GET /api/config/proxy`: returns `{ mode, url?, effective, systemAvailable }`.
- `PUT /api/config/proxy`: the body is `{ mode: "direct" | "system" | "http" | "socks", url? }`. HTTP/S and SOCKS5 addresses can include authentication details in the URL.
- `GET /api/app-update/latest`: queried through the current proxy. Returns `{ version, name, publishedAt }`.
- `GET /api/config/raw`: the editable file is `llm.toml`. In desktop mode, `config.toml` is also included. Returns `{ items: [{ name, path, exists, applies }] }`.
- `GET /api/config/raw/:name`: if the file does not exist, `content` is a starter content.
- `PUT /api/config/raw/:name`: after `llm.toml` is saved, it reloads right away.

`PUT /api/config/proxy` runs in a fixed order, so a failure to write to disk does not leave a half-applied state:

1. Prepare and validate the new transport first.
2. Then write the config to disk atomically.
3. Finally, apply it inside the process.

If the disk write fails, the old dispatcher and the state returned by GET both stay unchanged.

> [!NOTE]
> For authors of server code: the low-level `prepareOutboundProxy()` provides `commit()` / `dispose()`. A transport that is not committed is released by the caller. `configureOutboundProxy()` is used to apply immediately.

#### GET /api/config/keys

`GET /api/config/keys` uses the same guard as writes: when `COVEL_DESKTOP_REST_TOKEN` is set, a matching Bearer token is required; otherwise the response is `401`.

#### PUT /api/config/keys

Desktop only. It writes provider keys to `<covelHome>/keys.env`.

- The body is `{ provider: string | null }`. An empty string or `null` means delete that key.
- The whole batch of input is validated first. If a value contains a newline, or is of another type, it returns `400`, and the file and the runtime both stay as they were.
- The runtime's keys are updated only after the file is written atomically and successfully. Turns, connection tests, and model lists use the new keys immediately. External keys (shell, `.env`, `.env.llm`) retain precedence; deleting or replacing a local key changes only the saved copy, without clearing or overriding the external key.

How the desktop app (Electron) behaves when it saves keys:

- It submits the complete list of keys. A provider that already exists but does not appear this time is turned into an explicit delete.
- When the last key is cleared, the values in the file and in the runtime are cleared together.
- It falls back to a local save only when the sidecar cannot be reached. An HTTP request that is rejected does not trigger a local overwrite.

#### GET /api/ui-specs

Returns plugins' UI declarations, grouped by slot. The front end calls it at startup, to build the right-panel tabs and the block renderers of the message area dynamically.

**Query parameters:**

| Parameter   | Type              | Description                                                                                                                                                                |
| ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId` | string (optional) | If given, returns only the plugins active in that session. If the session does not exist, returns `404 session_not_found`. If omitted, returns all plugins in the registry |

**Response format**:

```json
{
  "right": [
    {
      "pluginId": "codex",
      "specs": [{
        "specVersion": 1,
        "id": "codex",
        "group": "codex",
        "label": { "zh": "知识图鉴", "en": "Codex" },
        "icon": "book-open",
        "dataSource": { "namespace": "entries" },
        "view": { "component": "Stack", "children": [...] }
      }]
    }
  ],
  "message": [...],
  "left": [...],
  "diagnostics": []
}
```

Each slot is an array. Its elements are `{ pluginId, specs[] }`. Each item in `specs` is a json-render spec, loaded from the plugin's `ui/*.json` files.

**Validation and `specVersion`**:

- When aggregating, every spec is validated with Zod (its structure and `specVersion`).
- `specVersion` can be left out, and is treated as v1. A declared version higher than the server supports (currently `CURRENT_UI_SPEC_VERSION = 1`) is rejected.
- If one spec fails validation, it **does not affect the whole response**. Only that spec is removed from its slot.
- The reason for failure is written in the top-level `diagnostics[]`. Each item is `{ pluginId, runtimeId, slot, specIndex, specId?, issues[{ path, message, code }] }`. It says which plugin, which field, and what the problem is.
- With `sessionId`, `diagnostics` includes only the plugins active in that session.

**Development hot reload**: `POST /api/plugins/:id/reload` reloads one community plugin.

- Request body: `{ "sessionId"?: string }`.
- Response: `{ "ok": true, "pluginId": string, "generation": string }`.
- Available only in the development environment, and only for community plugins. It needs authentication through the install API, and the session must currently hold the server-code grant.
- If the reload fails, it returns `409 plugin_reload_failed`, and the old generation stays in effect.
- When the feature is off, it returns `403 plugin_reload_disabled`.
- Executions that have already started keep using the old generation's capabilities, handlers, and guards. Later executions use the new generation.
- For resource draining and which modules are loaded again, see [Single-plugin hot reload during development](./plugin-extensions.md#single-plugin-hot-reload-during-development).

**The read model** (where this data comes from):

- UI declarations come from the manifest snapshot published to the registry at startup. Static `ui/*` resources are loaded lazily from this snapshot and cached.
- The UI resource directory and document paths of a runtime come from the actual `PLUGIN.md` / `RUNTIME.md` paths saved in the discovery snapshot. The directory is not inferred from the slashes in the runtime ID.
- A GET request does not rediscover plugins, does not reread `PLUGIN.md`, and does not write UI definitions into `plugin_data`.
- In development mode, the registry reloads automatically when the community plugin directory changes. You can also call `POST /api/plugins/:id/reload` explicitly.
- Built-in plugins and production environments need a server restart.

## Details

The sections below go through each endpoint by feature. For each one, they describe the request, the response, and the errors. The common response shape, the error envelope, and the authentication method are described in the [Overview](#overview), so they are not repeated here.

### Health check

#### `GET /api/health`

Checks whether the server is running, and reports the storage it uses.

**Response:**

```json
{
  "status": "ok",
  "version": "1.0.0",
  "bootId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2025-01-15T10:00:00.000Z",
  "operatorTokenRequired": false,
  "storage": {
    "data": {
      "backend": "sqlite",
      "durable": true,
      "frontendMode": "remote"
    },
    "media": {
      "backend": "sqlite",
      "configuredBackend": "mirror",
      "enabled": true,
      "durable": true
    },
    "vector": {
      "backend": "embedded",
      "capable": true,
      "driver": "sqlite-vec",
      "modelCount": 0,
      "tableCount": 0
    },
    "migrations": [
      {
        "id": "browser:idb:cache-media",
        "domain": "browser",
        "backend": "idb",
        "version": 1,
        "status": "managed-by-backend",
        "description": "Browser UI state and media caches use a lightweight IndexedDB schema; durable game data lives in the separate Dexie BrowserVault."
      }
    ]
  },
  "vector": {
    "capable": true,
    "driver": "sqlite-vec",
    "modelCount": 0,
    "tableCount": 0
  }
}
```

| Field                                     | Description                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                                 | The app version number.                                                                                                                                          |
| `bootId`                                  | The server startup ID (a UUID). It changes on every restart, so you can use it to tell that the server has restarted.                                            |
| `operatorTokenRequired`                   | Whether admin requests check the operator token. It is `true` when `DEPLOYMENT_TIER` is `demo` / `commercial`.                                                   |
| `storage.data.backend`                    | The data storage backend the server is using now: `memory` / `sqlite` / `pg`. The default is `sqlite`.                                                           |
| `storage.data.frontendMode`               | The front-end data mode. `local`: data is kept in the browser's BrowserVault. `remote`: data is kept on the server through the server API.                       |
| `storage.media`                           | The configured media storage value, the actual backend, whether it is enabled, and whether it is durable.                                                        |
| `storage.migrations`                      | The registered migration domains, versions, and statuses. SQL migrations are run by the server. IndexedDB migrations run when the browser upgrades its database. |
| `vector.capable`                          | Whether the current backend can do vector search. It depends on the storage type and on whether the vector extension is available.                               |
| `vector.driver`                           | `sqlite-vec` / `pgvector` / `in-memory` / `external` / `none`                                                                                                    |
| `vector.modelCount` / `vector.tableCount` | The number of registered embedding models, and the number of matching physical tables (one table per model).                                                     |

The web settings page uses `operatorTokenRequired` to decide whether to show the "Operator Access" page. The top-level `vector` and `storage.vector` are the same data.

### World management

#### `GET /api/worlds`

Lists all loaded worlds. Each item is a **summary** (`WorldSummary` from `@covel/shared`). It carries only the fields that the world list, the cards, and the header of the session-prep screen show. It leaves out the large content.

What the summary has and does not have:

- It has no `lore` and no `dimensions`.
- `metadata` keeps only these keys: `source`, `storage`, `packageManaged`, `generated`, `cover`, `accentColor`, `supportedLocales`, `packageInfo`, `defaultViewMode`, `pluginSettings`, plus `name` / `description` inside `localizedText`.
- The setting text for each language, `localizedText.lore`, is not in the summary.
- For the other keys (`dimensions`, `embeddedCharacters`, `embeddedLorebook`, `characterSchema`, `pluginPolicy`, `worldData`, and so on), read the full record with `GET /api/worlds/:id`.
- For the result of resolving a world's plugin policy, see `GET /api/worlds/:id/plugin-plan`.

The list for the four built-in worlds is about 3.9 KB.

**Response:**

```json
{
  "items": [
    {
      "id": "mistport",
      "name": "云溟界",
      "description": "一个漂浮于云层之上的奇幻世界...",
      "locale": "zh-CN",
      "metadata": {
        "source": "file",
        "supportedLocales": ["zh-CN", "en-US"],
        "cover": "media/gallery/cover.webp",
        "accentColor": "#5b8def",
        "packageInfo": {
          "version": "0.3.0",
          "author": { "name": "Covel Contributors" },
          "license": "MIT"
        },
        "localizedText": {
          "name": { "en-US": "Mistport" },
          "description": { "en-US": "A fantasy world above the clouds..." }
        }
      },
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/worlds/:id`

Reads the **full record** of one world: `lore`, `dimensions`, and all of `metadata`. The list returns only summaries. So any place that needs the setting text or the dimensions (the session-prep screen, the world details, the world editor) reads this one.

**Parameters:**

| Parameter | Location | Description                       |
| --------- | -------- | --------------------------------- |
| `id`      | Path     | World ID (for example `mistport`) |

**Response 200:**

```json
{
  "id": "mistport",
  "name": "云溟界",
  "description": "一个漂浮于云层之上的奇幻世界...",
  "locale": "zh-CN",
  "metadata": {
    "source": "file",
    "dimensions": {},
    "pluginPolicy": {
      "presetId": "traditional-story",
      "requested": ["pregame", "world-init", "char-creator"],
      "recommended": ["narrator", "guide"],
      "preferredTags": ["mode:traditional-story"],
      "avoidedTags": ["mode:dialogue"]
    },
    "worldDataPath": "data/world.data.yaml",
    "worldData": {
      "schemaVersion": 1,
      "sources": [
        {
          "id": "dimensions",
          "target": "world:metadata.dimensions",
          "digest": "sha256:...",
          "order": 0,
          "origin": "world",
          "diagnostics": { "info": 0, "warning": 0, "error": 0 }
        }
      ]
    }
  },
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "World not found"
}
```

#### `POST /api/worlds`

Creates a world record.

- `id` can be left out. The server then generates `world-<uuid8>`.
- If `id` already exists, it is not overwritten. It returns `409 world_already_exists`.
- To change an existing world, use `PATCH /api/worlds/:id`.

**Request body:**

```json
{
  "id": "my-world",
  "name": "自定义世界",
  "description": "我的自定义世界描述",
  "locale": "zh-CN",
  "metadata": {}
}
```

**Response 201:**

```json
{
  "id": "my-world",
  "name": "自定义世界",
  "description": "我的自定义世界描述",
  "locale": "zh-CN",
  "metadata": {},
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z"
}
```

#### `GET /api/worlds/:id/dimensions/export`

Exports all the dimension definitions the author wrote (including `schema`, `initialValue`, and the optional `updateRule`), in YAML or JSON. It exports the definitions, not the current values of the dimensions in any session.

**Parameters:**

| Parameter | Location | Description                |
| --------- | -------- | -------------------------- |
| `id`      | Path     | World ID                   |
| `format`  | Query    | `yaml` (default) or `json` |

**Response:** returns the dimension data file as `Content-Disposition: attachment`.

**Errors:**

| Status code | When                            |
| ----------- | ------------------------------- |
| 400         | `format` is not `yaml` / `json` |
| 404         | The world does not exist        |

#### `POST /api/worlds/:id/dimensions/import`

Uses the content in the request to **replace** the world's dimension definitions as a whole.

- After the import, active sessions receive a notice that the author source has changed.
- The current values in a session are not reset automatically. For existing sessions, you must call the sync endpoint explicitly to adopt the new definitions. The sync checks for conflicts.
- Any valid dimension ID uses the same definition format.

**Request body:**

```json
{
  "dimensions": {
    "reputation": {
      "name": "声望",
      "schema": { "type": "integer", "minimum": 0, "maximum": 100 },
      "initialValue": 0,
      "updateRule": "完成居民委托后增加 5，只计已完成的委托。"
    }
  }
}
```

**Response:** the updated WorldRecord.

**Errors:**

| Status code | When                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| 400         | The request body has no object-type `dimensions`                                                              |
| 422         | Validation of the dimension definition, schema, or initial value failed. Unknown schema keywords are rejected |

Validation does not convert types for you, and it does not fill in default values. For the format and limits, see [World Data](./world-data.md#dynamic-world-dimensions-dimensions).

> [!IMPORTANT]
> Only the unified dimension definition above is accepted. A world file written in another format must be rewritten. The affected development worlds, sessions, and snapshots must be rebuilt. There is no format migration and no read fallback.

#### `PATCH /api/worlds/:id`

Partly updates a world. You can update the basic fields, or submit the top-level `dimensions` directly.

Behavior:

- The top-level `dimensions` are written to `metadata.dimensions`.
- `metadata` is merged on write. Sibling fields that are not mentioned are kept as they are.
- Both `dimensions` and `metadata.dimensions` go through world dimension validation.

**Example request body:**

```json
{
  "description": "更新后的描述",
  "dimensions": {
    "cityWall": {
      "name": "城墙耐久",
      "schema": { "type": "number", "minimum": 0, "maximum": 100 },
      "initialValue": 100,
      "updateRule": "只根据明确发生的损坏或修复更新；程度不明时保持原值。"
    }
  }
}
```

#### `POST /api/worlds/:id/sync-dimensions`

Syncs the world's current dimension definitions to one given session. This endpoint tries to write directly. If you want to preview first, or need the general sync options, use `sync-data`.

It handles only dimensions. It uses the `world_data_import_ledger` ledger and the protected `_dimensions` records. It does not write `entries`, does not write the always-on lorebook, and does not clean up other imported data.

Each dimension is handled by the rules below:

| Case                                                                        | Result                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Definition unchanged                                                        | Keeps the value that has evolved. The initial value is not applied again.            |
| New dimension                                                               | Initialized with its valid initial value.                                            |
| Definition changed or deleted                                               | Only records whose value still equals the imported baseline can be applied directly. |
| Value has evolved, was edited by hand, or still has an unsettled obligation | Reports a conflict. The definition, value, and version all stay as they are.         |

- A dimension with a conflict stays as it is and is listed in the report. The other dimensions are applied as usual.
- The write transaction validates again. A concurrent write is not overwritten.
- A change to the schema does not migrate the current data automatically.
- After success, public reads are republished with the committed current values.

**Request body:**

```json
{ "sessionId": "mistport-abcd1234" }
```

**Response:**

```json
{
  "ok": true,
  "imported": true,
  "dryRun": false,
  "diagnostics": [],
  "planned": 2,
  "upserted": 1,
  "deleted": 0,
  "unchanged": 1,
  "conflicts": [],
  "mediaRefs": []
}
```

#### `POST /api/worlds/:id/world-data/preflight`

Does a read-only preflight of one worldData import. It tells you how many entries will be imported and where they will go, but it writes nothing.

The request can be written in two ways:

- Pass `sessionId`: this uses the session's **saved `activePlugins`**. In this case, any `plugins` in the request is ignored.
- Pass only `plugins`: preflights a certain set of plugin choices before a session is created.

Preflight does not load or run the `worldProjections` handlers. So the output of a projection is not counted in `planned` / `targets`. The response carries a warning that says this part is deferred until the real import or sync runs.

**Request body:**

```json
{ "plugins": ["character-blueprint", "char-creator", "living-world-rules"] }
```

or:

```json
{ "sessionId": "haruka-academy-abcd1234" }
```

**Response:**

```json
{
  "imported": true,
  "planned": 12,
  "diagnostics": [],
  "targets": [
    {
      "kind": "plugin-data",
      "target": "contract:character.blueprints@1",
      "sourceId": "cast",
      "pluginId": "character-blueprint",
      "namespace": "blueprints",
      "key": "kamishiro-mio"
    }
  ]
}
```

#### `POST /api/worlds/:id/sync-data`

Sync the updated worldData from a world package into an existing session. **It only previews by default (dry-run).** Send `dryRun: false` to write.

**Request fields:**

| Field       | Type    | Required | Description                                                                                                  |
| ----------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `sessionId` | string  | Yes      | The session to sync. It must belong to this world                                                            |
| `dryRun`    | boolean | No       | Default `true`. Only `false` writes                                                                          |
| `force`     | boolean | No       | Overwrites `modified` / `missing` conflicts on ordinary import rows. It does not bypass dimension protection |

**What gets synced:**

- Only rows in the ledger `world_data_import_ledger` with `managed=true` are handled.
- It uses `valueHash` to check whether a player or a plugin has changed the target data.
- Dimension definitions are in the same ledger. This includes inline definitions, `dimensionSources`, and the effective definitions of a storage-backed world.

**How conflicts are handled:**

- A row with a conflict stays as it is and is listed in `conflicts`. The other rows sync as usual. `upserted` and `deleted` are the number of rows actually written and deleted.
- A conflict does not block other rows. A session that has been played always has dimensions that have already changed. If a conflict blocked the whole sync, new material added to the world package later (for example, a portrait) would never reach an old session.
- If the source of a dimension has not changed, its progress is not reset.
- The report shows a conflict when the author changed or removed a dimension, and the value in the session has already evolved, was edited by hand, or still has a pending receipt.
- `force: true` does not lift these dimension protections. It does not trigger a structure migration and does not force a reset.

**Concurrency:**

- Reading the source, validating the schema, and running the projection Worker all happen outside the session write lock. A dry-run is read-only from start to finish.
- When it really writes, the server first takes a short lock. Then it checks the world, the locale, the active plugins, and the approval scope again. If any of these changed while the plan was being prepared, it returns `409` (`world_data_sync_plan_stale`).

**Request body:**

```json
{ "sessionId": "haruka-academy-abcd1234" }
```

To write:

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false }
```

To force overwrite of `modified` / `missing` conflicts on ordinary import rows (this does not bypass dimension protection):

```json
{ "sessionId": "haruka-academy-abcd1234", "dryRun": false, "force": true }
```

**Response:**

```json
{
  "ok": true,
  "imported": true,
  "dryRun": true,
  "diagnostics": [],
  "planned": 12,
  "upserted": 2,
  "deleted": 1,
  "unchanged": 9,
  "conflicts": [
    {
      "target": "contract:character.blueprints@1",
      "key": "kamishiro-mio",
      "sourceId": "cast",
      "reason": "modified"
    }
  ]
}
```

**Errors:**

| Status | `code`                       | When                                                                                     |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------------- |
| 400    | —                            | `sessionId` is missing, or the session does not belong to this world                     |
| 404    | —                            | The session does not exist                                                               |
| 409    | `world_data_sync_plan_stale` | While the plan was being prepared, the world, locale, plugins, or approval scope changed |

#### `POST /api/worlds/:id/translate`

Add one language version to a world package.

The server does these things:

1. It finds which text is still missing in this language.
2. It asks the configured model to translate. First it lists the names and terms in the world. Then it translates the name fields. Then it translates the story text. One name always gets one translation.
3. It writes the translation to language files next to the main files in the world package: `world.<locale>.yaml`, `WORLD.<locale>.md`, and `data/*.<locale>.yaml`.
4. It adds this language to `supportedLocales` in `world.yaml`.

After that, a session created in this language uses this version.

**Request body:**

```json
{ "locale": "ja-JP", "idleTimeoutMs": 300000 }
```

| Field           | Type   | Required | Description                                                                                                                                                              |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `locale`        | string | Yes      | The language tag to add                                                                                                                                                  |
| `idleTimeoutMs` | number | No       | The longest time (in milliseconds) to wait for the next piece of output from each model request. The meaning and range are the same as for `POST /api/ai/generate-world` |

**Limits:**

- It only writes to world packages in the **user worlds directory** (`COVEL_USER_WORLDS_DIR`). These are the worlds generated and installed in the app.
- Built-in worlds come with their own language versions. A world that exists only in the database or in the browser has no files to write. Both cases return 409.
- The translation is a model draft. A person needs to check names, places, and tone.
- Hosted deployments (`demo` / `commercial`) need the operator token.

**When it writes:**

- While the model is generating, the server does not hold the world operation lock and does not write any language file.
- The lock is taken only at publish time. Inside it, the server checks the world's creation time and the package's real path and directory identity, writes language files and `supportedLocales` in a staging copy, then replaces the directory and saves the record after read-back preflight passes. Edits saved while the model was working are kept.
- A file-write or read-back failure discards the copy; a record-save failure restores the original package. The copy preserves media, authored files, and the generation marker.
- If the world is being deleted, has been deleted, or has been rebuilt with the same ID, the request receives an SSE `error`. The old request does not write files into the new package, and it does not clean up the new package's files.

**Response:** An SSE event stream.

| `type`     | Fields                                   | Meaning                                                                                                                                |
| ---------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `progress` | `step`, `done`, `total`                  | `step` is `glossary`, `names`, `texts`, or `long texts`                                                                                |
| `done`     | `world`, `total`, `translated`, `failed` | The reloaded `WorldRecord`. How many entries were missing at the start, how many were translated, and how many could not be translated |
| `error`    | `message`                                | The reason for the failure. It also happens when the model translates nothing, and the world package does not change                   |

**Errors (before the stream starts):**

| Status | `code`                     | Meaning                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------ |
| 400    | —                          | `locale` is not a language tag, or `idleTimeoutMs` is out of range |
| 404    | `world_not_found`          | There is no such world                                             |
| 409    | `world_not_translatable`   | The world package is not in the user worlds directory              |
| 409    | `world_already_translated` | This language has no missing text left                             |
| 409    | `world_deleting`           | The world is being deleted                                         |

**Failures after the stream starts:** The HTTP status stays 200. The failure is sent as `{ type: "error", message }`.

- Unknown storage or provider errors: in production, `message` is `Internal server error`. In development, the original diagnostic is kept.
- Lock wait timeout: `message` is `Session is busy, please retry`.
- All text was rejected: `message` is the reason for the first rejected item (no translation, a reply that is not JSON, or a placeholder that was changed). The internal reason is written to the server log.
- The world was deleted or replaced: `message` keeps this notice.

Whatever `message` says, publishing the language files is still all or nothing. Either everything is written, or nothing is.

#### `GET /api/worlds/:id/gallery`

Lists the images that come with a world package.

A `kind: media` source in a world package is only imported into the media library when a session is created. The world list and the world detail page have no session yet, so this endpoint reads the files directly from the world package.

**When there is a `media/gallery.json`:** the gallery is that manifest. Images are listed in manifest order, with their name, description, and category. For the manifest fields, see [Gallery metadata and frontend use](../worlds/art-direction.md#gallery-data-and-front-end-use). The endpoint reads only these fields:

- `id` and `kind` (`hero` / `map` / `scene` / `still` / `portrait`). An unknown value is shown as a normal image.
- `filename`, and the optional `webFilename`: paths relative to `media/`. Each must be "one folder level / file name". When `webFilename` is present, it is shown instead (it is much smaller).
- `name`, `description`, `background`, and `location`: translations in `gallery.<locale>.json` are merged into a language table, and the viewer picks the language.
- `spoilerLevel`: the gallery is shown before play starts. It lists only images that have no value or that are marked `opening`.

**When there is no manifest (or it cannot be parsed):** the endpoint lists images from the public `kind: media` sources in the world's data descriptor. Sources with `enabled: false` or `visibility: hidden` are not listed. Images are sorted by source order, then by file name. They have no name and no category.

Rules that apply in both cases:

- Only PNG, JPEG, and WebP files are listed, up to 60 images.
- A file whose pixel size cannot be read is not listed.
- A world with no world package (it exists only in the database or in the browser) returns an empty list.
- If the world does not exist, the response is 404.
- Read permission is the same as for `GET /api/worlds`. These images are distributed content of the world package. They do not belong to any session.

**Cover and theme music:**

- When `world.yaml` declares a `cover` (an image in one folder level under `media/`), the same file endpoint also returns it, at `/api/worlds/:id/gallery/<folder>/<file name>`. The world record's `metadata.cover` and `metadata.accentColor` keep these two declarations as they are. The client does not need to read the gallery first.
- When `world.yaml` declares `themeMusic` and the file can be played (a `.mp3` or `.wav` in one folder level under `media/`), the response gets one more field: `themeMusic: { url, mime }`. Its URL has the same shape as an image URL and is served by the same file endpoint.

**Response:**

```json
{
  "items": [
    {
      "id": "literature-clubroom",
      "source": "gallery",
      "url": "/api/worlds/haruka-academy/gallery/gallery/literature-clubroom.webp?v=mutk9d2a-4441o",
      "width": 1536,
      "height": 1024,
      "kind": "scene",
      "name": {
        "zh-CN": "文艺部的春日下午",
        "en": "Spring in the Literature Club"
      },
      "description": {
        "zh-CN": "旧社团楼三层的活动室里，稿纸、旧刊与海风等待下一次校稿。"
      }
    }
  ]
}
```

| Field              | Description                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`           | The first part of the URL. For images from the manifest, it is the folder name under `media/`. Otherwise it is the source ID in the descriptor. |
| `url`              | Includes the file version (modification time and size). When the file changes, the URL changes.                                                 |
| `width` / `height` | Read from the file that is actually shown.                                                                                                      |

The frontend uses images by `kind`:

| `kind`            | Use                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `scene` / `still` | Can fill the screen as a background                                                                                                |
| `portrait`        | Used as a character picture                                                                                                        |
| `map`             | Shown only in full                                                                                                                 |
| `hero`            | The world's own cover. For a world without a built-in cover in the app, it opens the game                                          |
| No `kind`         | Chosen by aspect ratio: a wide image (width at least 1.2 times height) is a background, and any other image is a character picture |

#### `GET /api/worlds/:id/gallery/:source/:file`

Returns the bytes of one image (or the world's theme music).

- It only responds to files that `GET /api/worlds/:id/gallery` lists.
- Any other path returns 404. This includes `..`, symbolic links, folders or sources that are not listed, and images in the manifest that are beyond the opening range.

**Caching:**

- The response has an `ETag`. When `If-None-Match` matches, it returns 304.
- When the `v` in the URL matches the current file version, the response has `Cache-Control: public, max-age=31536000, immutable`. Otherwise it is `no-cache`.

### Session management

#### `GET /api/sessions`

Lists all game sessions. Use `?worldId=` to see only the sessions of one world.

> [!NOTE]
> **Privacy gate**: when all three conditions below are true, this endpoint always returns `{ "items": [] }`. This stops players on a public, shared deployment from listing each other's sessions.
>
> - The server runs with `STORE_BACKEND=memory`. (The frontend is in local mode, and the server's sessions are only temporary copies used to run turns.)
> - `NODE_ENV=production`.
> - `ENABLE_DEBUG_PAGE` is not set.
>
> The frontend in local mode does not call this endpoint. Its list reads data from the browser instead, so product features are not affected.

**Response:**

```json
{
  "items": [
    {
      "id": "mistport-a1b2c3d4",
      "worldId": "mistport",
      "status": "active",
      "phase": "setup",
      "completedPlayerTurns": 0,
      "setupRuntimes": {},
      "locale": "zh-CN",
      "activePlugins": ["pregame", "narrator"],
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `POST /api/sessions`

Creates a new game session.

**Request body:**

```json
{
  "worldId": "mistport",
  "locale": "zh-CN",
  "plugins": ["pregame", "narrator", "codex"]
}
```

| Field          | Type     | Required | Description                                                                                                                                     |
| -------------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `worldId`      | string   | No       | The ID of a world that exists and is not being deleted (validated with `/^[a-z0-9_-]{1,64}$/i`). If omitted, a session with no world is created |
| `locale`       | string   | No       | The content language the player wants. Default `zh-CN`. See "Content language" below                                                            |
| `plugins`      | string[] | No       | A list of plugin IDs to activate                                                                                                                |
| `id`           | string   | No       | A session ID chosen by the client. If not given, it is generated as `{worldId}-{uuid8}`                                                         |
| `loreOverride` | string   | No       | The world background text used for this session. See "World background" below                                                                   |

**Content language (`locale`):**

- The session's content language must be a language version the world actually has. If the world has this language (or another region with the same language and script), that version is used. Otherwise the world's own language is used.
- When the actual language differs from the one requested, the response also has `requestedLocale` (the language you asked for). The client uses it to tell the player that this world has no version in that language, so the story will be in the world's language.
- The world's language versions come from `supportedLocales` in `world.yaml`. If it is not declared, only `defaultLocale` is available. Worlds generated in the app have only the one language they were generated in.
- The language is locked after creation. Later turns, manual runtimes, and background jobs all use it, and a request cannot change it.

**World background (`loreOverride`):**

- It is a string, in the same format as the background in the world document. An empty string means explicitly clear it.
- It is saved in the session's metadata in the same operation that creates the session.
- Later, starting the adventure, refreshing, and resuming all use the background the session saved. It does not reload the draft edits shared by the world, and it does not change when the world is edited later.
- If this field is not sent, the session uses the original world background. Existing sessions do not import the world draft automatically.
- The Web setup screen sends the background text it is currently showing with the create request. In browser-private mode, the text is first saved to the session checkpoint in BrowserVault. The same value is sent when the server mirror is created. If saving the background draft in the background fails, the session choice is not affected.

**Model selection:** A session does not store its own `presetId`. Model routing uses the slot configuration, request-level overrides, and `runtimeModelOverrides`.

**World package fields that affect creation:**

| Field                         | Effect                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadata.pluginPolicy`       | The plugin set policy for the setup screen. Its fields are `presetId` / `preferredTags` / `avoidedTags` / `requested` / `recommended` / `requires` / `packs`                                |
| `pluginPolicy.requires`       | Contract IDs the world requires. See the notes below                                                                                                                                        |
| `metadata.packageInfo`        | The world package's `version` and [author information](./plugins.md#author-information) (`author`, `license`, `homepage`). Used only to show on the world card. It does not go into prompts |
| `metadata.characterSchema`    | When the session is created, the character schema (`types` / `attributes`) is written. The kernel manages its version                                                                       |
| `metadata.embeddedCharacters` | When there are no file-based worldData, generic `{id,name,aliases?,type,description?,fields?}` records are imported into the session's `characters`                                         |
| `metadata.embeddedLorebook`   | When there are no file-based worldData, a session lorebook owned by the world is imported                                                                                                   |

Notes:

- `metadata.pluginPolicy`: the resolver combines the contract dependencies the plugin packages declare with their authorization state to work out the active set. It does not force core plugins to stay on.
- `pluginPolicy.requires`:
  - When the session is created, the world takes part in resolution as a dependent. If a contract has only one provider, that provider is added automatically.
  - These requirements are saved with the session in `metadata.pluginSelection.requiredContracts`. Later starts, stops, and reloads use this list and do not read the world again.
  - If no provider is installed, or there are several providers and the request does not pick one, the response is `400 { "code": "world_requirement_unmet", "details": { contract, code, candidates? } }`.
  - If the player turned a provider off on purpose, or the provider is a community plugin that is still waiting for approval, the session is still created.
- `metadata.characterSchema`: when a local session is created in Web private mode, the same schema is written. If the preset is not valid, the session is not created.
- `metadata.embeddedCharacters`: these are not a plugin's character cards. They do not make a copy of plugin data.
- `metadata.embeddedLorebook`: AI-generated worlds with `server-store` / `return-only` use it to carry their material and rules.

**Response 201:**

```json
{
  "id": "mistport-a1b2c3d4",
  "worldId": "mistport",
  "locale": "zh-CN",
  "status": "active",
  "phase": "setup",
  "completedPlayerTurns": 0,
  "setupRuntimes": {},
  "activePlugins": ["pregame", "narrator", "codex"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:00:00.000Z",
  "metadata": {},
  "ownerToken": "e7b2c4d1-…"
}
```

The response is the session record, plus a one-time `ownerToken`.

**Response fields**:

| Field                  | Type                                         | Description                                                                                                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownerToken`           | string                                       | The session's owner token. It is **returned only here** (the server stores only a hash). When it must be sent is explained below                                                                                                                                                          |
| `locale`               | string                                       | The session's actual content language                                                                                                                                                                                                                                                     |
| `requestedLocale`      | string (optional)                            | Appears only when the actual language differs from the requested one                                                                                                                                                                                                                      |
| `pluginsWithoutLocale` | string[] (optional)                          | IDs of enabled plugins that have no text in the session's language (they have only English labels, so the panel shows English). This is only a hint and does not stop creation                                                                                                            |
| `worldDataNotices`     | `{ level, sourceId?, message }[]` (optional) | World data that was not imported (warnings and errors), such as data that only a community plugin still waiting for approval receives. The game screen shows it to the player; see [Receivers that join after the game starts](./world-data.md#receivers-that-join-after-the-game-starts) |
| `status`               | `'active' \| 'paused' \| 'ended'`            | The session lifecycle status                                                                                                                                                                                                                                                              |
| `phase`                | `'setup' \| 'playing'`                       | Whether the session is in opening setup or in normal play. It starts as `setup` if the active set has a setup runtime, otherwise `playing`. It becomes `playing` once all setup runtimes are done                                                                                         |
| `completedPlayerTurns` | number                                       | The number of committed player turns in normal play. Interaction during setup is not counted. The same turn is never counted twice                                                                                                                                                        |
| `setupRuntimes`        | `Record<runtimeId, SetupRuntimeState>`       | The state of each setup runtime. See the table below                                                                                                                                                                                                                                      |

When `ownerToken` must be sent:

- `DEPLOYMENT_TIER=demo|commercial`: every session-scoped endpoint requires it.
- `DEPLOYMENT_TIER=self`, with `NODE_ENV=production` and the actual store being MemoryStore: it is also required.
- Other local sessions can ignore it. For details, see [Authentication: Session owner token](#authentication-session-owner-token).

`SetupRuntimeState` has three states:

| `state`   | Fields                                                                                     | Meaning                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` | `generation`, `attempts`, `lastError?`                                                     | Not finished yet                                                                                                                                                 |
| `done`    | `resolution: "completed" \| "waived"`, `generation`, `attempts`, `completedAt`, `warning?` | Finished. `waived` means the player skipped it, and it counts as finished in a reduced way                                                                       |
| `blocked` | `generation`, `attempts`, `reason`, `blockedAt`, `lastError?`                              | The `maxTriggerCount` attempts are used up and it is still not finished. The session stays in the setup phase. Use the `retry` / `waive` endpoints to unblock it |

- `attempts` is the number of attempts in the current generation that have already ended (and are not pending).
- `blocked.lastError` is the error from the last attempt that used up the allowed tries.
- All three states carry `pluginVersion`. When the plugin version changes, an old `done` is no longer valid, and the runtime runs again as `generation + 1`.

**Errors:**

| Status | `code`                    | When                                                                                               |
| ------ | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 400    | `world_requirement_unmet` | A contract the world requires has no provider, or has several providers and none is picked         |
| 401    | `operator_token_required` | On a hosted deployment (`demo` / `commercial`), the session was created without the operator token |
| 404    | `world_not_found`         | A `worldId` was given, but the world does not exist                                                |
| 409    | `world_deleting`          | The world is being deleted                                                                         |
| 409    | `session_already_exists`  | The `id` chosen by the client already exists                                                       |

- When `id` already exists, the response body is `{ "error": "Session already exists: <id>", "code": "session_already_exists" }`. Creating does not overwrite the existing session, and it does not treat the old session's child records as data for the new session.
- The server checks the world once before preparing resources and once more when the session is committed. Preparing does not attach media to the session. If it fails, any leftover bytes that nothing refers to are cleaned up by media GC. It does not force-delete content that another session might be using.

> [!NOTE]
> **Session ID format**: an automatically generated ID is `{worldId}-{uuid8}` (for example `mistport-a1b2c3d4`). The suffix comes from `crypto.randomUUID()`, so IDs cannot be guessed. If no `worldId` is given, the prefix is `session`.

#### `GET /api/sessions/:id`

Reads the full information of one session.

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Response 200:**

```json
{
  "id": "mistport-a1b2c3d4",
  "worldId": "mistport",
  "status": "active",
  "phase": "playing",
  "completedPlayerTurns": 3,
  "setupRuntimes": {
    "pregame": { "state": "done", "resolution": "completed" },
    "world-init/schema-gen": { "state": "done", "resolution": "completed" }
  },
  "locale": "zh-CN",
  "activePlugins": ["pregame", "narrator"],
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:05:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

#### `GET /api/sessions/:id/view`

Returns the combined view `SessionSnapshot`, used when restoring or reconnecting. One request gets the messages, characters, plugins, and execution state. The top level also has the public snapshot of the dimensions and the settlement summary:

| Field                       | Description                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `dimensions`                | `{id: {name,description?,schema,value,version}}`. The current values, not the author's starting values |
| `dimensionProviderPluginId` | Optional. The ID of the active provider bound by the host                                              |
| `dimensionRecovery`         | Optional. `{editorRuntimeId,trackerRuntimeId}`, checked by the host                                    |
| `dimensionSettlements`      | An array of receipt summaries: `{source:{resultId,turnNumber},status,sourceTurnId,version,error?}`     |

- The `status` of a receipt summary is one of `pending-settlement` / `settled` / `no-change` / `manual` / `skipped`.
- The `version` of a receipt summary is the version of the receipt, not the version of a dimension's value.
- The response does not include dimension rules, starting values, or the full receipt's `definitions` / `readVersions`.
- `dimensions` can be empty if the session has not initialized its dimensions yet.
- If the bound provider is missing or the read fails, the endpoint returns a clear error. It does not fall back to reading `WorldRecord.metadata.dimensions`.

Browser-private mode uses the same snapshot shape. It saves the current values, versions, and settlement obligations in one atomic BrowserVault checkpoint. For the fields and the timing of the freeze, see [World Model](./world-model.md#dynamic-dimension-snapshot).

#### `PATCH /api/sessions/:id`

Updates session fields. Right now you can change `status` and `runtimeModelOverrides`.

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Request body:**

```json
{
  "status": "paused",
  "runtimeModelOverrides": {
    "narrator": "story",
    "npc-graph/extractor": "fast"
  }
}
```

**Field notes:**

| Field                   | Type                              | Required | Description                                                     |
| ----------------------- | --------------------------------- | -------- | --------------------------------------------------------------- |
| `status`                | `'active' \| 'paused' \| 'ended'` | No       | The session lifecycle status                                    |
| `runtimeModelOverrides` | object                            | No       | Sets a model slot for a single runtime: `runtimeId → slot name` |

`status`:

- If it is not a valid value, the response is 400.
- `ended` is a final state. It cannot go back to `active` or `paused` (the response is `409 session_ended`).

`phase`, `completedPlayerTurns`, and `setupRuntimes` cannot be changed with PATCH. The server maintains them when a turn is committed:

- `phase` and `completedPlayerTurns` are written only in the transaction that finishes a turn.
- `setupRuntimes` is also updated at these times: after the transaction, the attempt count is settled (a rolled-back attempt still uses up a try). The executor blocks in advance when `needs(scope: session)` forms a cycle. And when the `retry` / `waive` endpoints are called.

`runtimeModelOverrides`:

- The key is a runtime ID (`pluginId` or `pluginId/runtimeName`). It must match `/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/`.
- The value is a slot name defined in `llm.toml`, such as `story` / `utility` / `fast`.
- Before each turn runs, the framework reads this field once. An explicit choice here has the highest priority. If it is not set, the framework goes down the [actual selection order](./slots.md#actual-selection-priority).
- An empty object `{}` clears all overrides.
- The plugin list and the session setup screen show the slots a runtime declares. If a declared slot is not configured, the interface asks you to add `[covel.<slot>]`. It does not quietly rebind to an unrelated text slot.
- Only the slot name is stored here. **The provider and the API key are still saved by the frontend. They are sent with each request in the `X-Provider-Keys` header, and they are not stored in the database.**

**Validation rules (runtimeModelOverrides):**

- It must be an object. `null`, an array, or any other type returns 400.
- At most 64 entries.
- An entry whose key is an empty string, whose value is not a string, or whose key does not match the format above is silently dropped.
- If the request does not have this field, the existing overrides stay unchanged.

**Response 200:** the merged session object, with `status`, `phase` / `completedPlayerTurns` / `setupRuntimes`, and `runtimeModelOverrides`.

**Errors:**

| Status | `code`                   | When                                                                                                     |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 400    | —                        | `status` is not valid, or `runtimeModelOverrides` is not an object                                       |
| 409    | `session_ended`          | The session is already `ended`                                                                           |
| 409    | `session_deleting`       | The session is being deleted                                                                             |
| 409    | `session_lifecycle_busy` | You are changing `status` while the `SessionStart` / `SessionEnd` hook is still running. Try again later |

#### `DELETE /api/sessions/:id`

Deletes a game session and all of its data. This cannot be undone.

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Response 200:**

```json
{
  "ok": true
}
```

**Response 404:**

```json
{
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

**Deletion runs in this order:**

1. Inside the session lock: stop accepting new operations, write a deletion marker, and rotate the authorization scope.
2. Find the jobs in the saved `_runtime_jobs` that have not finished (`queued` / `claimed` / `running` / `committing`). Wait for the locks of their background runtimes to drain.
3. Without holding the session lock, run the `SessionEnd` hook. It can only observe and cannot change anything.
4. Hold the session lock briefly: clear this session's ownership and references in media storage, then delete the session's records in the data store, following the cascade.

An old background job fails when it checks the session scope and state at the end, so after deletion no orphan record can be written back. The media ownership and references for the session are cleared when it is deleted. A session created later with the same ID does not inherit the old media's access.

**Conflicts and retries:**

| Status | `code`                   | When                                                                                                     |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| 409    | `session_lifecycle_busy` | A lifecycle change is made while `SessionStart` / `SessionEnd` is running. Retry after the hook finishes |
| 409    | `session_deleting`       | A deletion is already in progress                                                                        |

- While a hook runs, only lifecycle changes are blocked. Normal API calls for the same session are not affected.
- If draining jobs, clearing media, or deleting database records fails at any step, the session stays `paused`, the authorization scope stays rotated, the deletion marker stays valid, and normal writes are still rejected.
- After a failure, the server keeps a one-time retry credential. The next `DELETE` can take over and continue the deletion, and it does not run a `SessionEnd` that has already run.
- If the process crashes before recovery, the deletion lease expires after 10 minutes. After that, a new `DELETE` can take over.

**Reusing the same ID:** You can create a session with the same ID only after the old session is fully deleted. If the deletion is still in the hook or drain step, creating returns a `409` for a duplicate ID. Retry after `DELETE` succeeds.

**Sessions created earlier:** A session without a private identity marker can still be deleted. In the request isolation check, the server uses its existing owner hash or the saved `(id, createdAt)` as its identity. A newly created session always has a random identity marker, so recreating it with the same ID does not inherit the old identity.

### Turn execution

A turn is the basic unit of interaction in the game. Each message the player sends starts one turn. The server runs all the active runtimes, collects the model output, and returns it.

The only entry point is [`POST /api/actions`](#post-apiactions). The request body, the SSE frame format, and the opening handoff are described in that section.

**Turn rules:**

- Runtimes run stage by stage, in this order: `setup` / `pre-turn` / `narrative` / `post-turn` / `audit`. The next stage starts only after the current stage has fully finished.
- Within one stage, runtimes that do not depend on each other run in parallel. Runtimes that depend on each other are ordered by `needs` / `after` / `inputs`.
- `session.completedPlayerTurns` is the number of committed normal player turns. A run during setup is saved in `turn_results`, but it is not counted. After `phase` becomes `playing`, the first successful player turn moves it to `1`.
- The server uses `commitExecution` to commit, in one transaction, the results of the top-level run and of its recursive child runs, along with the journal and the pending items. In the transaction, each result is normalized first, then the state is committed. The SessionEvent is published only after the transaction commits.
- When a runtime's output has `pendingInputs`, the player's answer is sent with `submit_interaction` on `POST /api/actions`. The same request both saves the answer and runs the turn that reads it.
- `schedule.completion.mode: detached` applies only to a `post-turn` / `audit` function leaf that passes the safety check:
  - Its upstream results, its source run, its model, and its settings are frozen in the original turn.
  - The queue record is committed in the same transaction as the original turn.
  - A declaration that the static check considers unsafe still runs in the foreground, and it produces one diagnostic.

### Staged runtime background jobs

This group of endpoints manages the background jobs (`_runtime_jobs`) that the scheduler creates for `schedule.completion.mode: detached`. These are a different system from the plugin-rpc `execution: background` / `_jobs` protocol, and they do not affect each other.

- Authentication works the same way as other session endpoints (owner token).
- The `result` of a succeeded job includes the identity and duration of the background turn, the run, and the runtime, along with the runtime's `output`.
- The internal frozen inputs and settings are kept in `payload`. No response returns it.

**Which model credentials a background job uses:**

- The worker first uses the adapter / gateway that the source request kept in memory for a short time. The credentials are not written into the job.
- If the source credentials have expired, or after a process restart: the server's adapter is used only when the valid model configuration that the server resolves has an API key or an auth header.
- Otherwise the job stays `queued`. It waits for a new execution request that has credentials to serve it, or for its queue deadline.
- Having a default adapter object on the server does not mean credentials are configured.

**How "can it run" is decided:**

- The decision and the execution use the same model resolution and the same check of environment key sources.
- When the source request's service is used, both are resolved with that request's model configuration (slot bindings and custom presets) and its credentials.
- When the server adapter is used, it is resolved only with the server configuration. It is not affected by other requests that happen to wake the worker.
- It cannot prove statically whether a function handler will call a model. It also does not automatically allow a local endpoint that has no key.
- An embedded host or a test can use `ApiBootstrapConfig.canRunRuntimeJobWithServerServices` to confirm explicitly that its own adapter is available. This confirmation does not change runtime authorization, session identity checks, or commit checks.

#### `GET /api/sessions/:id/runtime-jobs`

Lists the jobs that are still kept, sorted by `enqueuedAt, jobId`.

Retention rules:

- All jobs that have not finished are kept.
- For finished jobs, only the latest 20 are kept for each runtime. Older ones are cleaned up by the background worker, and after cleanup they cannot be retried.

Each job object contains:

- `jobId` / `pluginId` / `runtimeId` / `status` / `origin` / `enqueuedAt` / `updatedAt` / `attempt`;
- the deadline and lease times;
- the identity of the background turn and run;
- after it ends, `result` / `error` / `reason`.

The response does not return the internal `payload`. This means frozen inputs, user settings, and the approval scope are not exposed.

```json
{
  "items": [
    {
      "schemaVersion": 1,
      "jobId": "job-uuid",
      "pluginId": "mimo-tts",
      "runtimeId": "mimo-tts/auto-narrate",
      "status": "running",
      "origin": {
        "activation": "stage",
        "sourceTurnId": "turn-uuid",
        "sourceExecutionId": "execution-uuid",
        "sourceRuntimeId": "mimo-tts/auto-narrate"
      },
      "enqueuedAt": "2026-09-03T06:00:00.000Z",
      "updatedAt": "2026-09-03T06:00:01.000Z",
      "attempt": 1,
      "maxQueueMs": 120000,
      "maxExecutionMs": 120000
    }
  ]
}
```

All values of `status`: `queued | claimed | running | committing | succeeded | failed | timed_out | cancelled | stale | orphaned`.

The `result` of a `succeeded` job is a summary of the background turn, the run, and the runtime. It is not a copy of plugin data. For plugin data, use the standard API and SSE after the proposal is committed.

#### `POST /api/sessions/:id/runtime-jobs/:jobId/cancel`

Cancels a job that has not yet entered commit.

- Cancellable statuses: `queued` / `claimed` / `running`. The server changes it to `cancelled` inside the session lock, then sends `job-status.updated`.
- On success, it returns the updated job object directly.
- If the job does not exist, has already entered `committing`, or has already finished, it returns `409` with `code: "runtime_job_not_cancellable"`.

After cancellation, the job is never committed. A provider call that was already sent may only be stopped along the way, but its late result cannot get into a commit.

#### `POST /api/sessions/:id/runtime-jobs/:jobId/retry`

Retries a job that has already failed and ended.

- Retryable statuses: `failed` / `timed_out` / `cancelled` / `stale` / `orphaned`. The session must still be `active`.
- A retry keeps the frozen original inputs and the stable settings, and refreshes these: the current session identity, the plugin approval scope, the locale, and `runtimeModelOverrides`.
- A retry creates a **new** `jobId` with the status `queued`. A job activated manually or by an event also uses a new execution `turnId`. The state of the original job does not change.
- On success, it returns the new job object directly with `202`.
- If the job cannot be retried, it returns `409` with `code: "runtime_job_not_retryable"`.

The framework does not automatically re-run jobs that failed. This avoids calling a paid provider again when its result was not saved. A normal `queued` job that no one has claimed keeps running after a restart.

**How a job runs:**

- The worker claims the job first and holds a lease that can be renewed. The default concurrency is 4. Jobs for the same `(session, plugin, runtime)` run one after another.
- `maxQueueMs` limits how long a job can wait in the queue.
- `maxExecutionMs` limits the time from `running` until the runtime execution returns. The time spent afterward waiting for the session lock to commit is not counted.
- After a restart, valid `queued` jobs are claimed again. A job that has waited past its queue time is marked `timed_out`. An in-flight job whose lease has expired is marked `orphaned`.
- The check runs once more before commit: whether the session is still `active`, whether its identity is unchanged, the plugin's approval scope and version, and the actual proposal effects.

Final states when the check fails:

| Final state | `reason`                  | When                                                                  |
| ----------- | ------------------------- | --------------------------------------------------------------------- |
| `stale`     | `pre-execution-rejected`  | Before execution, the session or plugin identity check did not pass   |
| `stale`     | `commit-barrier-rejected` | At the commit step, the session or plugin identity check did not pass |
| `failed`    | —                         | The effect check or the data commit failed                            |

Neither of these final states writes any game data.

### Player interactions

After a turn runs, it may produce `pendingInputs`, such as a form, a multiple-choice question, or a confirmation box. The player sends the answer with the `submit_interaction` action.

**Saving the answer and starting the next turn is one operation on the server:**

1. Inside the same session lock, check the answer and confirm it has not been answered before.
2. In one transaction, write the player's input and the `turn.started` event of the next turn.
3. Run this turn on the same SSE stream. The natural-language text the answer fills in becomes the player message for this turn.

So there is no in-between state where the answer is saved but the turn has not started. A second tab or a retry also cannot make the turn run again.

If this turn finishes the last setup runtime, the server automatically runs the normal turn next on the same SSE stream, with a new `turnId` and a separate transaction. In other words, finishing setup and the first normal story turn are two separate turns.

#### `POST /api/actions` (`submit_interaction`)

Sends the answer to one or more player interactions, and runs the turn that reads them. For the request headers, the SSE frame format, and the opening handoff, see [`POST /api/actions`](#post-apiactions).

**Request body:**

```json
{
  "requestId": "req-003",
  "type": "submit_interaction",
  "sessionId": "mistport-a1b2c3d4",
  "payload": {
    "turnId": "a1b2c3d4-...",
    "submissions": [
      {
        "interactionId": "char-creation-form",
        "type": "form",
        "values": {
          "name": "艾尔文",
          "class": "战士",
          "background": "孤儿出身的流浪剑客"
        }
      }
    ]
  }
}
```

| Field                 | Type         | Required | Description                               |
| --------------------- | ------------ | -------- | ----------------------------------------- |
| `type`                | string       | Yes      | Always `"submit_interaction"`             |
| `payload.turnId`      | string       | Yes      | The turn ID that produced the interaction |
| `payload.submissions` | Submission[] | Yes      | The array of submissions, 1 to 20 items   |

**Submission object:**

| Field           | Type                                       | Description                                                |
| --------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `interactionId` | string                                     | The interaction ID, from the turn output's `pendingInputs` |
| `type`          | `"form"` \| `"choice"` \| `"confirmation"` | The interaction type                                       |
| `values`        | object                                     | The values the player entered                              |

Other keys in a submission are dropped. The source plugin, field definitions, and templates are read only from the interaction that was submitted.

**Values format for the three interaction types:**

**Form (form):** each field name has one value

```json
{
  "interactionId": "create-character",
  "type": "form",
  "values": { "name": "艾尔文", "class": "法师" }
}
```

**Choice (choice):** give `selectedId`, and optionally `selectedLabel`

```json
{
  "interactionId": "path-choice",
  "type": "choice",
  "values": { "selectedId": "forest_path", "selectedLabel": "穿越黑暗森林" }
}
```

**Confirmation (confirmation):** give a boolean `confirmed`

```json
{
  "interactionId": "accept-quest",
  "type": "confirmation",
  "values": { "confirmed": true }
}
```

**Response:** an SSE event stream. When the answer is accepted, the first event is `interaction.submitted`. After it come the events of a normal turn (`execution.started` … `execution.completed`):

```json
{
  "type": "interaction.submitted",
  "turnId": "<turnId of the follow-up turn>",
  "payload": {
    "interactionTurnId": "a1b2c3d4-...",
    "results": [
      {
        "submissionId": "…",
        "interactionId": "char-creation-form",
        "values": { "name": "艾尔文", "class": "战士" },
        "filledNarrative": "旅人自称艾尔文，是一名孤儿出身的流浪剑客，以战士之姿行走江湖。"
      }
    ],
    "message": { "id": "…", "content": "旅人自称艾尔文，……" }
  }
}
```

| Field               | Description                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `interactionTurnId` | The turn that produced the interaction. The `turnId` in the envelope is the next turn                                                                  |
| `results[].values`  | The values the server saved. The client uses them to fill the form again, instead of the text the player typed                                         |
| `message`           | The player message for the next turn: `id` is the ID of the saved `turn_messages` row, and `content` is each `filledNarrative` joined with line breaks |

- `results[].values` is already normalized: numbers and booleans are converted to the field type, and `selectedLabel` is taken from the original option.
- When an interaction declares `submitBehavior.echoFilledNarrative: false`, its narrative is not counted in `message`. If none are counted, there is no `message`, and the turn runs with no player message.

**Rejection:** when the answer is not accepted, the stream has only one `error.occurred` event. There is no `interaction.submitted` and no `execution.started`. Nothing is saved, and no turn starts. The HTTP status is 200.

```json
{ "type": "error.occurred", "payload": {
    "message": "请填写“姓名”。", "code": "form_rejected",
    "details": { "issues": [{ "field": "name", "message": "请填写“姓名”。" }] } } }
{ "type": "error.occurred", "payload": {
    "message": "这项内容已经提交过了。……", "code": "interaction_already_submitted" } }
{ "type": "error.occurred", "payload": {
    "message": "Interaction not found: …", "code": "invalid_interaction_submission" } }
```

| `code`                           | Meaning                                                                                                                                 | Can it be sent again?                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `form_rejected`                  | The values the player entered did not pass validation                                                                                   | Yes. Fix the values and submit the same form |
| `interaction_already_submitted`  | This `(turnId, interactionId)` already has a saved answer                                                                               | Do not resend                                |
| `invalid_interaction_submission` | A request the client should not have sent: the interaction does not exist, the type does not match, or the shape of the values is wrong | —                                            |
| `form_validator_failed`          | The source plugin's form validator threw an error itself (it did not return a normal rejection reason)                                  | Yes. Nothing was written                     |

`form_rejected`:

- What is checked: required fields, numbers, ranges, steps, options, text length, and the source plugin's form validator.
- Text length uses the same limit as `send_message.content`: 100,000 characters (`MAX_PLAYER_MESSAGE_CHARS`).
  - If a single `text` / `textarea` field goes over, it is rejected field by field.
  - If the whole player message made from all the fields goes over, it is rejected as an error for the whole form. The reason is that this text is the player message for the next turn, and a retry after the turn fails also sends it as one message.
- `message` is the text written for the player in the session's locale. It uses the field's `label` to say which item it is and what to change.
- `details.issues` lists each rejection reason as `{ field?, message }`. `field` is the form field's `name`. An entry without `field` is an error for the whole form. All fields with errors are listed at once. `message` is these entries joined with line breaks.
- The client shows each message under its field, and focuses the first field with an error. Errors for the whole form are shown above the fields. Do not treat this as a failed request.

`interaction_already_submitted`:

- It is also text written for the player, and it has no `details`.
- It is returned whether or not the values are the same as the saved ones.
- The request that answered it also started the next turn, so the client does not resend. The client gets the saved values from `submittedInteractions` in `GET /api/sessions/:id/view` to mark the form, and it watches that turn through `GET /api/sessions/:id/execution`. The turn is either running, committed, or, after a failure, can be run again with the existing retry.

`form_validator_failed`:

- `message` is fixed text written in the session's locale.
- The original text the plugin threw goes only to the server log (with the request method, URL, and stack). It is not sent to the client, even in development.

**JSON responses before the stream starts:**

```json
{ "status": "approval-required", "approvalId": "…", "pending": { … } }   // 202
{ "error": "…", "code": "invalid_action_request" }                       // 400, the request body does not match the schema
{ "error": "…", "code": "form_provider_inactive" }                       // 400
{ "error": "…", "code": "form_provider_unavailable" }                    // 400
{ "error": "…", "code": "form_validator_undeclared" }                    // 400
{ "error": "Session not found: <id>", "code": "session_not_found" }      // 404
```

**When authorization is needed (202):** a form with a plugin validator, submitted after a server restart or after its authorization was revoked, first returns **202** `approval-required`. It asks for the `covel:plugin-server-code` session authorization of the source plugin.

- The source plugin is read only from the `sourcePluginId` of the submitted interaction. The client cannot choose it.
- A batch submission may ask for the authorization of several plugins one after another. The values are written all at once only after all the authorizations are granted and all validation passes.
- If the player refuses the authorization, the form content is kept.
- If the source plugin is disabled or uninstalled, it returns 400. It does not turn the plugin back on automatically.
- The Web client sends the same submission again with the same `requestId` after authorization. A hosted deployment also needs the operator token.
- The authorization check runs before the "already answered?" check. If you submit again a form that was already answered, and the source plugin's authorization has since expired, you first get a 202. After authorization, you get `interaction_already_submitted`.

**Connection drops:** once a turn starts, it runs on the server through to commit. This does not depend on the connection.

- A client that lost the response does not know whether the answer was saved, so it does not resend. It polls `GET /api/sessions/:id/execution`, and it marks the form as submitted using `submittedInteractions` from the combined view.
- When the next turn fails, `execution.retry` gives `send_message` (with the content of that player message). If there is no player message, it gives `retry_turn`. A retry does not submit the answer again.

**Usage notes:**

- Only assistant interactions that have already been submitted in the current session's conversation record are accepted. `turnId` / `interactionId` / `type` must match the original interaction. The client cannot make up a form, and it cannot change the interaction type.
- Validation by type:
  - `form`: checks required fields, the set of fields, and the field types.
  - `choice`: `selectedId` must come from the original options. The server normalizes `selectedLabel` from the original option.
  - `confirmation`: `confirmed` must be a boolean.
- Each `(turnId, interactionId)` can be answered only once.
  - If two requests submit the same interaction at the same time, the session lock makes one go first. The one that arrives first saves the answer and runs the turn. The one that arrives later gets `interaction_already_submitted`.
  - If the same batch gives the same value for the same interaction twice, the two are merged into one.
  - A batch submission is validated in full first, then written in the same transaction as `turn.started`.
- `filledNarrative` is **plain natural-language** text made by filling the player's input into a template. It contains no JSON structure. It is written to `turn_messages` as the player message for the next turn, so the narrator can refer to it.
- Templates are provided by the plugin. Placeholders are written as `{{fieldName}}`.
- When a submitted interaction has no template, a simple fallback narrative is generated, such as `[玩家输入] name: 艾尔文, class: 战士`.
- **Localization:** the two items below are resolved in the **session locale**.
  - The `{{confirmed}}` value for `confirmation` (confirm / cancel).
  - The prefixes of the fallback narrative (`[玩家输入]` / `[玩家选择]` / `[玩家确认]` / `[玩家取消]`).
  - The built-in text supports `zh-CN`, `en-US`, and `ru-RU`. A locale that is specified but not supported falls back to `en-US`.
  - In `en-US`, these are `Confirm` / `Cancel` and `[Player input]` / `[Player choice]` / `[Player confirmed]` / `[Player cancelled]`.

### Plugin RPC channel

#### `POST /api/sessions/:id/plugin-rpc`

Sends a structured command to a plugin in a session. It does not go through chat input, and it does not create a player turn. The `kind` in the request body decides what kind of command it is:

| `kind`    | Request body                             | What it does                                             | Returns                                  |
| --------- | ---------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `action`  | `{ kind, pluginId, action, payload }`    | Calls one RPC action that the plugin registered          | One JSON response                        |
| `runtime` | `{ kind, pluginId, runtimeId, payload }` | Runs one runtime by hand                                 | A sync result, or `202` + `jobId`        |
| `command` | `{ kind, commandId, input }` or `args`   | Runs one command from the session's command catalog      | Same as action                           |
| `event`   | `{ kind, pluginId, topic, payload }`     | The plugin's UI sends an event that this plugin declared | `eventId` and the background jobs queued |

##### Action level

Calls the handler that the plugin registers in `entry` with `covel.registerRpc`, or a default framework handler (such as `slash-debug`).

- The plugin must be one of the session's currently enabled plugins that can run now. The server checks once before approval, and again after taking the session lock. If the plugin is disabled, it returns `404 plugin_not_active`. It does not run the handler and does not add a new approval. A plugin the player confirmed that cannot run now (see `unavailable[]`) gets the same error, and the message gives the reason. A late request from an old panel is also subject to this check.
- `pluginId: "framework"` means a default framework action. It is not part of the plugin set that is enabled, and it runs under its own entry conditions. `framework` is a reserved ID that no plugin can take, so such a request runs only a framework default action; a request that names a plugin ID runs only an action that plugin registered itself.
- The handler runs inside the session lock and has 30 seconds. Past that the handler's `ctx.signal` aborts, and every later call it makes to `ctx.store` is refused. Store calls already in progress finish before the request returns `504 handler_timeout` and releases the lock. Data it wrote before the limit is kept, not rolled back.

##### Runtime level

Runs one target runtime by hand. It goes through the full turn flow: it builds the prompt, runs the tool loop, and submits proposals. Downstream runtimes triggered by an event keep running in the same turn. When one event has several subscribers, they run in order of `name`.

How it runs is decided by `schedule.manual.execution` in the runtime manifest:

- `sync` (default): waits for the runtime to finish and submit its proposals, then returns a summary JSON.
- `background`: inside the session lock, queues one durable background job (`_runtime_jobs`, with `origin.activation: "manual"`), and returns `202` and a `jobId` right away.
  - The background worker claims and runs the job, and commits the writes and the job's final state in the same transaction.
  - The status is pushed through the `job-status.updated` event and the `plugin-data.changed` event for `_runtime_jobs`.
  - A background follower that the entry runtime emits is queued as an event job in the same commit transaction (`origin.activation: "event"`). It is recorded in the parent job's `result.deferredJobs`.

##### Command level

Runs one command from the session's command catalog. There are two mutually exclusive forms, and both run the same command:

- `{ kind: "command", commandId, input }`: from the input box. `input` is the full raw input.
- `{ kind: "command", commandId, args }`: from the plugin's JSON-RENDER interface through `invokeCommand`. `args` are named arguments.

The server checks again that the plugin is still enabled. It validates and normalizes the arguments, then uses the manifest to decide which action to call and which context to inject. The client cannot submit `pluginId` or `payload`, and it cannot widen the context scope.

##### Event level

The plugin's own interface (JSON-RENDER, or `emitEvent` from a `webview`) sends a domain event that this plugin declared.

- The `topic` must be in this plugin's `contributes.events`. Internal topics with `advertise: false` are also allowed. A topic declared by another plugin always returns `404 event_not_declared`.
- The `payload` is validated against the schema for that topic. If it is not valid, it returns `400 event_payload_invalid`.
- After validation and approval pass, every runtime in the session that subscribes to this topic (`trigger: { type: event, topic }`, which may belong to any enabled plugin) is queued as an event job in the same transaction: `_runtime_jobs`, with `origin.activation: "event"`. The `origin.sourceTurnId` is the `eventId` of this emission. The background worker runs them with `ctx.triggerEvent`, and each one commits on its own.
- The request itself does not run any runtime. It returns `200 { status: "ok", eventId, topic, deferredJobs: [{ jobId, runtimeId }] }`. If there are no subscribers, `deferredJobs` is an empty array.
- As with running a runtime by hand, the click is the trigger decision. The subscriber's `startTurn`, `maxTriggerCount`, and `cooldownTurns` are not part of the decision.
- A community plugin goes through approval for `event:<topic>`. A community runtime among the subscribers also needs each of the same two grants as a manual run: the server code and `runtime:<name>`. Otherwise the runtime loader refuses to run it. Each request returns only the first missing grant (`202 approval-required`). The client approves and retries, until everything is in place and the job is queued.
- Background jobs run only when the session has usable model credentials (the same as other background jobs). Otherwise they stay `queued`.

##### When writes take effect

| How it is called                                           | When the write happens                                                                                                   | On failure                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| An RPC action the plugin registered (built-in plugins too) | Written right away inside the session lock                                                                               | If the handler fails afterward, writes that already succeeded are not rolled back |
| A framework default action                                 | Follows its own transaction rules                                                                                        | Follows its own transaction rules                                                 |
| Runtime level                                              | The `ctx.pluginData` writes and domain effects are submitted as proposals, and committed together after the run succeeds | If the commit fails, all domain writes from this run are rolled back              |

When several records must succeed or fail together, use a function runtime with `trigger.type: manual`. It runs a JS handler directly and does not need an LLM. A manual trigger does not run the narrative runtime along with it. Downstream runtimes continue only through explicitly declared scheduling relationships (such as an event chain). See [Function runtime contract](./plugins.md#inputs-and-outputs).

##### `context.store` in actions

The `context.store` that an action handler receives is bound to the current session and the current plugin. It provides only:

- `getSession()`
- `listTurnMessages(limit?)`: returns only the most recent committed messages, up to 200. If `limit` is omitted, it is also 200.
- This plugin's `getPluginData` / `setPluginData` / `listPluginData`

There is no `savePlayerInput`. A player submission can be written only through the form submission channel, and it goes through form validation. An action cannot fake player input.

##### Request

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Request body:**

Action level:

```json
{
  "kind": "action",
  "pluginId": "codex",
  "action": "regenerate",
  "payload": { "cardId": "shrine-of-stars" }
}
```

Runtime level:

```json
{
  "kind": "runtime",
  "pluginId": "dashscope-image-gen",
  "runtimeId": "dashscope-image-gen/prompt-generator",
  "payload": { "style": "cinematic" }
}
```

Command level, the input box form:

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "input": "/roll 2d6"
}
```

Command level, the structured JSON-RENDER form (`args` and `input` are mutually exclusive):

```json
{
  "kind": "command",
  "commandId": "dice-check:roll",
  "args": { "notation": "2d6" }
}
```

| Field                       | Type    | Required | Description                                                                                           |
| --------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------------- |
| `kind`                      | string  | Yes      | `action` / `runtime` / `command` / `event`. The server does not guess the kind from other fields      |
| `pluginId`                  | string  | No       | The plugin ID for action / runtime / event level. The framework default handler uses `framework`      |
| `action`                    | string  | No       | The RPC action name, in kebab-case. Mutually exclusive with `runtimeId` / `commandId`                 |
| `runtimeId`                 | string  | No       | The full runtime name, such as `my-plugin/my-runtime`. Mutually exclusive with `action` / `commandId` |
| `commandId`                 | string  | No       | The stable ID in the session command catalog. Mutually exclusive with `action` / `runtimeId`          |
| `input`                     | string  | No       | Command level, input box form: the full raw input                                                     |
| `args`                      | object  | No       | Command level, JSON-RENDER form: named arguments                                                      |
| `topic`                     | string  | No       | Event level only: an event topic this plugin declared                                                 |
| `payload`                   | unknown | No       | Input data passed to the handler                                                                      |
| `expectsBackgroundFollower` | boolean | No       | Runtime level only. See below                                                                         |
| `retryFromTurnId`           | string  | No       | Runtime level only. Retries with the context of the original turn. See below                          |

Extra rules for fields:

- **Required fields depend on `kind`**: action level needs `pluginId` + `action`. Runtime level needs `pluginId` + `runtimeId`. Command level needs `commandId`, plus one of `input` or `args`. Event level needs `pluginId` + `topic`.
- **Command level** does not accept `pluginId` or `payload`. You must give exactly one of `input` or `args`.
  - `input`: the server re-tokenizes it according to the command declaration, converts the types, and validates it.
  - `args`: unknown fields, types, `choices`, `required`, and variadic values are all validated against the server's command declaration.
- **Event level** accepts only `pluginId`, `topic`, and `payload`. The `payload` must be an object.
- **`payload`** is the input to the handler at action level. In an agent runtime it is the manualPayload. In a function runtime it is `ctx.manualPayload`.
- **`expectsBackgroundFollower`**: a sync entry runtime that only builds a prompt, and is expected to trigger a background follower, can set this to `true`. The framework queues one durable background job right away and returns `202`. The worker then runs the entry runtime and queues the follower. This lets the interface show the task without waiting for the prompt's LLM call to finish.
- **`retryFromTurnId`**: the server reads the `turn_results` that were saved for that turn, and treats the runtime outputs recorded there as the upstream results for this run. The target runtime's `io.inputs` / `schedule.needs` are therefore resolved from the original turn's narrative. (In an ordinary manual run, these resolve to empty.)
  - These results are used only as context. This run does not save them again.
  - If the turn is not found: `404 retry_turn_not_found`.
  - If the turn was not committed successfully (its `commitStatus` is not `committed`, meaning it was rolled back or not yet settled): `409 retry_source_not_committed`. A successful result from an uncommitted turn cannot satisfy a downstream `needs` condition.

**Resolution order (action level):**

1. Actions the plugin registered in `entry` (isolated by `pluginId`)
2. Framework default actions (global): `slash-debug`, used by `/debug`, and `slash-plugins`, used by `/plugins`

**Framework default actions:**

| Action          | Description                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `slash-debug`   | Reads the session / runtime / model context that `/debug` declares, and tells the client to open the debug page for the current session   |
| `slash-plugins` | Accepts only the `framework:plugins` command context. Opens the plugin diagnostics view for the current session. It can take a `pluginId` |

##### Response

**Response 200 — action level:**

```json
{
  "status": "ok",
  "result": {/* depends on the handler */}
}
```

A successful command uses the same structure, with these extra conventions:

- If the command declares a `context`, the top level of the response has one more field, `environment`. This is the latest environment, collected again after the action finishes, trimmed to the scope.
- The handler gets the snapshot from before execution in `ctx.environment`.
- The handler gets the same object in `ctx.command` and in the payload: `{ invocationId, commandId, command, canonical, raw, argv, args, source }`.
- `source` is `"composer"` (the input box) or `"plugin-ui"` (JSON-RENDER). Both entry points share the `commandId`, the typed `args`, the approval, and the handler.

**Response 200 — runtime level, sync mode:**

```json
{
  "status": "ok",
  "turnId": "7f3e-...",
  "runtimeResults": [
    {
      "runtimeId": "dashscope-image-gen/prompt-generator",
      "pluginId": "dashscope-image-gen",
      "status": "ok",
      "durationMs": 3421,
      "output": {/* materialized runtime output */}
    }
  ],
  "durationMs": 3480
}
```

- For a runtime that declares `io.concealed`, `output` is `null` here and in `details.runtimeResults` of a failure response.
- If the turn is aborted, there is one more field: `abortReason`.
- If a background follower was queued, there is one more field: `deferredJobs: [{ jobId, runtimeId }]`.

##### Dimension editing and recovery of pending settlements

To change dimension values, or to handle a source that is waiting to settle, use the runtime-level RPC above. There is no separate REST write endpoint.

> [!IMPORTANT]
> The client must take the plugin ID and runtime ID from `dimensionProviderPluginId` and `dimensionRecovery` in the session view (`GET /api/sessions/:id/view`). The `world-init` in the examples below is only an example. A generic client must not hard-code it.

**Ordinary value change** (this does not clear any settlement obligation automatically):

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/edit-dimensions",
  "payload": {
    "updates": [{ "id": "reputation", "expectedVersion": 2, "value": 10 }]
  }
}
```

The editor's payload is `{ updates, resultId?, resolution? }`:

- `updates` holds at most 64 items. `id` cannot repeat, and the values are validated against the same schema.
- If there is no source (no `resultId` / `resolution`), the call only changes values, and `updates` must have at least one item. The player cannot create a new dimension definition or change a schema here.
- When handling an existing pending settlement source, `resultId` and `resolution` must come as a pair. The `resolution` values are:
  - `manual`: confirms that it was handled by hand. You can submit a correction with it, or confirm explicitly with `updates: []`.
  - `skipped`: must be `updates: []`. It keeps the current value and records a final state. This source will not be settled again later.

**Explicitly skipping** a source (`resultId` comes from `dimensionSettlements[].source.resultId`):

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/edit-dimensions",
  "payload": {
    "updates": [],
    "resultId": "narrative-result-1",
    "resolution": "skipped"
  }
}
```

**Retry**: call `trackerRuntimeId` directly, with the **`sourceTurnId`** of that receipt (not the `resultId`):

```json
{
  "kind": "runtime",
  "pluginId": "world-init",
  "runtimeId": "world-init/dimension-tracker",
  "payload": {},
  "retryFromTurnId": "source-turn-1"
}
```

Retry rules:

- The server takes the narrative and the upstream results from the saved original turn record. It does not trust the body text or the source number that the client submits. These results are used only as context and are not submitted again.
- An ordinary manual run cannot get the narrative input. The editor does not call the tracker recursively. A source that has already ended is not settled again.
- If the old plan or the version it read has expired, the receipt stays pending. You must explicitly handle it by hand, skip it, or make one retry that fits the source boundary. The server does not rebase automatically.

**Version conflicts** are not handled as "last write wins":

- If the editor's pre-check finds a conflict, it returns `{ applied: false, code: "dimension-version-conflict", currentVersions }` in the runtime's `output`.
- If the conflict is found at the submit stage, the RPC returns `409 { error, code: "dimension-version-conflict", details: { currentVersions } }`.
- The client must read `GET /api/sessions/:id/view` again, check the values and the receipts, and only then submit again. `status: "ok"` or `submitted: true` does not prove that the change was saved to the database.
- When an automatic settlement is rejected, the submitted narrative can be kept. The receipt stays at `pending-settlement`, and you must check the receipt in the same way.

**Relation to turns:** when there is a pending receipt, `POST /api/actions` first retries once automatically before starting the turn (see [Dynamic dimensions](./dynamic-dimensions.md)). If it still has not settled, the turn ends with `abortReason`, and the text explains what the player can do. For the five receipt states, see [World Model](./world-model.md#turn-timing-and-settlement-receipts).

**Image and media generation output:**

A function handler returns media output through `HandlerResult.success.effects.assetGenerations[]`. The API puts this array in the runtime `output`. Each item is submitted as one `asset.generate` proposal, and it enters the trace, SSE, and view layer as a MediaRef.

```json
{
  "assetGenerations": [
    {
      "ref": {
        "id": "media_01HX...",
        "mime": "image/png",
        "sha256": "..."
      },
      "modality": "image",
      "meta": {
        "prompt": "A misty harbor stairway",
        "provider": "openai",
        "model": "gpt-image-1"
      }
    }
  ],
  "pluginData": [
    {
      "namespace": "images",
      "key": "img_01HX...",
      "value": {
        "status": "done",
        "ref": { "id": "media_01HX...", "mime": "image/png", "sha256": "..." }
      }
    }
  ]
}
```

The raw content that a provider returns is only temporary input to the handler. Examples are OpenAI's `b64_json`, the SDK's `base64`, and remote image URLs that expire. Before returning, the handler must store these in the media library:

- Bytes or base64: call `ctx.media.put()`.
- A remote URL: call `ctx.media.ingestUrl()`.

After that, the generated media is exposed only through `assetGenerations[].ref`, and through business records that contain only the ref.

Outbound rules for `ctx.media.ingestUrl()`:

- **Redirects**
  - The underlying `utils.fetchWithRetry` never follows redirects automatically.
  - `ingestUrl` explicitly passes `redirect: "manual"`, gets the original 3xx response, then runs `validateBaseUrl` (the SSRF policy) and the `permissions.http` check again for every `Location`. If the redirects go past `maxRedirects` (default 5), it fails.
  - When a plugin calls `ctx.utils.fetchWithRetry` itself, a 3xx response throws an error by default (or with `redirect: "follow"` / `"error"`). Only an explicit `redirect: "manual"` hands the 3xx back to the caller, and the caller is then responsible for checking every hop.
- **Permissions**
  - `ctx.media` and `ctx.utils` share the same `permissions.http` check.
  - A community runtime that uses `ingestUrl` to reach an origin it did not declare is refused (`http permission denied: …`). Remote URLs returned by `ctx.images.generate` / `ctx.speech.*` also take this path when they are stored. This applies even when the URL appears only in the provider's response. So an origin such as an image CDN must be written into `permissions.http`.
  - A built-in (trusted) runtime is not forced to follow this allowlist. The SSRF policy always applies to both.

The asset runtimes declared by the currently active `media.image-flow@1` extension have extra requirements:

- A runtime that completes successfully must return at least one valid `assetGenerations[]` entry in `HandlerResult.success.effects`.
- The extension's provider returns `{ entryRuntimeId, assetRuntimeIds }`. The host binds `providerPluginId` and checks that these runtimes really belong to that provider.
- A `pluginData` record in the `images` namespace must save a `ref`. If a completed output still carries an image field such as `url`, `base64`, or `dataUrl`, it is reported as a runtime error.

**Response 202 — runtime level, background mode:**

```json
{
  "status": "accepted",
  "jobId": "a3c9-...",
  "pending": true,
  "turnId": "7f3e-...",
  "runtimeId": "dashscope-image-gen/image-generator",
  "phase": "prompt"
}
```

`phase: "prompt"` appears only when the request has `expectsBackgroundFollower: true` and the target runtime is itself sync. In that case the entry runtime runs as a background job:

- A background follower was queued: the job status is `succeeded`, and `result.deferredJobs` lists the follower job.
- No background follower was triggered: the job status is `failed`, with `reason: "follower-not-emitted"`.

**Background job records (`_runtime_jobs`):**

Manual background jobs, event-triggered background followers, and the scheduler's detached stage all share one durable queue, with one row per job.

- Plugins are **not allowed** to write to this namespace.
- Ways to read it: SSE, `GET /api/sessions/:id/runtime-jobs`, or a plugin-data query.
- What you read is the public projection. It has no `payload`, and `error` shows only a fixed diagnostic text.

```
sessionId     : <session>
pluginId      : <owning plugin>
namespace     : "_runtime_jobs"
key           : <jobId>
value         : {
  status: "queued" | "claimed" | "running" | "committing"
        | "succeeded" | "failed" | "timed_out" | "cancelled" | "stale" | "orphaned",
  runtimeId: string,
  origin: { activation: "stage" | "manual" | "event", sourceTurnId: string, sourceRuntimeId?: string },
  enqueuedAt: ISO8601,
  finishedAt?: ISO8601,
  result?: {                                  // after a manual/event activation is committed
    turnId: string,                           // the turnId of this run (for manual activation, matches the 202 response)
    durationMs: number,
    runtimeResults: RuntimeResultSummary[],
    deferredJobs?: { jobId: string; runtimeId: string }[]
  },
  reason?: "runtime-reported-failure" | "follower-not-emitted" | "execution-failed" | …,
  error?: string                              // public diagnostic text
}
```

How a job ends:

| Case                                                                                                       | Job status                                     | What is written                                                              |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| The runtime reports failure in its own result (`status: "failed"`, an `error`, or a failed runtime result) | `failed`, `reason: "runtime-reported-failure"` | Committed as usual. The handler can use this to record its own failure state |
| Proposal commit fails                                                                                      | `failed`, `reason: "execution-failed"`         | The whole run is rolled back, and no follower is queued                      |
| The session is paused, ended, or has its authorization revoked during the run                              | `stale`                                        | Not committed                                                                |

When a runtime reports failure, its original error is kept in `result.runtimeResults`.

**Restarts and credentials:**

- Job rows are persisted. A job that is still `queued` after a server restart keeps running when credentials are available. The next request that carries provider keys hands the credentials over again, or the server's own credentials satisfy the readiness check.
- A job that was interrupted halfway is marked `orphaned` after its lease expires. The framework does not re-run it automatically, to avoid charging again for an image or speech generation.
- A failed or cancelled job can be retried with `POST /api/sessions/:id/runtime-jobs/:jobId/retry`. The retry uses a new `turnId`.

##### Errors

**Error responses:**

| Status | `code` / when it happens                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `kind` is missing or invalid; a required field for that kind is missing; fields from different kinds are mixed; `RpcValidationError`; command argument validation fails; `plugin_mismatch`; `event_payload_invalid` |
| 404    | `session_not_found` / `plugin_not_active` / `unknown_action` / `runtime_not_active` / `command_not_active` / `event_not_declared` / `retry_turn_not_found`                                                          |
| 409    | `session_not_active` / `session_deleting` / `session_incarnation_changed` / `approval_scope_changed` / `command_changed` / `retry_source_not_committed` / `dimension-version-conflict`                              |
| 429    | `queue_full` (the pending-approval queue for community plugins is full) / `background_queue_full` (the session's queued background jobs reached the limit, default 256)                                             |
| 500    | `turn_commit_failed`; the handler throws an unhandled exception; the handler module fails to load                                                                                                                   |
| 504    | `handler_timeout` (action level: the handler did not finish within 30 seconds)                                                                                                                                      |
| 503    | `event_directory_unavailable` (event level: the event directory is not available)                                                                                                                                   |

A few key points:

- `plugin_mismatch`: the `runtimeId` in a runtime-level request does not belong to `pluginId`.
- `command_changed`: the declaration of this command changed while the request was waiting.
- An unknown exception other than `turn_commit_failed` goes to the global error handler. It returns a generic `500` with no specific `code`.

> [!NOTE]
> In background mode, an exception inside the runtime does **not** become a 5xx status code. The `202` has already been sent. The failure is recorded on that background job, and the frontend learns of it through SSE.

> [!IMPORTANT]
> **The commit result is what counts.** A runtime may return `success`, but its proposal commit may fail. In that case:
>
> - A sync RPC returns `500 turn_commit_failed`. The diagnostic information is in the `details` of the generic error envelope (`turnId`, `runtimeResults`).
> - The background job is marked `failed` (`reason: "execution-failed"`), and it does **not** queue the background followers of that turn, because later jobs should not be built on state that was rolled back.
> - The main turn path (`POST /api/actions`) follows the same rule.

Two-step approval for community plugins:

- **Action (an action registered in `entry`)**: on the first call, the action is not registered yet.
  1. The server first returns an approval whose `action` is fixed as `covel:plugin-server-code`, which means "load this plugin's server code". The fixed name stops a caller from faking an action name to trick the server into loading code.
  2. After the player approves for the session scope, the server loads the entry and checks whether the action exists. If it does not exist, it returns 404 right away. If it exists, it returns another separate approval for the real action.
  - The client must be able to handle these two consecutive `approval-required` responses. If the same request keeps asking for the authorization of the same `(pluginId, action)`, the client should stop retrying.
  - Under the `demo` / `commercial` deployment tier, both steps need the operator token.
  - A built-in plugin's entry already ran when the server started, so an unknown action returns 404 right away.
- **Runtime (`runtimeId`)**: also two steps.
  1. When the server-code authorization is missing, the first call returns a `covel:plugin-server-code` approval.
  2. After approval, the retry returns a `runtime:<runtimeId>` approval.
  - The runtime loads and runs only when **both** authorizations exist exactly. Loading the entry also accepts only the exact `covel:plugin-server-code` grant. Another action's grant cannot unlock module loading.
  - Revoking clears both kinds of authorization together for `(session, plugin)`.

### RPC approval flow

An RPC action from a third-party plugin (source `community`) needs the player's explicit approval before it runs. This stops code that nobody has audited from acting on the session by itself.

#### Flow

```
┌─────────┐    POST plugin-rpc                   ┌────────┐
│ Client  │ ───────────────────────────────────► │ Server │
└─────────┘    {pluginId, action, payload}       └────────┘
                                                       │
                                                       ▼
                                          gate.evaluate()
                                                       │
                       ┌───────────────────────────────┤
                       │                               │
              builtin                         community
              + not in cache                  + not in cache
                       │                               │
                       ▼                               ▼
              run directly → 200 ok      create pending → 202 approval-required
                                                       │
                                            ┌──────────┴──────────┐
                                            │ Client shows dialog │
                                            │ POST decision       │
                                            └──────────┬──────────┘
                                                       │
                                            allow once / allow session / deny
                                                       │
                                            send plugin-rpc again
                                                       │
                                                  allow → 200 ok
```

In words:

1. The client calls `plugin-rpc`.
2. A built-in plugin runs directly and returns `200`.
3. If a community plugin has no cached grant, the server creates a pending approval record and returns `202 approval-required`.
4. The client shows a dialog. The player chooses to allow once, allow for this session, or deny. The client sends the choice to `POST /api/approvals/:approvalId/decision`.
5. After allowing, the client sends the same `plugin-rpc` request again. This time it returns `200`.

#### Extra response status for `POST /api/sessions/:id/plugin-rpc`

| Status | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| 202    | The community plugin needs the player's approval. The response body is below |

Other 4xx and 5xx responses use the generic `{ error, code?, details? }` envelope described at the top of this page. They do not return `status: "error"`.

**202 response body:**

```json
{
  "status": "approval-required",
  "approvalId": "9d8c-...",
  "pending": {
    "approvalId": "9d8c-...",
    "sessionId": "sess-...",
    "pluginId": "third-party-plugin",
    "action": "do-thing",
    "payload": {/* the original payload */},
    "trustLevel": "community",
    "requestedAt": "2026-04-15T20:00:00.000Z",
    "description": "Run the thing"
  }
}
```

#### `GET /api/sessions/:id/approvals`

Lists all the requests in this session that are waiting for approval. After a page refresh, the frontend uses it to rebuild the dialog queue.

**Response 200:**

```json
{
  "items": [
    { "approvalId": "9d8c-...", "pluginId": "...", "action": "...", ... }
  ]
}
```

#### `POST /api/approvals/:approvalId/decision`

Submits the player's decision on one pending request.

The caller must be the owner of the session that the request belongs to. Under the `demo` / `commercial` deployment tier, approvals for community plugins also need the operator token. A failed authentication does not use up the pending record.

**Request body:**

```json
{
  "decision": "allow",
  "scope": "once"
}
```

| Field      | Type                    | Required           | Description                                              |
| ---------- | ----------------------- | ------------------ | -------------------------------------------------------- |
| `decision` | `"allow"` \| `"deny"`   | Yes                | The player's choice                                      |
| `scope`    | `"once"` \| `"session"` | Only when allowing | The grant scope. The default is `once`. Limits are below |

Limits on `scope`:

- A normal action can choose `once` (the default) or `session`.
- `covel:plugin-server-code` and `runtime:*` load modules that stay in memory for a long time, so they accept only `session`.

**Response 200:**

```json
{
  "ok": true,
  "decision": "allow",
  "scope": "once",
  "pending": {/* the original pending data, already removed from the queue */}
}
```

After `allow`, the server immediately loads the runtimes the plugin is authorized for in this session. If a runtime cannot be loaded (its handler or guard module failed to import), the response has one more field: `runtimeLoadErrors: [{ runtimeId, error }]`:

- If the approval was for `runtime:<id>`, it covers only that one runtime.
- If the approval was for `covel:plugin-server-code`, it covers all the runtimes that were already authorized before.

The grant itself stays in effect. A runtime that cannot be loaded fails as a single task during a turn. It does not affect the other tasks.

**Error responses:**

| Status | When                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `decision` is missing, or is not `allow` / `deny`. `scope` is invalid. The server-code or runtime approval used a scope other than `session`                            |
| 404    | The `approvalId` does not exist or was already used (`approval_not_found`). The session it belongs to does not exist (`session_not_found`)                              |
| 409    | The session grant for this approval was revoked, the plugin was disabled, the session was deleted, or a session with the same ID was rebuilt (`approval_scope_changed`) |

#### `DELETE /api/sessions/:id/approvals`

Revokes the grants for this session. Cached session grants, one-time grants, and requests still waiting are all cleared. This is used when the player wants to take back trust from a community plugin partway through.

**Query parameters:**

| Parameter  | Required | Description                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------ |
| `pluginId` | No       | Revokes the grants of only this one plugin. If omitted, the whole session is revoked |

**Response 200:**

```json
{ "ok": true, "cleared": 2 }
```

`cleared` is the number of grants that were cleared (session grants and one-time grants together).

Other rules:

- With `pluginId`, only that plugin's grant generation is changed. Without it, the generation for the whole session is changed. Generations are saved persistently, so a revocation also takes effect on other instances that share PostgreSQL.
- Requests waiting for approval are de-duplicated by `(session grant generation, plugin, action, payload)`. The same action with different arguments counts as a different pending request.
- Disabling a plugin, or removing a plugin because of a conflict, also revokes its grants. An old `approvalId` cannot be used afterward to activate the code again.

#### Plugin source and approval behavior

| Plugin source | Source                                                 | Approval behavior                                                                |
| ------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `builtin`     | Bundled with the framework / framework default handler | Always runs directly                                                             |
| `community`   | Third party, default level                             | Needs the player's approval every time, unless there is a grant for this session |

> [!NOTE]
> A one-time grant is valid for 60 seconds. It can be used only once, by a request whose payload is **exactly the same** (the order of object keys does not affect the comparison). If you change the arguments and retry, the old grant is not reused, and the request goes through approval again. If the matching request is not sent within 60 seconds of the player's approval, the grant expires.

> [!WARNING]
> Pending requests and grants exist only in the **memory of the current process**:
>
> - Everything is cleared when the server restarts.
> - A grant approved on one instance is not copied to another instance.
> - Only the revocation generations of sessions and plugins are saved persistently. This makes sure an old grant can only become invalid on other instances. It never grants access by mistake to a session that was deleted and rebuilt with the same ID.
>
> Under load balancing, to avoid repeated dialogs, you would need to build a separate shared, persistent approval store.

### Plugin management

#### `GET /api/framework/authoring`

Returns the list of what can go into a world, for the world creation screen and for development agents. It reflects the plugins the server has loaded right now.

- All of the content comes from the `contributes.data.*.authoring` declarations in plugin manifests. There is no hard-coded plugin list.
- `pnpm describe:authoring` prints the same data.
- An unreadable or non-JSON example, or a missing, invalid, or conflicting schema for generatable content, skips only that contract. The optional `diagnostics` array returns `{ pluginId, namespace, message }` for each problem, also logged by the server; other contracts and plugins remain available.
- The `locale` query parameter sets the language of display text such as `title`. If it is omitted, the server's default language is used.

**Response excerpt:**

```json
{
  "files": [
    {
      "path": "world.yaml",
      "purpose": "World manifest: identity, locales, plugin selection, character schema.",
      "reference": "docs/reference/schema/world-manifest.md"
    }
  ],
  "destinations": [
    {
      "title": "Characters",
      "description": "Character records of the session's world model.",
      "source": {
        "id": "characters",
        "entry": {
          "kind": "json",
          "path": "characters/characters.json",
          "to": "characters",
          "key": "id"
        }
      }
    }
  ],
  "contracts": [
    {
      "contract": "memory.blocks@1",
      "pluginId": "memory",
      "namespace": "definitions",
      "title": "题材记忆块",
      "hint": "Write one object with `id: world` and a `blocks` list. …",
      "schema": "./schemas/block-definitions.schema.json",
      "source": {
        "id": "definitions",
        "entry": {
          "kind": "json",
          "path": "data/memory-blocks.json",
          "schema": "contract:memory.blocks@1",
          "to": "contract:memory.blocks@1",
          "key": "id"
        }
      },
      "example": { "id": "world", "blocks": [] },
      "generate": "default"
    }
  ],
  "plugins": [
    {
      "id": "memory",
      "displayName": "记忆",
      "description": "…",
      "tags": [],
      "provides": [],
      "requires": [],
      "settings": []
    }
  ]
}
```

| Field          | Description                                                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `files`        | Which files are in the world package, and where each one's field table is                                                                                          |
| `destinations` | The data targets owned by the kernel (dimensions, characters). They do not depend on any plugin                                                                    |
| `contracts`    | Each data contract that a plugin receives: the receiving plugin, the title, writing hints, the entries that can go directly into `world.data.yaml`, and an example |
| `generate`     | Appears only when the in-app generator can produce this content: `offer` lists it as an option, and `default` lists it and selects it by default                   |
| `plugins`      | The plugin catalog: ID, name, description, the contracts it provides and requires, and the settings that can be preset with `pluginSettings`                       |

#### `GET /api/framework/capabilities`

Returns an index of the framework's capabilities. Third-party developers, external tools, and AI agents can use it to check in code which fields, URIs, tools, and events Covel supports at the moment. It describes the framework itself and does not depend on any particular plugin.

**Response excerpt:**

```json
{
  "schemaVersion": 1,
  "framework": {
    "pluginManifest": {
      "triggerTypes": ["auto", "manual", "scheduled", "event"],
      "outputKinds": ["story", "plugin", "system"],
      "runtimeTypes": ["agent", "function"],
      "executionModes": ["sync", "background"],
      "turnCompletionModes": ["await", "detached"],
      "inputInjectKinds": [
        "runtime",
        "plugin-data",
        "runtime-export",
        "kernel"
      ],
      "uiSlots": ["right", "message", "left"]
    },
    "scheduling": {
      "effectsPolicy": "warn"
    },
    "pluginData": {
      "scope": "(sessionId, pluginId, namespace, key)",
      "reservedNamespaces": ["_runtime_jobs", "_logs"],
      "writePaths": [
        "builtin-tool:plugin-data-set",
        "function-output:pluginData[]"
      ]
    },
    "worldData": {
      "effects": ["characters", "projections"],
      "targetUris": [
        "world:metadata.<path>",
        "contract:<contractId>",
        "contract:<contractId>+lorebook"
      ],
      "schemaUris": [
        "covel://world/dimensions",
        "contract:<contractId>",
        "<local-json-schema-path>"
      ],
      "schemas": {}
    }
  }
}
```

> [!NOTE]
> **Values of `triggerTypes`**: the only trigger types available are `auto` / `manual` / `scheduled` / `event`. `triggerTypes` lists all four. For details, see [reference/plugins.md → Runtime grouped fields](./plugins.md#runtime-field-groups).

#### `GET /api/plugins`

Lists all the plugins the server has found. It returns `{ items: PluginSummary[] }`.

Fields of `PluginSummary`:

| Field                                                       | Meaning                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`, `displayName`, `description`                          | The package's identity and its localizable description                                                    |
| `kind`, `source`                                            | `core \| plugin` and `builtin \| community`                                                               |
| `hostState`, `error?`                                       | Host state `discovered \| installed \| loaded \| error`, and the load error                               |
| `provides`, `requires`, `optional`, `conflicts`             | Package-level contract declarations                                                                       |
| `extensions`                                                | Declared extension points, their IDs, order, and listener information                                     |
| `eventTopics`                                               | Topics declared in `contributes.events`                                                                   |
| `runtimeCount`, `runtimes`, `tools`, `userSettings`, `tags` | The runtime summary, tools, and user settings                                                             |
| `languages`                                                 | `{ text: string[], instructions: string[] }`, see below                                                   |
| `version?`, `author?`, `license?`, `homepage?`              | The version and [author information](./plugins.md#author-information) from the manifest. For display only |

Field notes:

- `eventTopics`: when a session resolves its plugin set, it uses this to make sure a topic has only one declaring plugin.
- `languages.text`: the languages the plugin has text in. This covers labels, interface text, text in code, and translations in the translation catalog. `languages.instructions`: the languages it has instructions (prompt body) in. Both always include at least `en`.
- `author.about` and the `label` of links can be maps split by language.
- Each runtime summary includes `id`, `runtimeType`, `trigger`, `execution`, the effective `turnCompletion`, `outputKind`, and optionally `outputContract`.

`hostState` says whether the server has loaded this plugin. It does not say whether a session has enabled it. These are two different states, and the list does not show the first as a session's active state.

- `loaded` comes from the actual publish state of the current entry, and has nothing to do with the runtime cache.
- If the first publish fails, the state is `error`.
- If a reload fails but the old version is still usable, the state stays `loaded` and can carry an `error`.
- Only a package that declares something, or that has only an entry, can have no runtimes.

The interface should discover behavior through the public contracts and extension points. It must not infer a capability from a specific plugin ID.

#### `GET /api/plugins/:id`

Returns the full description of one plugin, `PluginDetail`. If the plugin does not exist, it returns `404` (`code: "plugin_not_found"`).

`PluginDetail` contains all the fields of `PluginSummary`, and adds:

| Field                           | Description                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dataSchemas`                   | From `contributes.data`                                                                                                         |
| `worldProjections`              | The public source contract and the output namespace / key. Host paths and executable handlers are not public                    |
| `declaredPluginDataNamespaces`  | The declared plugin-data namespaces. Also includes the namespaces that each runtime uses to inject its own data (`io.selfData`) |
| `ui.right` / `message` / `left` | The aggregated UI slots. Each item keeps its `path`. `runtimeId` is included only when the slot belongs to a runtime            |
| `runtimes[]`                    | The full runtime development contract                                                                                           |

Notes:

- `runtimes[].after` / `needs` / `inputs` / `effects` / `turnCompletion` are compiled execution descriptions. They explain execution order, input conditions, and detached behavior. Authors write something different: they declare package-level `contributes` in `PLUGIN.md`, and they declare execution settings in the `schedule` / `io` / `agent` / `function` groups of `RUNTIME.md`. Do not submit this internal structure as a manifest.
- Dynamic keys are not listed in the manifest. Read them with a plugin-data query for the current session or with the `_index` endpoint.
- Services, tools, actions, slash commands, and extensions are different kinds of registration, and each must be declared separately.

### Session plugin management

#### `GET /api/sessions/:id/plugins`

Lists the plugins this session can see, and the commands the session can run right now.

- `items[]`: each item adds `active`, `locked`, `sessionState`, and `serverCodeApproved` to `PluginSummary`, and can also include `approvalRequired`, `autoAdded`, and `rejection`.
- `items[].runtimes` has exactly the same shape as in `GET /api/plugins`.
- `commands[]`: the only executable command catalog. It is filtered by the plugins that are currently enabled, plus the framework commands. Each command is listed once at the top level, and it is not repeated per plugin.
- `unavailable[]`: the plugins the player confirmed that cannot run now. Each item is a `rejection` (`pluginId`, `code`, `reason`). The cause can be that the plugin is not installed (`unknown-plugin`), failed to load, or that its installed version lacks a provider or conflicts with another member. The game goes on.
- The list, the commands and the executor read the same set: the session's saved `activePlugins`, checked against the installed versions, with no new plugin added. The rules are in [Session plugin selection](./plugins.md#session-plugin-selection). This endpoint only reads; it does not rewrite the session.

**Response:**

```json
{
  "commands": [
    {
      "id": "framework:plugins",
      "pluginId": "framework",
      "source": "framework",
      "name": "plugins",
      "description": { "zh": "查看插件注册能力与最近的服务调用" },
      "arguments": [{ "name": "pluginId", "type": "string" }],
      "action": "slash-plugins"
    },
    {
      "id": "framework:debug",
      "pluginId": "framework",
      "source": "framework",
      "name": "debug",
      "aliases": ["trace"],
      "description": { "zh": "打开当前会话的调试与执行跟踪视图" },
      "action": "slash-debug",
      "context": ["session", "active-runtimes", "models"]
    }
  ],
  "items": [
    {
      "id": "narrator",
      "displayName": "核心叙事者",
      "description": "主要叙事生成插件",
      "kind": "core",
      "hostState": "loaded",
      "active": true,
      "locked": false,
      "provides": ["narrative-engine@1"],
      "requires": [],
      "optional": [],
      "conflicts": [],
      "extensions": [],
      "eventTopics": [],
      "sessionState": "active",
      "serverCodeApproved": true,
      "tags": ["mode:traditional-story", "cost:llm"]
    }
  ]
}
```

#### `PUT /api/sessions/:id/plugins/:pluginId`

Turns on a plugin in this session. The server recalculates the session's active set (solving the contract dependencies).

**Response:**

```json
{ "ok": true, "activePluginIds": ["pregame", "narrator", "codex"] }
```

The response also has `resolution`, which is the full result of this solve.

When the session has a world and plugins newly join its active set, the server imports the world's data once for them (rules: [Receivers that join after the game starts](./world-data.md#receivers-that-join-after-the-game-starts)), and the response has a `worldData`:

| Field       | Type                              | Meaning                                                        |
| ----------- | --------------------------------- | -------------------------------------------------------------- |
| `receivers` | string[]                          | The plugins that received data for the first time              |
| `imported`  | number                            | The rows written                                               |
| `conflicts` | number                            | The rows left as they were because the game changed them       |
| `notices`   | `{ level, sourceId?, message }[]` | World data still not imported with the plugins that are on now |

Rules (enabling and disabling are the same):

- Enabling, disabling, and other writes to the same session share the session lock. After it gets the lock, the server reads `activePlugins` again. It saves to storage first, and only then updates the in-process registry. This way concurrent requests do not overwrite each other, and a failed save never leaves memory and storage out of step.
- A dimension provider bound to the session must stay enabled. It holds this session's `_dimensions` data, and turns, snapshots, and browser checkpoints all need it. If the active set after re-solving no longer includes it, the request is refused with `409 { "code": "dimension_provider_required" }`, and the session's plugin choice does not change.

#### `DELETE /api/sessions/:id/plugins/:pluginId`

Turns off a plugin in this session.

- The plugin is removed from the user's requested set and added to the excluded set. Then the contract dependencies are solved again.
- Plugins that depend on it may be refused as a result, or may switch to another available provider.
- `kind: core` does not mean the plugin is forced on. For now, `locked` is always `false`.
- The session's grants for this plugin are revoked as well.

**Response:** `{ ok: true, activePluginIds, resolution }`. `activePluginIds` is the active set after solving, and `resolution` is the full result of the solve.

**Errors:**

| Status | `code`                           | When                                                                                                                           |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 409    | `session_not_active` and similar | The session is not active, it has entered the deletion process, or it was replaced by a session with the same ID while waiting |
| 409    | `dimension_provider_required`    | The plugin being disabled is the dimension provider bound to the session, or disabling it would also remove it after solving   |

When an error happens, the session is not changed.

### State query

The state system keeps facts about the game world in structured tables. Examples are character attributes, world state, and quest progress. Plugins submit state changes through the `state.patch` proposal. The endpoints here are read-only.

#### `GET /api/sessions/:id/state`

Returns all the state tables of this session and the data in them. Table names and data keys are kept with their original names, including legal JSON keys such as `__proto__`.

Rate limit: the same client can make at most 120 requests per minute to the same path. Going over returns `429` (`code: "rate_limit_exceeded"`, with `Retry-After`).

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Response 200:**

```json
{
  "tables": {
    "character_stats": {
      "schema": {
        "name": "character_stats",
        "fields": [
          { "name": "hp", "type": "number", "default": 100 },
          { "name": "mp", "type": "number", "default": 50 }
        ]
      },
      "data": {
        "hp": 85,
        "mp": 42
      }
    },
    "world_flags": {
      "schema": {
        "name": "world_flags",
        "fields": [
          { "name": "gate_opened", "type": "boolean", "default": false }
        ]
      },
      "data": {
        "gate_opened": true
      }
    }
  }
}
```

**Response 404:**

```json
{
  "error": "Session not found: <id>",
  "code": "session_not_found"
}
```

### Message history

#### `GET /api/sessions/:id/messages`

Returns the **complete** list of messages in the session, in ascending time order. For long sessions, use `/page` first. This endpoint is kept as a fallback read when there is no snapshot, and for bulk sync.

The rate limit is the same as for `/page`: the same client can make at most 120 requests per minute to the same path. Going over returns `429` (`code: "rate_limit_exceeded"`, with `Retry-After`).

**Parameters:**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | Path     | Session ID  |

**Response:** `{ items }`. Each item is a flat message object. `turnId`, `runtimeId`, `kind`, and `block` are moved up from `metadata` in storage to the top level.

```json
{
  "items": [
    {
      "id": "msg-001",
      "sessionId": "mistport-a1b2c3d4",
      "role": "user",
      "content": "我环顾四周",
      "turnId": "turn-1",
      "createdAt": "2025-01-15T10:00:00.000Z"
    }
  ]
}
```

#### `GET /api/sessions/:id/messages/page`

Reads messages a page at a time. Within each page, messages are in **ascending time order (older first)**. The chat screen uses it to load history one page at a time as the user scrolls up.

- Without `cursor`: returns the newest page.
- With `cursor`: returns the page before it (older).

**Parameters:**

| Parameter | Location | Description                                                                                              |
| --------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `id`      | Path     | Session ID                                                                                               |
| `limit`   | Query    | Number of items per page. Default 80, maximum 500                                                        |
| `cursor`  | Query    | The `nextCursor` from the previous page's response. The client must send it back exactly as it was given |

`cursor` is an opaque string, and the client must not parse it. The server encodes a versioned `(createdAt, id)` position in it, so records with the same millisecond are neither skipped nor repeated. An invalid or unsupported cursor returns `400 invalid_cursor`.

**Response:**

```json
{
  "items": [
    {
      "id": "msg-041",
      "role": "user",
      "content": "…",
      "turnId": "turn-8",
      "createdAt": "…"
    }
  ],
  "nextCursor": "<opaque string>"
}
```

`nextCursor` points to the oldest item on this page, and it is used to fetch the next page (older). If the number of items returned is less than `limit`, the start of the history has been reached, and `nextCursor` is `null`.

#### `POST /api/sessions/:id/messages/sync`

Appends a batch of messages to the server session. The built-in Web client does not call it. A browser-private session uses `PUT /api/sessions/:id/browser-checkpoint` to upload a complete checkpoint instead.

**Request body:** `{ "messages": [...] }`. Each message:

| Field       | Type   | Required | Description                                                      |
| ----------- | ------ | -------- | ---------------------------------------------------------------- |
| `role`      | string | Yes      | `user` / `assistant` / `system` / `tool`                         |
| `content`   | string | Yes      | The message text                                                 |
| `id`        | string | No       | A stable message ID. If omitted, the server generates one        |
| `createdAt` | string | No       | The creation time. If omitted, the server's current time is used |
| `turnId`    | —      | No       | Saved in the message's metadata                                  |
| `runtimeId` | —      | No       | Saved in the message's metadata                                  |
| `block`     | —      | No       | Saved in the message's metadata                                  |

**Response:** `{ "ok": true }`

Rules:

- In the same session, sending an `id` that was already submitted is skipped. So restoring a saved game or retrying a network request does not append the whole history again.
- A message without an `id` gets a new ID every time, so sending it again appends it again.
- The whole batch is written inside the session lock and one storage transaction. If any new message fails to write, the whole batch is rolled back.
- The session must be in the `active` state.
- Rate limit: the same client can make at most 60 requests per minute to the same path. Going over returns `429` (`code: "rate_limit_exceeded"`).

### Plugin data

Each plugin has its own key-value store in each session. A piece of data is located by four parts: `(sessionId, pluginId, namespace, key)`. Different sessions and different plugins cannot see each other's data.

> [!NOTE]
> The built-in Web UI uses only the read endpoints here (the right-hand panel, UI inside messages, and the plugin data cache). `PUT` and `DELETE` are write entry points for admin tools and scripts. The built-in Web UI does not call them. A plugin's own runtime should write data through the plugin data tools, the plugin RPC, or proposals.

Shared rules for the read endpoints:

- Hidden world data (the `_hidden.*` namespaces) and kernel bookkeeping data are not returned.
- If `pluginId` is not a loaded plugin, the response is `404` (`Unknown plugin: <id>`).

Shared rules for the write endpoints (`PUT` / `DELETE`):

| Status | `code`               | When                                                                        |
| ------ | -------------------- | --------------------------------------------------------------------------- |
| 403    | —                    | `namespace` is a namespace reserved by the kernel                           |
| 403    | —                    | The target is a core plugin (its data can only be changed by its own tools) |
| 403    | —                    | The plugin is not enabled in this session                                   |
| 404    | —                    | `pluginId` is not a loaded plugin                                           |
| 409    | `session_not_active` | The session is not in the `active` state                                    |

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace`

Lists all the data a plugin has under one namespace.

**Request**

| Parameter   | Location | Description                               |
| ----------- | -------- | ----------------------------------------- |
| `id`        | Path     | Session ID                                |
| `pluginId`  | Path     | Plugin ID (such as `world-init`)          |
| `namespace` | Path     | Namespace (such as `schema` or `entries`) |

**Response**

```json
{
  "items": [
    { "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." },
    { "namespace": "schema", "key": "skills", "value": { ... }, "updatedAt": "..." }
  ]
}
```

#### `GET /api/sessions/:id/plugin-data/:pluginId/_index`

Lists the namespaces and keys that a plugin already has in this session. It does not return `value`.

It is useful for three things: debugging; letting an AI agent discover on its own what the current session's data looks like; and letting the UI build a light index.

**Response**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "pluginId": "codex",
  "namespaces": [
    {
      "namespace": "entries",
      "count": 2,
      "latestUpdatedAt": "2026-05-07T10:00:00.000Z",
      "keys": [
        {
          "key": "codex-001",
          "createdAt": "...",
          "updatedAt": "...",
          "valueType": "object"
        },
        {
          "key": "codex-002",
          "createdAt": "...",
          "updatedAt": "...",
          "valueType": "object"
        }
      ]
    }
  ]
}
```

#### `GET /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

Reads one piece of plugin data. If that data does not exist, it returns `404`.

**Response**

```json
{ "namespace": "schema", "key": "attributes", "value": { ... }, "updatedAt": "..." }
```

#### `PUT /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

Writes a piece of plugin data, or overwrites it.

**Request**

```json
{ "value": { "dimensions": ["strength", "agility", "wisdom"] } }
```

| Field   | Type | Required | Description                                                          |
| ------- | ---- | -------- | -------------------------------------------------------------------- |
| `value` | Any  | Yes      | The value to save. Its maximum size as JSON is 256 KiB (UTF-8 bytes) |

The 256 KiB limit is shared with proposals and writes from handlers. See [tools.md](./tools.md).

**Response**

```json
{ "ok": true, "namespace": "schema", "key": "attributes" }
```

**Errors**

| Status | `code` | When                                            |
| ------ | ------ | ----------------------------------------------- |
| 400    | —      | The request body has no `value`                 |
| 413    | —      | `value` is over 256 KiB, and nothing is written |

For other errors, see the write rules at the start of this section.

#### `DELETE /api/sessions/:id/plugin-data/:pluginId/:namespace/:key`

Deletes one piece of plugin data.

**Response**

```json
{ "ok": true }
```

### Suspend / Resume

A runtime can pause partway through and wait for the player to provide data. This is called suspending. The endpoints in this section let you list the suspended items, submit data so that a runtime continues, or discard an item.

> [!NOTE]
> **Expiry cleanup**: Before it handles a resume request or a `GET /api/sessions/:id/suspensions` request, the server also runs a global expiry cleanup. The cleanup runs at most once per time interval. If it fails, the current request still goes ahead. An expired suspended item is handled the way [abandoning](#delete-apisessionsidsuspensionssuspensionid) one is; see [Suspensions and turn counting](#suspensions-and-turn-counting).
>
> If the process exits while a resume is in progress, it leaves a "resuming" lock behind. Both this cleanup and server startup release that lock, so the suspended item can be resumed or discarded again later. External calls that were already sent are not undone. This is the same as retrying after a failed resume. For the related environment variables, see [`env-registry.md`](./env-registry.md).

#### `POST /api/sessions/:id/suspensions/:suspensionId/resume`

Resume a suspended runtime with the data the player submitted.

- **agent runtime**: Continues from the saved tool-call record.
- **function runtime**: Calls the handler again. This time's data is passed in through `ctx.resumeData` and `ctx.resumedFromSuspensionId`. It does not enter the model loop.

**Request**

```json
{
  "data": {/* the shape must match suspension.resumeSchema */}
}
```

| Field  | Type   | Required | Description                                                                  |
| ------ | ------ | -------- | ---------------------------------------------------------------------------- |
| `data` | object | Yes      | Data the player submitted. It must match the suspended item's `resumeSchema` |

- The server checks `data` against `resumeSchema` with full JSON Schema validation (Ajv). This covers `enum`, nested objects, `min` / `max`, `minLength` / `maxLength`, `pattern`, array `items`, `oneOf` / `anyOf`, and more. If the data does not match, the server returns `400`.
- A browser client can send an `X-Provider-Keys` header to give model keys for this request. The desktop app and self-hosted clients can leave it out, and the server then uses the keys it was started with. The server never returns keys through this endpoint.

**Response**

```json
{ "result": <ResumeResult>, "events": [ /* events produced by this resume */ ] }
```

**Errors**

| Status | `code`                | When                                                                                                                                     |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | —                     | The request body is not valid JSON or has the wrong structure, or `data` fails `resumeSchema` validation                                 |
| 404    | —                     | The session or the suspended item does not exist, or the matching runtime cannot be found                                                |
| 409    | —                     | The suspended item has already been handled. If two resume requests arrive at the same time, the later one gets this result              |
| 409    | `suspension_outdated` | The suspended item is out of date and the server voided it; see "Out-of-date suspended items" below                                      |
| 500    | —                     | The runtime failed or the commit failed (`error` gives the reason). In production, an unknown exception shows as `Internal server error` |
| 503    | `session_busy`        | Waiting for the session lock timed out. The fixed message is `Session is busy, please retry`                                             |

Rules for failed responses:

- A failed response returns only the general error envelope. It does not include a runtime result.
- If the runtime itself fails, `error` is `Resume failed: <reason>`. This is the same text the player sees for `runtime.failed` in the turn event stream.
- If the commit fails, `error` is `Resume commit failed: <reason>. The suspension remains unresolved and can be retried.`
- After a failure, this request releases its hold on the suspended item (unless the session was deleted and recreated), so you can retry. The internal cause is written only to the server log.

##### Out-of-date suspended items

A suspension records two things: how many player turns the history holds at that moment, and the version of the plugin that asked. Before a resume, the server checks whether the suspended item is out of date. An out-of-date item does not run again, because the writes it saved could overwrite newer state.

| `details.reason`   | When                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `session-moved-on` | The number of player turns in the history changed (the player played on, or rewound)      |
| `plugin-updated`   | The plugin that asked changed version                                                     |
| `superseded`       | The same runtime suspended again later; only a runtime's newest suspended item can resume |

The server voids it the way [abandoning](#delete-apisessionsidsuspensionssuspensionid) does, then answers `409` with `code` `suspension_outdated` and an `error` written for the player. The web client removes it from the waiting list and tells the player the request is out of date.

Writes that a background job or a manual run made after the suspension do not count as the session moving on, so they do not make the item out of date.

##### Suspensions and turn counting

- A suspension does not by itself count as a completed player turn.
- When a runtime suspends, the record of "where to continue from" is saved in the same transaction as this request's proposals, log, and session clock. The `turn.suspended` event is sent only after the commit succeeds. So if the commit is rolled back, no suspended item is left behind that can be resumed but has no origin, and no extra events are sent.
- The original execution's `logicalTurnId` and `countPolicy` are saved with the suspended item. When a resume succeeds, the player's turn count goes up by one, in the same transaction that commits the proposals.
- If one logical turn has several parallel suspended items, the count happens only after the last one is resumed. Retries do not count twice.
- When a suspended item is abandoned, expires or is voided, the turn ends the way a normal end does: if it was the last item of the logical turn still waiting, the player's turn count goes up by one and the background jobs the turn held back (`schedule.completion.mode: detached`) are queued as usual. Both happen in the transaction that deletes the record. An item that another request is resuming still counts as waiting.
- Progress jobs (`ctx.progress`) that the suspended execution reported stay in `waiting-input`. When a resume commits, they end as `succeeded`; when the item is abandoned, expires or is voided, they end as `cancelled`. While a failed resume can be retried, they keep waiting.

##### Resuming setup runtimes

When the runtime being resumed is a setup runtime, the completion signal is handled the same way as in a normal setup run:

- The "done" mark is written in the resume's commit transaction. If it completes the last setup, `phase` also switches in that same transaction. If the commit is rolled back, neither is written.
- The attempt count is the one from when the runtime suspended. It is not counted again.
- A resume does not hand off the opening turn. If it completes the last setup, the main loop starts from the player's next action.

#### `GET /api/sessions/:id/suspensions`

Lists all current suspended items in this session, sorted by `createdAt` from earliest to latest.

**Response**

```json
{
  "items": [
    {
      "id": "susp_abc123",
      "sessionId": "world-uuid8",
      "turnId": "turn-...",
      "runtimeId": "core-foo/bar",
      "pluginId": "core-foo",
      "reason": "需要玩家选择路线",
      "resumeSchema": {
        "type": "object",
        "required": ["choice"],
        "properties": { "choice": { "type": "string" } }
      },
      "createdAt": "2026-04-12T00:00:00.000Z"
    }
  ]
}
```

Each item is a `SuspensionSummary`. It contains only the public information the resume interaction needs. The continuation context (`pendingContinuation`) and the hold and processing status are internal server data, and they are not returned here.

#### `DELETE /api/sessions/:id/suspensions/:suspensionId`

Discards a suspended item by deleting it. This is used when the player gives up the current choice, or when an admin screen cleans up. If the suspended item does not exist, it returns `404`.

If it was the last item of its turn still waiting, the turn counts as complete and the background jobs the turn held back are queued as usual; see [Suspensions and turn counting](#suspensions-and-turn-counting). The request may carry `X-Plugin-User-Settings`, which works as it does for a resume.

**Response**

```json
{ "ok": true, "suspensionId": "susp_abc123" }
```

### Snapshot / Fork

A snapshot saves the full session state at the end of a turn as one `payload`. It is the basis for saving, loading, and forking a timeline. A fork creates a new session from a snapshot, so you can keep playing from that point.

- Snapshots are stored in the `state_snapshots` table.
- There are three `kind` values: `auto` (automatic), `manual` (made by hand), and `fork` (written to the child session when a fork is made).

> [!NOTE]
> These server features are all implemented and covered by tests. The built-in Web UI uses `GET /api/sessions/:id/view` to restore and reconnect. There is no UI yet for a manual snapshot list or for forking.

#### `POST /api/sessions/:id/snapshots`

Saves the session's current state as a snapshot with `kind="manual"`.

**What a snapshot contains**

- The session's lifecycle and run settings: `status`, `phase`, `completedPlayerTurns`, `setupRuntimes`, `locale`, `activePlugins`, `runtimeModelOverrides`
- `characters`, `stateEntries`, `pluginData`, `characterSchema`, `lorebookEntries`
- `sessionSummaries`: the compressed summaries that the message cursor actually refers to
- `compactedMessageSummaryIds`: the mapping from messages to summaries at the time of the snapshot
- `suspensions`: suspended items that are not yet handled
- `messagesCursor`: the last `turn_message.id`

**What is guaranteed when it is created**

- Reading and saving both hold the session's execution lock for the whole time. So the snapshot never captures a turn that is only half committed.
- If a compression tag on a message points to a summary that does not exist, the server refuses to create the snapshot. Otherwise some history would be hidden when the snapshot is restored.
- On a PostgreSQL deployment, if a running turn holds the lock for more than 30 seconds, the server returns `503 { code: 'session_busy' }`. Try again later.

**Snapshot format (v3)**

- `stateSchemas`, `runtimeExports`, `sessionSummaries`, `compactedMessageSummaryIds`, and `displayMessagesBoundary` must all be present.
- An empty array, an empty map, and a chat boundary set to `null` each have a clear meaning. None of them means "missing".
- Development-time snapshots that are missing fields must be rebuilt. The server does not migrate them, and it does not fill the gaps with the parent session's current state.
- Storage writes, SQL reads, and browser checkpoints all use the same payload validation. A summary mapping must point to a summary that is actually in the snapshot. Otherwise the server rejects it.

**Response**

Returns `201 Created`. The body is the player-visible view of the `SnapshotRecord`. The filter rules are the same as for [reading a single snapshot](#get-apisessionsidsnapshotssnapshotid) below.

```json
{
  "id": "<uuid>",
  "sessionId": "mistport-a1b2c3d4",
  "turnId": "turn-42",
  "kind": "manual",
  "payload": {
    "schemaVersion": 3,
    "turnId": "turn-42",
    "session": {
      "status": "active",
      "phase": "playing",
      "completedPlayerTurns": 42,
      "setupRuntimes": {
        "world-init": {
          "state": "done",
          "resolution": "completed",
          "generation": 1,
          "attempts": 1,
          "pluginVersion": "1.0.0",
          "completedAt": "2026-04-13T00:00:00.000Z"
        }
      },
      "locale": "zh-CN",
      "activePlugins": ["world-init", "narrator"],
      "runtimeModelOverrides": { "narrator": "story" },
      "loreOverride": "The session's captured world lore."
    },
    "characters": [/* ... */],
    "stateSchemas": [/* StateSchemaRecord[] */],
    "stateEntries": [/* ... */],
    "runtimeExports": [/* RuntimeExportRecord[] */],
    "pluginData": [/* ... */],
    "characterSchema": null,
    "sessionSummaries": [
      /* SessionSummaryRecord[] referenced by the current message prefix */
    ],
    "compactedMessageSummaryIds": { "tm_abc": "summary_xyz" },
    "lorebookEntries": [],
    "suspensions": [/* unresolved SuspensionRecord[] */],
    "messagesCursor": "tm_abc",
    "displayMessagesBoundary": null
  },
  "createdAt": "2026-04-13T00:00:00.000Z"
}
```

About `payload.session.loreOverride`:

- It stores the session's override text for the world background. An empty string means the player deliberately cleared the background.
- If the session has no override, the field is left out, and the session keeps using the world's own background.
- It is kept when a checkpoint is exported and transferred.
- A snapshot does not copy the session's other metadata. The owner token, the approval scope, and the session's identity are generated by the new session.

**Errors**

| Status | `code`                        | When                                                                                                                  |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 404    | `session_not_found`           | The session does not exist                                                                                            |
| 500    | —                             | An unknown error while building the snapshot. In production, only a generic 500 is returned, with no internal details |
| 500    | `fork_media_reference_failed` | Writing a media reference failed during a fork. The message is always `Failed to reference media for fork`            |
| 503    | `session_busy`                | Waiting for the session lock timed out                                                                                |

Unknown errors while building a snapshot or forking are handled the same way: the underlying cause is written only to the log. Known business conflicts keep their own `code` and status. If a media reference fails, the server first rolls back the transaction and removes any references it already added, and then returns the error.

#### `GET /api/sessions/:id/snapshots`

Lists this session's snapshots (`auto` / `manual` / `fork`) one page at a time. It returns only metadata, **not `payload`**. A payload is the whole session state, so returning all of them would grow without limit. When you need the full content, read a snapshot by its id (see the next section).

**Request**

| Parameter | Location | Required | Description                                                             |
| --------- | -------- | -------- | ----------------------------------------------------------------------- |
| `limit`   | query    | No       | Items per page. The default is 50, and the maximum is 500               |
| `cursor`  | query    | No       | The `nextCursor` returned for the previous page. Pass it back unchanged |

- Without `cursor`: returns the newest batch.
- With `cursor`: returns the page just before it, which is older.
- Within each page, items are sorted by `createdAt` in ascending order (the oldest first).
- The paging rules are the same as for `/messages/page` and trace paging.

**Response**

```json
{
  "items": [
    {
      "id": "<uuid>",
      "sessionId": "mistport-a1b2c3d4",
      "turnId": "turn-42",
      "kind": "manual",
      "parentId": null,
      "createdAt": "2026-04-13T00:00:00.000Z",
      "payloadSize": 18342
    }
  ],
  "nextCursor": "<opaque-cursor>"
}
```

- `nextCursor` is an opaque string. It marks the position of the oldest snapshot on this page, and you use it to get the page before. It is `null` when the page has fewer items than `limit`, which means you have reached the oldest snapshot.
- The database calculates `payloadSize` directly. The list does not load the payload itself.
- For a snapshot with `kind="fork"`, `parentId` is the id of the source snapshot. For other kinds, `parentId` is `null`.

**Errors**

| Status | `code`              | When                       |
| ------ | ------------------- | -------------------------- |
| 400    | `invalid_cursor`    | The `cursor` is not valid  |
| 404    | `session_not_found` | The session does not exist |

#### `GET /api/sessions/:id/snapshots/:snapshotId`

Reads one snapshot by id, including the full `payload`, and returns the `SnapshotRecord` directly. If the snapshot does not exist, or does not belong to this session, it returns `404` (`code: "not_found"`).

The response is the player-visible view of the snapshot. The rules are the same as for other read endpoints:

- `payload.pluginData` leaves out hidden namespaces (`_hidden.*`) and the kernel's bookkeeping rows. The other rows are shown in the public form of the plugin data API.
- `payload.runtimeExports` leaves out the exports of runtimes that declare `io.concealed`.
- `payload.suspensions` shows only the same summary fields as `GET /suspensions`. It leaves out the continuation context (the prompt).

Snapshots in storage stay complete. Forking and restoring read storage directly, so this filter does not affect them.

#### `POST /api/sessions/:id/fork`

Creates a new session from a snapshot.

**Request**

```json
{ "fromSnapshotId": "<snapshot-uuid>" }
```

| Field            | Type   | Required | Description                                         |
| ---------------- | ------ | -------- | --------------------------------------------------- |
| `fromSnapshotId` | string | Yes      | The source snapshot. It must belong to this session |

**Response**

Returns `201 Created`.

```json
{
  "sessionId": "mistport-<new-uuid8>",
  "parentSessionId": "mistport-a1b2c3d4",
  "fromSnapshotId": "<parent-snapshot-id>",
  "forkSnapshotId": "<child-fork-snapshot-id>"
}
```

**What the server does**

1. Creates a new `sessionId` (`{worldId}-{uuid8}`).
2. Restores the session settings from the snapshot.
3. Copies the data into the new session.
4. Copies the messages, the compressed summaries, and the chat history shown in the interface.
5. Writes a snapshot with `kind="fork"` in the child session. Its `parentId` points to the source snapshot, so the origin can be traced.
6. Sends `session.forked` (the SSE topic is `session`).

The details of each step follow.

**Step 2: Restore the session settings**

- Restores `locale`, `activePlugins`, `status`, `phase`, `completedPlayerTurns`, `setupRuntimes`, and `runtimeModelOverrides` from a v3 snapshot.
- If the snapshot has `loreOverride`, it is restored to the child session. After that, changes to the parent session or the world background do not affect this saved value. The child snapshot keeps it too, so you can fork again and again.
- If the snapshot has no `loreOverride`, the world background is used. The server does not guess the old value from the parent session's current settings.
- A snapshot with `status: 'ended'` is changed to `paused`. `ended` is a final state, and there is no interface for undoing an end. Forking exists so that you can keep playing.

**Step 3: Copy the data**

- What is copied: characters, state records, plugin data, the character schema, the state table structure, and suspended items that are not yet handled.
- The snapshot fixes the table structure with the required `stateSchemas`. An empty array means there were no tables at that time. A fork rebuilds the table IDs and writes the child session's table structure into the child snapshot. Later changes to the parent session do not affect forks made from the snapshot afterward.
- If any state record cannot find its matching table structure, the server returns `409 snapshot_schema_missing` and rolls back. It does not return a branch with incomplete state.
- Control namespaces for background jobs and logs (`_runtime_jobs`, `_runtime_job_control`, `_logs`, `_jobs`) are not copied into the child session or the child snapshot.
- Characters are isolated by `(sessionId, id)`. The copy keeps the character IDs, so references to characters in plugin data still work.
- Vectors and ingestion cursors are derived data, so they are not copied directly. After the commit, the child session's index is rebuilt in the background.

**Step 4: Copy the messages and summaries**

- Messages are copied in order from `turn_messages`, up to and including `payload.messagesCursor`. Messages after the cursor are not copied.
- Using `compactedMessageSummaryIds`, the server copies the compressed summaries from `payload.sessionSummaries` that the snapshot actually referred to. The child session rebuilds its summary IDs, and the `compactedAtTurnId` on each message is rewritten to match. So if the parent session later merges summaries or re-tags old messages, the result of forking this old snapshot does not change.
- These fields are required. The server does not read the parent session's current message tags to guess the history.
- If the message at the cursor no longer exists in the parent session (because it was compressed or deleted), the server returns `409 { code: 'cursor_missing' }`.

The chat history shown in the interface is copied separately, using `payload.displayMessagesBoundary`:

- The text, roles, metadata, and display order are kept, and the message IDs are rebuilt.
- The boundary records the timestamp of the latest message, plus the IDs of all messages that already existed at that same millisecond. This way, new messages with the same millisecond that were added after the snapshot are not mixed in.
- A boundary of `null` means there is no chat history. If a message ID in the boundary cannot be found, the server also returns `409 cursor_missing`.
- The child snapshot writes a new boundary, so you can fork again.

Media handling:

- Creates the child session's own references to the media in the copied messages.
- All media used in messages, state, and runtime exports must already be authorized for the parent session. Otherwise the whole fork fails with `403 media_reference_forbidden`. Knowing a media ID does not give you access to it.

Runtime export handling:

- The snapshot fixes, with the required `runtimeExports`, the latest version of each export and its value that each "producer plus name" could see at the time the snapshot was taken. An empty array means there are no exports.
- Forks, repeated forks, and checkpoint transfers all use this record. So commits made later in the same millisecond do not get mixed in.
- The time of an automatic snapshot is the time it was actually taken, after all proposals have been committed.

**Errors**

| Status | `code`                        | When                                                                                                |
| ------ | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | —                             | `fromSnapshotId` is missing                                                                         |
| 403    | `media_reference_forbidden`   | Media that is used has not been authorized for the parent session                                   |
| 404    | `session_not_found`           | The parent session does not exist                                                                   |
| 404    | `not_found`                   | The snapshot does not exist, or does not belong to this session                                     |
| 404    | `world_not_found`             | The world linked to the session no longer exists                                                    |
| 409    | `cursor_missing`              | The message that `messagesCursor` or the chat boundary points to is no longer in the parent session |
| 409    | `snapshot_schema_missing`     | A state record cannot find its matching table structure                                             |
| 409    | `dimension_provider_required` | The snapshot's dimension data belongs to a community plugin, and the child session cannot enable it |
| 409    | `world_deleting`              | The world linked to the session is being deleted                                                    |
| 429    | `rate_limit_exceeded`         | The fork rate limit was exceeded. Includes `Retry-After`                                            |
| 500    | `fork_media_reference_failed` | Writing a media reference failed                                                                    |
| 500    | `fork_failed`                 | The server cannot create a valid ID for the child session, so no child session is created           |
| 500    | —                             | Another internal write failure                                                                      |
| 503    | `session_busy`                | On a PostgreSQL deployment, waiting for the session lock timed out                                  |

Other rules:

- **Rate limit**: For the same parent session and the same client address, at most 10 fork requests are allowed per minute. The count happens before the request body is checked. This is the same at every deployment tier.
- **All or nothing**: A fork reads the source data while holding the parent session's execution lock, and it writes everything in one transaction. If any step fails partway through, everything is rolled back, and no half-built child session is left behind.
- **World check**: Before the commit, the server checks that the linked world still exists and is not being deleted. A session with no linked world can still be forked.

### Character Data

> [!NOTE]
> The built-in Web UI gets the character view mainly through `GET /api/sessions/:id/view`. The endpoints in this section are lightweight read and management endpoints.
>
> In a plugin, write characters with tools. For a runtime that tracks characters in batches, `sync-characters` is recommended. Other plugins can use `create-character` / `update-character` as needed, and read with `list-characters` / `get-character`.

#### `GET /api/sessions/:id/characters`

Returns all characters in the session. Characters are created and changed during play.

**Request**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | path     | Session ID  |

**Response**

```json
{
  "items": [
    {
      "id": "char-001",
      "sessionId": "mistport-a1b2c3d4",
      "name": "艾尔文",
      "type": "player",
      "description": "一名孤儿出身的流浪剑客",
      "fields": { "class": "战士", "level": 3 },
      "version": 2,
      "createdAt": "2025-01-15T10:00:00.000Z",
      "updatedAt": "2025-01-15T10:10:00.000Z"
    }
  ]
}
```

If a character has aliases, each item also includes `aliases`.

#### `POST /api/sessions/:id/characters`

Creates or updates a character. If `id` already exists, the character is updated. If not, it is created.

This admin endpoint internally commits a `character.upsert` proposal. So it uses the same commit flow as a plugin writing a character, and the related hooks run as usual. The session must be in the `active` state.

**Request**

| Parameter | Location | Description |
| --------- | -------- | ----------- |
| `id`      | path     | Session ID  |

```json
{
  "id": "char-001",
  "name": "艾尔文",
  "type": "player",
  "description": "一名孤儿出身的流浪剑客",
  "fields": { "class": "战士", "level": 3 },
  "version": 2
}
```

| Field         | Type   | Required | Description                                                                 |
| ------------- | ------ | -------- | --------------------------------------------------------------------------- |
| `id`          | string | Yes      | Character ID. Up to 160 characters                                          |
| `name`        | string | Yes      | Character name. Up to 256 characters                                        |
| `aliases`     | array  | No       | The full list of aliases (up to 32). Replaces any existing aliases on write |
| `type`        | string | No       | Character type (for example `player` or `npc`). If omitted, it is `npc`     |
| `description` | string | No       | Character description. Up to 65536 characters                               |
| `fields`      | object | No       | Custom attributes (JSON)                                                    |
| `version`     | number | No       | Version number. If omitted, it is `1`                                       |
| `createdAt`   | string | No       | Creation time. If omitted, the current time is used                         |

About aliases:

- If an alias is the same as another character's name or alias, the server returns `400`. See [Aliases and lookup by name](./world-model.md#aliases-and-name-resolution).
- If a character has aliases, `aliases` appears on each character in `GET`, on `characters[]` in the session view, and in the `character.upserted` event.

**Response**

```json
{
  "id": "char-001",
  "sessionId": "mistport-a1b2c3d4",
  "name": "艾尔文",
  "type": "player",
  "description": "一名孤儿出身的流浪剑客",
  "fields": { "class": "战士", "level": 3 },
  "version": 2,
  "createdAt": "2025-01-15T10:00:00.000Z",
  "updatedAt": "2025-01-15T10:10:00.000Z"
}
```

**Errors**

| Status | `code`               | When                                                                                                     |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------- |
| 400    | —                    | The request body is not valid, or the character proposal was rejected (`error` gives the reason)         |
| 409    | `session_not_active` | The session is not in the `active` state                                                                 |
| 500    | —                    | An unexpected storage failure. The cause is written to the log, and the response has no internal details |

The aggregated state view of a session follows the same principle. If a required character or plugin data query fails, it returns `500`. It never returns a view that looks successful but is incomplete.

### Event System

Inside the server, events are passed through an event bus (EventBus). This section has two endpoints. One pushes events to the client in real time with SSE (Server-Sent Events). The other injects events into the bus from outside.

#### `GET /api/events/stream?sessionId=xxx`

Subscribes to a session's live event stream. This is a long-lived SSE connection. You can filter it by topic, and after a disconnect it can resend events from where it left off.

**Request**

| Parameter     | Type   | Required | Description                                                                                   |
| ------------- | ------ | -------- | --------------------------------------------------------------------------------------------- |
| `sessionId`   | string | Yes      | Session ID                                                                                    |
| `topics`      | string | No       | A comma-separated topic filter (for example `runtime,state`). If omitted, all topics are sent |
| `lastEventId` | string | No       | Resend the events after this ID. Used to reconnect after a disconnect                         |

Reconnects also accept the standard `Last-Event-ID` request header. The `lastEventId` query parameter takes precedence when both are present. See the [subscription protocol](./protocol.md) for cursor format and reset behavior.

```bash
curl -N "http://localhost:3001/api/events/stream?sessionId=<sessionId>"
```

**Response**

The first message you receive after the connection succeeds:

```
event: system.connected
data: {"sessionId":"mistport-a1b2c3d4","topics":"all","cursor":"...","timestamp":"2025-01-15T10:00:00.000Z"}
```

After that, events follow. The `event:` line is the event type (`CovelEventType`) itself. The server does not rewrite it. For the full list, see [protocol.md](./protocol.md).

```
event: execution.completed
data: {"runtimeCount":4,"resultCount":4,"durationMs":2500}
id: example-epoch:1

event: state.changed
data: {"table":"character_stats","field":"hp","value":85}
id: example-epoch:2
```

Usage notes:

- Use `curl -N` (which turns off buffering) to see the output in real time.
- The connection stays open until the client disconnects.
- The server sends a heartbeat (`system.heartbeat`) every 30 seconds.
- You only receive events whose `sessionId` matches.

**Errors**

| Status | `code`                             | When                                                               |
| ------ | ---------------------------------- | ------------------------------------------------------------------ |
| 400    | —                                  | `sessionId` is missing (`sessionId required`)                      |
| 400    | —                                  | `topics` contains an unknown topic (`Invalid topics: ...`)         |
| 404    | —                                  | The session does not exist                                         |
| 429    | `connection_limit_exceeded`        | This session has too many concurrent connections                   |
| 429    | `global_connection_limit_exceeded` | The event stream has too many connections across the whole service |

```json
{
  "error": "sessionId required"
}
```

This endpoint also limits how often a client address can make requests (`RATE_LIMIT_RPM`, which is 60 per minute by default).

#### `POST /api/events/emit`

Injects an event into the event bus from outside. You can use it to trigger a runtime or to simulate a game event.

> [!IMPORTANT]
> This endpoint is for debugging. When `NODE_ENV=production`, it is only available if `ENABLE_DEBUG_PAGE` is set. Otherwise it returns `403`.

**Request**

```json
{
  "topic": "combat.start",
  "payload": { "enemyId": "goblin-01", "terrain": "forest" },
  "sessionId": "mistport-a1b2c3d4",
  "targetRuntime": "combat"
}
```

| Field           | Type   | Required | Description                               |
| --------------- | ------ | -------- | ----------------------------------------- |
| `topic`         | string | Yes      | Event topic                               |
| `payload`       | object | No       | Event payload. It must be an object       |
| `sessionId`     | string | Yes      | Target session ID                         |
| `targetRuntime` | string | No       | The runtime that should receive the event |

**Response**

```json
{
  "ok": true,
  "id": "evt-a1b2c3d4"
}
```

**Errors**

| Status | `code`               | When                                                                                 |
| ------ | -------------------- | ------------------------------------------------------------------------------------ |
| 400    | —                    | `topic` or `sessionId` is missing, or `payload` is not an object                     |
| 403    | —                    | Debugging is not enabled in production (`Event injection is disabled in production`) |
| 404    | `session_not_found`  | The session does not exist                                                           |
| 409    | `session_not_active` | The session is not in the `active` state                                             |

### Actions (SSE Bridge)

#### `POST /api/actions`

Every game action from the player comes in through here: sending a message, running a command, answering an interaction, starting a session, and retrying. The server turns each action into one turn run, and it sends the results back over SSE, one piece at a time. The built-in front end mainly uses this endpoint.

**Request**

```json
{
  "requestId": "req-001",
  "type": "send_message",
  "sessionId": "mistport-a1b2c3d4",
  "payload": {
    "content": "我拔出剑，准备迎战"
  }
}
```

Top-level fields:

| Field       | Type   | Required | Description                                                 |
| ----------- | ------ | -------- | ----------------------------------------------------------- |
| `requestId` | string | Yes      | Request correlation ID. It appears unchanged in every event |
| `type`      | string | Yes      | The action type. See below                                  |
| `sessionId` | string | Yes      | Session ID                                                  |
| `model`     | string | No       | A model override for this request                           |
| `payload`   | object | Yes      | The content that matches `type`                             |

Validation rules:

- Only the five fields above are accepted at the top level. The `payload` of each action also rejects any field that is not declared.
- Seven `type` values are supported: `send_message`, `execute_command`, `submit_interaction`, `start_session`, `retry_turn`, `retry_runtime`, and `retry_failed_runtimes`. Any `type` not on this list returns `400`.
- All seven request types must include a `payload` that matches the `type`, even when it is an empty object.
- A request cannot include `locale`. Turns always use the content language that was set when the session was created (`session.locale`). A request with `locale` is rejected.
- `requestId`, `sessionId`, and the runtime and turn IDs must be safe identifiers with a limited length.
- An invalid request returns `400` before a turn is created or a message is written.

`payload` for each `type`:

| `payload` field         | Applies to `type`       | Required | Description                                                                            |
| ----------------------- | ----------------------- | -------- | -------------------------------------------------------------------------------------- |
| `content`               | `send_message`          | Yes      | The player's natural-language input                                                    |
| `command`               | `execute_command`       | Yes      | A command that starts with `/` (for example `/look`)                                   |
| `turnId`, `submissions` | `submit_interaction`    | Yes      | Answers an interaction raised by a turn. See [Player interaction](#player-interaction) |
| `loreOverride`          | `start_session`         | No       | Text that overrides the world background. Up to 500000 characters                      |
| —                       | `retry_turn`            | —        | `payload` is an empty object                                                           |
| `runtimeId`             | `retry_runtime`         | Yes      | Runs only this one runtime again                                                       |
| `retryFromTurnId`       | `retry_runtime`         | No       | Says which turn the failure to fix comes from                                          |
| `runtimeIds`            | `retry_failed_runtimes` | Yes      | 1–20 unique, enabled runtime IDs                                                       |
| `retryFromTurnId`       | `retry_failed_runtimes` | Yes      | The committed original turn where these runtimes failed                                |

> [!NOTE]
> The player's input has exactly two field names: `send_message` uses `payload.content`, and `execute_command` uses `payload.command`. There are no aliases. To send an event from a plugin, use the built-in `emit-event` tool.

Extra notes for each type:

- **`loreOverride` in `start_session`**: The server saves it in the session. The setup, the opening continuation, and later turns all use this `world.lore` first. An empty string means the background was deliberately cleared. If it is left out, the value already saved in the session is kept. The web session-prep screen passes the background when it creates the session, so "Begin Adventure" no longer sends the world draft.
- **`retry_turn`**: Starts a new main-loop turn with empty player input, using the context that is already committed. After the commit succeeds, the player's turn count goes up by one. It does not restore or regenerate past turns.
- **`retry_runtime`**: Runs only the named runtime again, as a manual trigger. It does not advance the player's turn count.
  - With `retryFromTurnId`: That turn must be a committed original turn in the current story, and the target runtime must still be failing. If the turn does not exist, the request is rejected right away. The server does not switch to a different turn.
  - Without it: The request is handled as an ordinary manual call. It uses the result of the most recent committed player turn, if there is one.
- **`retry_failed_runtimes`**: The server sorts `runtimeIds`, and reruns them in one execution, in stage and dependency order.
  - Inside the session lock, the server checks that every chosen target is still failing (committed retry results count).
  - If a committed player turn or a committed opening continuation turn exists after the original turn, the server rejects that old turn.

##### Limits of a batch recovery

`retry_failed_runtimes` is one action, one session lock, and one transaction commit. It:

- Does not add player input, does not advance the player's turn count, and does not trigger an opening continuation.
- Uses only the **successful, non-target** results from the original turn and related committed retries as context. These results are not committed again, and their events are not sent again.
- Keeps normal input validation, dependency order, and parallel running of independent tasks across the targets.
- Does not mark tasks that were skipped because a dependency failed as "fixed".
- Runs in the foreground. Neither a batch recovery nor a single-task recovery with a clear source turn expands its scope through event subscriptions, recursive calls, or background dispatch.

A single-task retry with a source turn also checks the source and the latest failure status. An ordinary manual call without a source turn, and a plugin RPC call, keep their existing event chain, recursion, and dispatch behavior.

##### Retry events and state

- The traces and SSE events from a retry carry `sourceTurnId` (the original turn) and `runtimeIds` (the scope of this run) in their payload. The `turnId` in the envelope is the ID of this new attempt.
- The audit record of the original turn is not changed.
- A task counts as recovered only if this attempt was **committed**. A committed attempt is shown by `turn.completed` / `execution.completed` with `committed: true`, or by a committed result.
- After a rollback or an interruption, a single `runtime.completed` event is not enough to conclude that a runtime was recovered.
- The refresh endpoint can only read status. It cannot regenerate anything.

After the server confirms that the source turn was committed, the scope information in the event also includes two more fields:

| Field                    | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `sourceCommitted`        | Always `true`. It shows that the source turn was committed |
| `sourceFailedRuntimeIds` | All runtime IDs in the source turn that are still failing  |

Rules for `sourceFailedRuntimeIds`:

- It is the complete list. It includes runtimes that have been disabled, and it is not limited to "at most 20 chosen at a time".
- Events during execution carry the full set of failures from before the run started.
- In the final event after a successful commit, the tasks that succeeded this time are removed. Failed tasks and tasks skipped because of a dependency stay in the list.
- After a rollback or an interruption, the list is left as it was.
- Even when the list is empty, an empty array is sent explicitly.

How a client should use it:

- Replace the old list with the newest one. Within the same attempt, a committed final state takes priority over events from during execution.
- This way, even if the logs or earlier task events of the original turn have been trimmed out of the trace window, the client still knows the source turn was committed and which failures remain.
- If an ID is not in the list, it only means that the ID is no longer in the failure set. Do not use that to show a success step that did not happen.

##### Community plugin approval

If a community plugin in the session has not been approved yet, the server returns HTTP `202` and a JSON body **before** it starts SSE or writes the turn:

```json
{ "status": "approval-required", "approvalId": "...", "pending": { ... } }
```

- The client approves the current session through the approval endpoint, and then resends the original request with the **same `requestId`**.
- You may be asked several times in a row: first `covel:plugin-server-code`, then each `runtime:<name>`.
- The scope that an ordinary action checks: the runtimes in the selected plugins that take part in automatic runs (after resolving the contract dependencies). An explicit retry checks only the selected targets.
- An ordinary call to a manual runtime still goes through the plugin RPC approval.
- If approval is refused, the turn is not run.
- The `demo` and `commercial` deployment tiers also require the operator token. Before the code is actually loaded during execution, the approval is checked once more.
- The web client supports approving several requests in a row. It rejects duplicate approval responses and responses that belong to another session.

##### Preconditions for `start_session`

The session must already have a non-empty `activePlugins`. Otherwise the server returns `400` (`Session has no active plugins. …`).

- The set of plugins is decided by the `plugins` array when the session is created. `start_session` only enables that saved set.
- An empty set does not turn into "enable every loaded plugin". That would pull community plugins the player never chose, and conflicting narrative engines, into the session, and keep them there until the session ends.
- The web session-prep screen first reads `GET /api/worlds/:id/plugin-plan` to get the default set the server calculated. Then it sends the player's final choices to the create endpoint.
- The `plugin-plan.defaultPluginIds` is calculated the same way as for the session: `requires`, `conflicts`, and the rule that replaces a core plugin with a trusted built-in core plugin. The session-prep screen shows this result, and it does not lock again a core plugin that has already been replaced.
- The endpoint that creates a session no longer reads the world's plugin policy. It only adds the built-in core plugins and the `requires` relationships, and it handles `conflicts`.

##### Opening continuation

After the player submits the opening form, the opening narrative appears on its own. The player does not need to send another message.

- **When it happens**: One player action (`send_message` / `execute_command` / `submit_interaction` / `start_session`) completes the **last** setup runtime. The setup run is committed separately, and `phase` switches to `playing`.
- **What happens**: In the same request, on the same SSE stream, the server automatically runs one main-loop turn. This turn has a new `turnId` and its own transaction. It reads the setup state that was just committed, and lets the narrative runtime write the opening.
- **Counting**: The continuation turn runs with `origin: continuation`. It does not increase `completedPlayerTurns`.
- **Events**: The whole stream still sends only **one** `execution.completed`, and it uses the data from the continuation turn.
- **Cases with no continuation**:
  - The action is `retry_turn` / `retry_runtime` / `retry_failed_runtimes`;
  - The execution was aborted (`abortReason`);
  - The commit failed;
  - Setup still has unfinished items (an opening interaction comes next).

##### Request headers (optional)

| Header                   | Description                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `X-Provider-Keys`        | Model provider keys as base64(JSON). They are not stored, and they must be sent with every request |
| `X-Plugin-User-Settings` | The player's plugin settings as base64(JSON): `{ [pluginId]: { [settingKey]: value } }`            |

How `X-Plugin-User-Settings` is handled:

- Send only the values the player explicitly changed.
- The server merges it with the world's default settings (`WorldRecord.metadata.pluginSettings`). The player's values take priority.
- Any key that is still missing is filled in with the default from the plugin manifest.
- The result goes into this turn. So plugin settings the player changed take effect in the main turn loop.

##### Response

The response is an SSE event stream. It uses frames that have **only `data:` lines** (there is no `event:` line). Each `data:` line is an `SseEnvelope` object, not a `ProtocolEvent`:

```ts
interface SseEnvelope {
  type: string; // event subtype; see "SSE protocol" below
  requestId: string; // request correlation ID (from the request body)
  traceId: string; // trace ID of this turn
  sessionId: string;
  turnId?: string; // during an opening continuation, the same stream shows two turnIds in turn (the setup turn, then the continuation turn)
  flowId: string; // same as traceId
  seq: number; // increments within this stream
  timestamp: string;
  payload: Record<string, unknown>;
}
```

> [!IMPORTANT]
> A client must read this stream with `fetch()` + `ReadableStream` (see `sendAction` in `apps/web/src/services/api/actions.ts` for reference). You cannot use `EventSource.addEventListener('<type>', …)`, because the frames have no event name. The stream that carries event names is `/api/events/stream`.

### AI Generation

#### `POST /api/ai/ping`

Tests whether a model works, using one minimal request. It returns the provider, model, and latency that were actually used.

**Request**

The request body can choose only one target:

| Request body                        | What it tests                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `{ "presetId": "server-preset" }`   | A model preset on the server                                            |
| `{ "modelRef": "local-model-ref" }` | A local reference. It must be declared in `X-Slot-Config.customPresets` |
| `{ "slot": "story" }`               | The model that a model role (slot) currently resolves to                |
| `{}`                                | The default model role                                                  |

Rules:

- Role overrides go in `X-Slot-Config.slotBindings`. They keep their `modelRef` / `presetId` type.
- If the model you named does not exist, the response is `ok: false`. The server does not test a different model instead. The `slot-` in a model ID has no special meaning as an alias.
- If you do not name a target, the default model role is tested. If that role is not configured, the server is allowed to fall back.
- After resolution, only the one selected model is tested. Even if a fallback model is configured, a failure of the selected model returns `ok: false`. A fallback model's success never stands in for it.
- When a role is tested, the role's own parameters and capability overrides are kept. If a role's name is the same as another preset's ID, the model that this role resolves to is still called.
- The model catalog endpoint does not expose model settings that other requests registered temporarily. The connection test also does not quietly pick a target from those settings.

How each kind is tested:

- Text model: sends one streaming request and measures the time to first token (`ttfbMs`).
- Evaluation model: sends one evaluation request. There is no `ttfbMs`.
- Embedding model: sends one vector request. There is no `ttfbMs`.
- Each test sends only one HTTP request, with no transport-level retry.

**Response**

```json
{
  "ok": true,
  "latencyMs": 250,
  "ttfbMs": 180,
  "text": "Hello!",
  "testedTarget": {
    "presetId": "server-preset",
    "provider": "example-provider",
    "model": "example-model",
    "resolvedVia": "direct"
  }
}
```

`resolvedVia` is one of `direct`, `slot`, `tag-fallback`, or `any`.

On failure, the response returns `errorKind` as well as `error`. For the values, see [Connection tests and failure causes](./slots.md#connection-tests-and-failure-reasons):

```json
{
  "ok": false,
  "latencyMs": 12,
  "error": "connect ECONNREFUSED 127.0.0.1:11434",
  "errorKind": "unreachable",
  "testedTarget": { "presetId": "…", "provider": "ollama", "model": "…" }
}
```

**Errors**

| Status | `code`                      | When                                                                                                |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------- |
| 400    | `invalid_llm_configuration` | The routing header (`X-Slot-Config`) is not valid                                                   |
| 400    | —                           | The JSON is invalid, has unknown fields, or gives more than one target that cannot be used together |

If the request body or the routing check fails, no request is sent to the model provider.

#### `POST /api/ai/models`

Reads the list of model IDs from a provider endpoint. The settings page uses it so the player can tick models when adding a provider or a model.

**Request**

```json
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434/v1",
  "protocol": "openai-chat-v1"
}
```

| Field      | Type   | Required | Description                                                                            |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------------- |
| `provider` | string | Yes      | Provider ID                                                                            |
| `baseUrl`  | string | No       | Endpoint address. If omitted, the value of the built-in or registered provider is used |
| `protocol` | string | No       | Protocol. If omitted, the same rule applies                                            |

- The key comes from the `X-Provider-Keys` request header.
- The target is handled for this one request only. A key from the server's environment is sent only to that provider's trusted same-origin address.
- Unknown fields and unknown protocols return `400`.

**Response**

```json
{
  "ok": true,
  "models": ["codex/gpt-6-luna", "qwen3:8b"],
  "baseUrl": "http://localhost:11434/v1",
  "protocol": "openai-chat-v1"
}
```

- If the read fails, the status code is still `200`: `{ "ok": false, "models": [], "error": "…", "errorKind": "auth" }`.
- The evaluation protocol has no model list, so it returns `errorKind: "config"`.
- The request times out after 15 seconds. It returns at most 2000 IDs.

#### `GET /api/ai/protocols`

Returns all the protocols a model can be configured with. The protocol dropdown in the settings page uses it.

The built-in protocols come first. After them come the text protocols that loaded plugins registered with `covel.registerWires({ text })`. Their `id` is `<pluginId>/<wireId>`.

**Response**

```json
{
  "protocols": [
    { "id": "openai-chat-v1", "label": "OpenAI Chat", "output": "text" },
    { "id": "acme/converse", "label": "Acme Converse", "output": "text" }
  ]
}
```

#### `POST /api/ai/generate-world`

Has the model generate a world package. From a concept and an optional creative brief, the model decides the `id`, `name`, `tags`, `dimensions`, and `lore`. It can also write the main characters, lorebook, world rules, genre memory, and opening kit at the same time.

The response is SSE. First come progress frames, and the generated world comes last. The client reads the `data: {...}\n\n` frames with `fetch()` + `ReadableStream`.

**Request**

```json
{
  "concept": "一个被永恒暴风雪笼罩的冰封大陆",
  "locale": "zh-CN",
  "model": "deepseek-v4-flash",
  "saveTarget": "server-file",
  "idleTimeoutMs": 300000,
  "brief": {
    "experienceMode": "traditional-story",
    "content": ["characters", "lorebook", "rules", "opening-kit"],
    "contracts": ["memory.blocks@1"],
    "additionalInstructions": "让三个主要角色共同隐瞒一次失败的远征。"
  }
}
```

| Field           | Type   | Required | Description                                                                                                                            |
| --------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `concept`       | string | Yes      | A description of the world concept (up to 4000 characters). The synonym key `prompt` is also accepted                                  |
| `locale`        | string | No       | The locale. The default is `zh-CN`                                                                                                     |
| `model`         | string | No       | Overrides the LLM model                                                                                                                |
| `saveTarget`    | string | No       | Where to save. The default is `server-file`. The allowed values are in the table below                                                 |
| `brief`         | object | No       | A structured creative brief. If omitted, only basic generation is done                                                                 |
| `idleTimeoutMs` | number | No       | The longest time to wait for the model's next piece of output, in milliseconds. An integer from 1000 to 1800000. The default is 120000 |

If `idleTimeoutMs` is out of range, the server returns `400`. The app's own setting starts at 15 seconds. The endpoint accepts values as low as 1 second so that the timeout path can be tested.

Fields of `brief`:

| Field                    | Type     | Description                                                                                                                            |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `experienceMode`         | string   | `traditional-story` or `dialogue-mode`. The latter also generates `defaultViewMode: stage`                                             |
| `content`                | string[] | Kernel content. Allowed values: `characters`, `lorebook`, `rules`, `opening-kit`                                                       |
| `contracts`              | string[] | Plugin content. Contains data contract IDs                                                                                             |
| `additionalInstructions` | string   | Extra requirements for the world package (up to 2000 characters), such as character relationships, taboos, pacing, or content to avoid |

The allowed values for `contracts` come from the contracts marked with `generate` in `GET /api/framework/authoring`. Any other value returns `400`. Contracts that fail preparation are absent from the choices; generation and revision continue with the remaining content, and `done.warnings` identifies the skipped plugin, namespace, and contract.

Values for `saveTarget`:

| `saveTarget`   | Where it is saved                                       | What makes it durable          | When to use it                                                                                                                     |
| -------------- | ------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `server-file`  | A world package in the server's `COVEL_USER_WORLDS_DIR` | The server's file system       | Electron, local development, a trusted private server                                                                              |
| `server-store` | The server's `DataStore.upsertWorld()`                  | `STORE_BACKEND=sqlite` or `pg` | A self-hosted web server that wants to reuse the server database and avoid keeping world package files long term                   |
| `return-only`  | The SSE response body                                   | The caller saves it            | Browser-local IndexedDB, previewing a generated result, or a public service that should not write to the server's persistent layer |

- The `server-file` directory is chosen in this order: `COVEL_USER_WORLDS_DIR`, `$COVEL_HOME/worlds`, `~/.covel/worlds`. This matches the world package install entry point. `COVEL_WORLDS_DIR` is used only for built-in world packages.
- `server-store` and `return-only` assemble the record from the structured result validated by the generator; they do not write package files.
- For these two modes, the saved `WorldRecord.metadata` is handled as follows:
  - It removes the file-path fields `worldDataPath`, `worldData`, and `dimensionSources`.
  - It keeps the normalized `metadata.dimensions`.
  - It carries the validated character, lorebook, and rule text in `metadata.embeddedCharacters` and `metadata.embeddedLorebook`.
- When a session is created, a file-based world reads the data sources in the world package first. If there is no world package directory, it uses the content carried with the record. This way, a world saved in the database or in the browser does not lose its supplementary content.

**Who can call it**

- `demo` / `commercial` deployment tiers: every AI world generation request requires the operator token.
- `self` deployment, when production actually uses MemoryStore: `server-file` (including the default when `saveTarget` is left out) and `server-store` require the operator token before generation and writing. `return-only` stays public, because it does not change the world that the server shares.

##### How generation works

A new world is generated **part by part**. Each part is one model request. The order is:

1. The world manifest (`manifest`)
2. `WORLD.md` (`lore`)
3. Each kind of supplementary content that the brief asks for (`characters`, `lorebook`, `rules`)
4. Each plugin data contract (`contract:<contract ID>`)

Later parts receive the parts that were already written before them as context.

The server writes the text content as a world package with the expected path layout:

- `WORLD.md`
- `data/dimensions.yaml`
- `characters/characters.json`
- `data/lorebook.yaml`
- The file for each plugin data contract, placed at the path declared by the plugin that receives it (for example `data/memory-blocks.json`)

When every file is at its expected path, the world package does not need an extra data source description. For details, see [World Data](./world-data.md).

Language and characters:

- The new world's `defaultLocale` and its only `supportedLocales` entry are fixed to the normalized request `locale` (default `zh-CN`). Every save target and file export uses this one declaration.
- The character part validates the whole set against the character schema in the generated manifest: the declared types, the field constraints, and only one `player`. If validation fails, the retry and discard rules below apply.

##### Validation and retries

Each part gets a deterministic structure check as soon as it arrives. If a part is not valid, only that part is requested again (up to 3 times). Parts that already passed are not rewritten.

If `WORLD.md` clearly contains traces of the generation process (such as test text, prompts, or model output), the server first sends one targeted repair request for the lore only. If the lore is still not valid after the repair, the lore is requested again.

- If the `manifest` or `lore` fails three times, the whole generation fails.
- If supplementary content or contract data fails three times, the world is still created, but without that part. The `warnings` on the `done` frame say what is missing. You can add it later with `revise-world`.
- Nothing half-finished is written before validation is complete.

##### Waiting time

Model requests are limited by **idle time**, not by total duration:

- Each time the model outputs a piece of text or reasoning, the timer starts again. So a model that is slow but keeps producing output can write a very long piece of content.
- It only counts as a timeout when there is no output for `idleTimeoutMs` in a row.
- An adapter that does not support streaming returns the whole answer at once. In that case, the idle time equals the duration of the whole request.
- A single request also has a 30-minute total limit. This limit exists only to end a model that never stops producing output.

An idle timeout is **not retried**. This time is the longest the player is willing to wait. A retry would only make the player wait several times longer before finding out that the model is not responding.

- If the `manifest` or `lore` times out, generation fails right away.
- If a supplementary part times out, that part and all parts after it are no longer requested. The world is created with the parts already written, and `warnings` lists each missing part.

So when a model does not respond, you get a result after at most one `idleTimeoutMs`.

##### Response frames

**Response 200:** SSE frames.

```text
data: {"type":"progress","phase":"generating"}

data: {"type":"progress","phase":"generating","parts":[{"id":"manifest","state":"pending"},{"id":"lore","state":"pending"},{"id":"characters","state":"pending"}]}

data: {"type":"progress","phase":"generating","parts":[{"id":"manifest","state":"done","attempt":1,"chars":1840},{"id":"lore","state":"active","attempt":1,"chars":412},{"id":"characters","state":"pending"}]}

data: {"type":"progress","phase":"validating"}

data: {"type":"progress","phase":"saving"}

data: {"type":"done","world":{"id":"frost-continent","name":"冰封大陆","metadata":{"storage":{"scope":"server","backend":"file","durable":true}}}}
```

A `progress` frame with `phase: "generating"` includes `parts`. This lists all the parts in this generation and the progress of each one. Each frame is the full list, so the client can render straight from the newest frame. A frame is sent when a part starts, when new content arrives (at most one frame every 400 milliseconds), when a retry starts, and when a part ends.

| `parts[]` field | Type   | Description                                                                                                         |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `id`            | string | `manifest`, `lore`, `characters`, `lorebook`, `rules`, `contract:<contract ID>`. During a revision it is `revision` |
| `title`         | string | The name of a plugin data contract. Other parts do not have this field, and the client names them itself            |
| `state`         | string | `pending`, `active`, `done`, or `failed`                                                                            |
| `attempt`       | number | Which request this is for the part, starting from 1                                                                 |
| `chars`         | number | The number of text characters received so far in the current request                                                |

The `world.metadata.storage` in a `done` frame shows where the world is actually saved:

```json
{
  "scope": "server",
  "backend": "pg",
  "durable": true
}
```

A `done` frame can include `warnings` (an array of strings) that explain how the result differs from the creative brief. In that case the world itself is valid and can be played:

```text
data: {"type":"done","world":{...},"warnings":["generated 3 lorebook entries; the brief asks for 4","dropped dimension \"discoveries\": schema.properties.visited: Unrecognized key: \"boolean\""]}
```

- If a type of content has fewer items than its target (characters 3, lorebook 4, rules 3, opening kit 2), the result is accepted and a warning is given. Generation fails and is retried only when none of the requested content was produced at all.
- A dimension that cannot pass validation is dropped on its own, with a warning. The other dimensions are kept.
- If a supplementary part could not be generated, the warning is `<part> could not be generated: <reason>`, and that part is not in the world. Parts that were not requested because the model stopped answering get the warning `<part> was not requested: the model stopped answering`.
- If there are no warnings, this field is left out.

A `done` frame also includes `usage: { inputTokens, outputTokens, requests }`:

- It is the sum of the tokens from every model response in this generation. This includes re-requested parts, responses that were cut off and not used, and the lore repair.
- `requests` is the number of responses that were counted.
- When generation fails, the `error` frame has the same fields.
- If the model did not report usage, this field is left out.
- The server log records all three numbers as well. `revise-world` works the same way.

##### Errors

If the request body is not valid, the server returns HTTP `400` with the standard error envelope before it starts the streamed response.

**Response 400:** `{ "error": "concept (string) is required" }`, `{ "error": "saveTarget must be \"server-file\", \"server-store\", or \"return-only\"" }`, or `{ "error": "idleTimeoutMs must be an integer from 1000 to 1800000" }`

A failure after generation has started (in the model, validation, or writing) is returned as an SSE frame with HTTP `200`:

```text
data: {"type":"error","message":"..."}
```

- If the last request failed because the model gave no output within `idleTimeoutMs`, the frame includes `"code":"model_idle_timeout"`. The client uses this to tell the user to increase the waiting time.
- If content validation fails, or the model gives no output or incomplete output, the frame explains the reason.
- For an unknown model request error, only the details are written to the server log. The frame suggests checking the model configuration or the log. In production, other unknown errors return `Internal server error`.
- For a revision conflict, the "please reload" prompt is kept. If publishing and restoring both fail, the error keeps the full backup path so an operator with permission can recover.

##### How the web front end chooses a save target

Before each generation, the web front end waits for `/api/health` to succeed. Then it chooses the save target based on `storage.data.frontendMode`:

| `frontendMode`  | `saveTarget`   | What happens next                                           |
| --------------- | -------------- | ----------------------------------------------------------- |
| `local`         | `return-only`  | The client stores the world in the user's browser           |
| `remote`        | `server-store` | The server saves it through the backend in `packages/store` |
| Not in response | `server-file`  | The server writes the world package file                    |

- In `local` mode, the client uses `LocalDataService.saveGeneratedWorld()`. Inside the world lock, it confirms that the ID is still free, then saves. It also sets `world.metadata.storage` to `{ "scope": "browser", "backend": "indexeddb", "durable": true }`.
- If the health check fails or has not finished, no model call is made. After a failure, the creative brief is kept so you can try again. If you cancel while waiting, no generation starts.
- If a generated world in the browser has the same ID as an existing local world (including a world that another window created during generation), the save fails and the original world is kept. To change an existing world, you must use the revision path that carries a request baseline.

#### `POST /api/ai/revise-world`

Changes a world that was **created by the generator** based on one sentence from the player, such as "make it three factions" or "add a rival".

The model gets the world's full current content and the request. It returns the result in the three-part format used by `generate-world`, but it writes only the parts it changes. The server merges what it wrote into the current world:

- A part that is not changed is written as `UNCHANGED`, and the whole part is kept as it was.
- In `WORLD_YAML`, only the changed fields are written. `dimensions` are merged by dimension ID (writing `null` deletes that dimension).
- In `WORLD_PACKAGE_YAML`, only new or changed entries are written. They are merged into their list by `id` (`contractData` is merged by `contract` + `key`). To delete an entry, write `{ id, remove: true }`.

So "add a character" does not change the other characters, and it does not drop the setting entries the model did not write again. After the merge, the result goes through the same validation as a newly generated world, and the world's `id` does not change.

- The character validation covers the full set after the merge, including characters that were not changed. If the whole package is not valid, the request is retried. If it is still not valid at the end, the request fails. The server does not make a revision succeed by dropping existing characters.
- The normalization that makes a new world declare "only one language" does not apply to revisions.

**Request**

```json
{
  "worldId": "frozen-continent",
  "instruction": "加一个与主角争夺同一目标的对手"
}
```

| Field           | Type   | Required | Description                                                                                                                                |
| --------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `worldId`       | string | Yes      | The world to change                                                                                                                        |
| `instruction`   | string | Yes      | The change request (up to 2000 characters)                                                                                                 |
| `world`         | object | No       | A world saved in the browser. Send its `WorldRecord` with the request                                                                      |
| `model`         | string | No       | Overrides the LLM model                                                                                                                    |
| `idleTimeoutMs` | number | No       | The longest time to wait for the model's next piece of output, in milliseconds. The meaning and range are the same as for `generate-world` |

About `world`:

- When `world` is included, the result is always only returned and never written to the server. The server ignores any mirror or catalog record it has with the same ID.
- Text that is written separately for each language is read using the world's content language.
- If `world` is not valid, the server returns `400`. It does not switch to the server's world with the same ID.

**Which worlds can be changed**

Only a world with the generated mark can be changed: `metadata.generated === true`.

- A world package written by the generator contains a file named `.covel-generated.json`. The world record carries this mark based on that file. The file lists every file the app wrote into the package, with a hash of its content.
- A hand-written or installed world package does not have this file. Such a package may contain portraits, extra data sources, and language files. Rewriting the whole package would lose them.
- When someone has added a file to a generated package by hand, or edited a file the app wrote, the request returns `409 world_package_modified` and the package stays as it is. `details.added` holds the added files, and `details.changed` holds the edited files. The check runs once before the model is called and once more before the package is replaced.
- Language files that the app itself translated are added to this list, so a translated world can still be changed. Deleting a listed file does not count as a change. `.DS_Store`, `Thumbs.db`, and `desktop.ini` are not compared.
- When the marker file has no file list (a package written by an older version), the world does not count as generated, and the request returns `409 world_not_revisable`.

**Where the result is written**

The result is written back to where the world is:

| Where the world is      | How it is written back                                                          |
| ----------------------- | ------------------------------------------------------------------------------- |
| A world package on disk | The whole package is replaced                                                   |
| `server-store`          | The world record is updated                                                     |
| The browser             | Only the result is returned. The client saves it, and the server writes nothing |

Protection when a whole package is replaced:

- The old package is kept until the new package is in place.
- If publishing fails, the old directory is restored.
- If restoring also fails, the old package is kept in `.covel-replaced-*/package`. The error reports this path, and the server does not delete it.

How a revision affects language versions and sessions:

- A revision removes the world's other existing language versions, because the translations no longer match the content. Translate again if you need them.
- The revised manifest declares only the world's own language. Any extra language versions that the model's answer or the request adds (for example "add an English version") are removed from the manifest, because a revision does not write any language files.
- Sessions that have already started are not affected. They imported the world content when they were created.

**Response**

The SSE events are the same as for `generate-world` (`progress` → `done` / `error`). A revision is one model request, so `parts` contains only one `revision`.

**Concurrent changes**

- While the model is running, the server does not hold the world's operation lock. It checks the identity of the original record and the file package inside the lock only at publish time.
- If the world is edited, deleted, or replaced during this time, the revision fails. Existing edits and the new package are both kept, and the player can reload and start a revision again.
- When the browser saves a `done` result, it is also inside the cross-window world lock, and it compares the result with the full world as it was when the request started. If another window edited, deleted, or replaced the world during this time, the local save is refused. The current record and the player's revision request are kept. You can retry after reloading the world.

**Errors**

| Status | `code`                   | Meaning                                                                                                                                            |
| ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | —                        | `worldId` or `instruction` is missing, `instruction` is too long, or `idleTimeoutMs` is out of range                                               |
| 404    | `world_not_found`        | The server does not have this world, and the request did not include `world`                                                                       |
| 409    | `world_not_revisable`    | The world has no generated mark. Built-in, hand-written, or installed world packages are changed by editing their files, not through this endpoint |
| 409    | `world_package_modified` | The generated world package has files that were added or edited by hand. `details` is `{ added, changed }`, and the package was not changed        |
| 409    | `world_deleting`         | The world is being deleted                                                                                                                         |

### Trace Debugging

A trace is a debug event that the server records for each turn: which runtime started, which model was called, and which tool failed. The debug page `/debug` reads these three endpoints.

All three endpoints follow the same rules:

- Events are ordered from oldest to newest.
- The `nextCursor` in the response is an opaque string. When it is not `null`, there are earlier events. Send it back unchanged as `?cursor` to read the earlier part.
- An invalid `cursor` returns `400 { "code": "invalid_cursor" }`.
- `discovery` is the plugin and runtime discovery snapshot for this session. The debug page uses it to show names.

#### `GET /api/traces/:sessionId`

Gets the recent trace events for a session.

- Returns at most 5000 events at a time. A single trace event can contain a whole prompt, so all the events of a long session are not read at once.
- If the session has more than 5000 events, `nextCursor` is not `null`. Send it back as `?cursor` to this endpoint or to `/turns/page` to read earlier events.
- `discovery` is returned only in requests that have no `cursor`.
- `count` is the number of events returned this time.

**Response:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "count": 42,
  "discovery": {
    /* plugin/runtime discovery snapshot for this session (buildSessionDiscoverySnapshot) */
  },
  "events": [
    {
      "id": "trace-event-001",
      "type": "runtime.started",
      "requestId": "",
      "traceId": "8f1c2d3e-…",
      "sessionId": "mistport-a1b2c3d4",
      "turnId": "turn-001",
      "flowId": "8f1c2d3e-…",
      "seq": 0,
      "timestamp": "2025-01-15T10:00:00.000Z",
      "diagnostic": {
        "displayType": "runtime.started",
        "severity": "info",
        "runtimeId": "narrator",
        "pluginId": "story",
        "stage": "narrative"
      },
      "payload": {
        "runtimeId": "narrator",
        "pluginId": "story",
        "stage": "narrative"
      }
    }
  ],
  "nextCursor": null
}
```

Event fields:

| Field        | Description                                                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`         | The ID of this row in the `trace_events` table. Merging pages, selecting an event, and copying a link all use it. Do not assume that `seq` is non-zero or unique.                                 |
| `eventOrder` | The event's position in this response, starting from `0`, in the order it was recorded. It is not a global database number. It is stable only within one page, so do not compare it across pages. |
| `flowId`     | Equal to this event's `traceId`.                                                                                                                                                                  |
| `requestId`  | The value of `requestId` when the event payload has one. Otherwise it is an empty string `""`.                                                                                                    |
| `timestamp`  | The time when this trace record was written.                                                                                                                                                      |
| `diagnostic` | A debug summary that the server pulls from the payload. See below.                                                                                                                                |
| `payload`    | The original content of the event, unchanged. Use it for detailed inspection.                                                                                                                     |

Contents of `diagnostic`:

- It always includes `displayType` and `severity`.
- Depending on the event type, it provides `runtimeId`, `pluginId`, `stage`, `operation`, `provider`, `model`, `slot`, `attempt`, `durationMs`, `startedAt`, `error`, `warning`, `tool`, and `prompt`.
- The summary reads only the top-level fields of the payload.
- `severity` is `info`, `warning`, or `error`. When both an error and a slow-call warning apply, it uses `error`.
- `warning`: For a successful LLM, gateway, utils, tool, runtime call, or task that takes 1000ms or more, it includes `warning: { code: "slow", thresholdMs: 1000 }`.
- `error`: The failure details are in `diagnostic.error.{message,code?,details?}`.
- `prompt`: A summary of the prompt. `contentAvailable` says whether the text was recorded, and `contentPath` points to the text in `payload.messages`.
- `tool`: The tool name, the call ID, whether arguments and results exist, and their paths in the original payload. Where it can work them out, it also gives `success` and `durationMs`. The text of the arguments and results is only in the original `payload`.

An `llm.calling` event also has `payload.startedAt` / `diagnostic.startedAt`. These show when the model request actually started. For how long a model call took, use `durationMs` from `llm.responded`.

#### `GET /api/traces/:sessionId/turns`

Returns trace events grouped by turn.

The range read, `?cursor`, `nextCursor`, and `discovery` follow the same rules as `GET /api/traces/:sessionId`, with at most 5000 events. The 5000-event limit can split a turn in half. After you read the earlier events, merge them by `turnId`.

**Response:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "discovery": {
    /* plugin/runtime discovery snapshot (same as /api/traces/:sessionId) */
  },
  "turns": [
    {
      "turnId": "turn-001",
      "flowId": "8f1c2d3e-…",
      "traceId": "8f1c2d3e-…",
      "startedAt": "2025-01-15T10:00:00.000Z",
      "completedAt": "2025-01-15T10:00:05.000Z",
      "eventCount": 12,
      "events": [...]
    }
  ],
  "nextCursor": null
}
```

#### `GET /api/traces/:sessionId/turns/page`

Gets only a small recent range of events, grouped by turn. The debug timeline uses it to load one page at a time. `trace_events` is the table that grows fastest, and `/turns` reads ten times as many rows as the single-page limit here.

**Parameters:**

| Parameter   | Location | Description                                                                                     |
| ----------- | -------- | ----------------------------------------------------------------------------------------------- |
| `sessionId` | path     | Session ID                                                                                      |
| `limit`     | query    | The number of **events** per page (not turns). The default is 400, and the maximum is 500       |
| `cursor`    | query    | The `nextCursor` from the previous page response. An invalid value returns `400 invalid_cursor` |

Paging is done in events, so a page boundary can cut a turn in half. After you load the earlier page, merge the turns at the boundary by `turnId`. `nextCursor` points to the oldest event on this page.

**Response:**

```json
{
  "sessionId": "mistport-a1b2c3d4",
  "turns": [
    { "turnId": "turn-008", "startedAt": "…", "completedAt": "…", "eventCount": 6, "events": [...] }
  ],
  "nextCursor": "<opaque>",
  "discovery": {
    /* same as /turns */
  }
}
```

When `nextCursor` is `null`, you have reached the start of the trace.

### Media Management

Media means the images, audio, video, and other files saved in MediaStore. The ID of each file is the SHA-256 of its content.

#### `GET /api/media/:id?token=<signed>`

Downloads a media file. The `token` is a short-lived signature. Request it with `GET /api/sessions/:id/media-token?id=<mediaId>`.

#### `POST /api/media/cleanup`

Deletes media that is no longer referenced. This is a destructive maintenance endpoint.

It first scans `messages`, `plugin_data`, `runtime_outputs`, `trace_events`, `snapshots`, and `turn_results`. It collects the mediaIds that are still referenced. Then it calls `MediaStore.cleanup()` to delete the rest.

Every cleanup also releases the temporary references (`world-data-import:<uuid>`) that a world-data import left behind and that were created 24 hours ago or earlier. A dry run only lists them in `expiredRefs`, and a real run removes them. A younger temporary reference keeps protecting its file. The limit is fixed. The rule is in [Media store](./media-store.md#temporary-references-during-world-data-import).

> [!WARNING]
> This endpoint is disabled by default. You must set `COVEL_MEDIA_CLEANUP_ENABLED` to use it. Actual deletion also requires a confirmation header.

**Request body:**

```json
{
  "dryRun": true,
  "maxBytes": 0,
  "maxAgeMs": 0,
  "keepRecentBytes": 0,
  "scanLimit": 1000
}
```

| Field             | Type                | Required | Description                                                                                                                                                                                   |
| ----------------- | ------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dryRun`          | boolean             | No       | The default is `true`, which only returns the list of what would be deleted. Only `false` really deletes, and it must come with the `X-Confirm-Cleanup: yes` header.                          |
| `maxBytes`        | non-negative number | No       | Passed unchanged to `MediaLifecyclePolicy`.                                                                                                                                                   |
| `maxAgeMs`        | non-negative number | No       | Same as above.                                                                                                                                                                                |
| `keepRecentBytes` | non-negative number | No       | Same as above.                                                                                                                                                                                |
| `scanLimit`       | positive integer    | No       | The most rows to scan for one session. The default is 1000. If a session goes over, the request is rejected. It is never cut short silently. An operator can raise it explicitly when needed. |

**Success response (200):**

```json
{
  "ok": true,
  "policy": {
    "dryRun": true,
    "expireRefs": {
      "sessionIdPrefix": "world-data-import:",
      "maxAgeMs": 86400000
    },
    "maxBytes": 0
  },
  "result": {
    "scanned": 12,
    "protected": 7,
    "retained": 7,
    "deleted": 5,
    "totalBytes": 1048576,
    "bytesDeleted": 524288,
    "bytesRetained": 524288,
    "protectedIds": ["..."],
    "deletedIds": ["..."],
    "expiredRefs": [
      {
        "mediaId": "...",
        "sessionId": "world-data-import:...",
        "pluginId": null,
        "createdAt": "2026-10-01T08:00:00.000Z"
      }
    ]
  }
}
```

**Errors:**

| Status | `code`                    | When                                                                                                                                                                      |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 503    | `unavailable`             | `DEPLOYMENT_TIER=commercial`. In a commercial deployment this endpoint is never available. The error message is `cleanup endpoint not available in this deployment tier`. |
| 401    | `operator_token_required` | `DEPLOYMENT_TIER=demo`, and no correct operator token was given.                                                                                                          |
| 403    | `forbidden`               | `COVEL_MEDIA_CLEANUP_ENABLED` is not set to `true` or `1`. The error message is `cleanup endpoint disabled`.                                                              |
| 400    | `invalid_request`         | `dryRun: false`, but there is no `X-Confirm-Cleanup: yes` request header.                                                                                                 |
| 400    | `limit_exceeded`          | A session's scanned rows are more than `scanLimit`. The error message starts with `scan limit exceeded for session`.                                                      |
| 429    | `operation_in_progress`   | A request arrived while the previous cleanup was still running. The error message is `Operation already in progress`.                                                     |

**Examples:**

```bash
# Dry run only (safe)
COVEL_MEDIA_CLEANUP_ENABLED=true \
  curl -X POST http://localhost:3001/api/media/cleanup \
       -H "content-type: application/json" \
       -d '{"dryRun": true}'

# Real delete (the confirmation header is required)
COVEL_MEDIA_CLEANUP_ENABLED=true \
  curl -X POST http://localhost:3001/api/media/cleanup \
       -H "content-type: application/json" \
       -H "X-Confirm-Cleanup: yes" \
       -d '{"dryRun": false, "maxBytes": 0}'
```

> [!NOTE]
> `COVEL_MEDIA_CLEANUP_ENABLED` is an environment variable of the server process. Set it when you start the server.
>
> When there are more than 100 sessions, the scan runs in batches of 50. It writes progress to the server log: `[media-scan] scanned X/Y sessions`.

#### `GET /api/media/library`

Lists the player's media library: the images, audio, video, and other files saved in MediaStore, and which sessions use each item. The "Stored media" page in Settings reads this endpoint. It is read-only and does not delete anything.

**Where it is available:** Only in a deployment where one player owns all the data, that is `DEPLOYMENT_TIER=self` and the desktop app. The two deployments below always return 503 `{ "code": "unavailable" }`, even with an operator token:

- `demo` / `commercial`
- The browser-private profile (MemoryStore) in production

The reason is that in these deployments, media is shared by several owners, and there is no index by owner.

**Query parameters:**

| Parameter   | Description                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `kind`      | `image` / `audio` / `video` / `other`. Filters by MIME type. If omitted, all kinds are returned |
| `usage`     | `unused` (no session uses it) or `in-use` (all the others). If omitted, all are returned        |
| `limit`     | Items per page. The default is 60, and the maximum is 200                                       |
| `offset`    | Where to start. The default is 0. Sorted by creation time, newest first                         |
| `refresh`   | If `1`, sessions are scanned again. Otherwise the last scan from within 30 seconds is reused    |
| `scanLimit` | The most rows to scan for one session. The default is 200000                                    |

If a session has more rows than `scanLimit`, the scan counts as incomplete (see `scan` below). A session that cannot be fully read is not treated as "no references".

If `limit` or `scanLimit` is not a positive integer, or `offset` is not a non-negative integer, the server returns 400 `{ "code": "invalid_request" }`.

**Response (200):**

```json
{
  "items": [
    {
      "id": "<sha256>",
      "mime": "image/png",
      "kind": "image",
      "size": 482113,
      "createdAt": "2026-10-01T10:00:00.000Z",
      "name": "gate.png",
      "usage": "used",
      "usedBy": ["lantern-barrow-1a2b3c4d"],
      "url": "/api/media/<sha256>?token=<signed>"
    }
  ],
  "total": 132,
  "offset": 0,
  "limit": 60,
  "sessions": [
    {
      "id": "lantern-barrow-1a2b3c4d",
      "worldId": "lantern-barrow",
      "status": "active",
      "completedPlayerTurns": 12,
      "createdAt": "2026-09-30T08:00:00.000Z",
      "updatedAt": "2026-10-01T10:00:00.000Z"
    }
  ],
  "totals": {
    "count": 132,
    "bytes": 91234567,
    "unusedCount": 40,
    "unusedBytes": 30123456,
    "byKind": {
      "image": { "count": 120, "bytes": 0, "unusedCount": 38, "unusedBytes": 0 }
    }
  },
  "scan": { "complete": true, "scannedAt": "2026-10-10T09:00:00.000Z" }
}
```

Each item's `usage` has four values:

| `usage`   | Meaning                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `used`    | At least one existing session uses it. `usedBy` lists those sessions.                                                                                  |
| `unused`  | After a full scan, nothing uses it.                                                                                                                    |
| `held`    | No existing session uses it, but another holder still has it: a world data import in progress, or an old reference to a session that no longer exists. |
| `unknown` | The scan was incomplete, and no user was found.                                                                                                        |

Only `unused` counts toward `totals.unusedCount` and `totals.unusedBytes`.

Other fields:

- **What counts as "used by a session"**: the session owns the file. Or it holds an explicit reference (`media_refs`). Or the mediaId appears in any row of its `messages`, `plugin_data`, `runtime_outputs`, `trace_events`, `snapshots`, or `turn_results`.
- **`scan`**: When `complete: false`, it includes `incompleteSessionId`, which shows that this session has more rows than `scanLimit`. In that case, no item is `unused`.
- **`totals`**: Counts the whole media library. It is not affected by the `kind` / `usage` filters.
- **`sessions`**: Only includes the sessions mentioned by the items on this page.
- **`url`**: A signed address that is valid for one hour. You can use it directly in `<img>` / `<audio>` / `<video>`. The server has no thumbnails, so this address returns the original file.

> [!NOTE]
> Files in a world package directory (`worlds/<id>/media`, covers, portraits) are not MediaStore content, so they do not appear here.

#### `POST /api/media/library/delete`

Deletes media based on the player's choice. The availability is the same as for `GET /api/media/library`, and other deployments return 503. Every request scans the sessions again. It does not use the list's cache.

**Request body (one of three):**

```json
{ "ids": ["<sha256>", "<sha256>"] }
```

```json
{ "unused": true }
```

```json
{ "ids": ["<sha256>"], "force": true }
```

| Field       | Description                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ids`       | 1 to 1000 IDs. Only the ones that are currently `unused` are deleted. The others are kept as they are, and `skipped` gives the reason.                                                                                    |
| `unused`    | When `true`, deletes everything that is currently `unused`.                                                                                                                                                               |
| `force`     | When `true`, accepts exactly one ID. It is deleted even if it is still in use, and every session's reference to it is deleted too. After that, sessions that used it show a "media unavailable" placeholder in its place. |
| `scanLimit` | Optional. Same meaning as for the list endpoint.                                                                                                                                                                          |

**Response (200):**

```json
{
  "deletedIds": ["<sha256>"],
  "bytesDeleted": 482113,
  "skipped": [{ "id": "<sha256>", "reason": "in_use" }]
}
```

Values for `skipped[].reason`:

- `in_use`: A session is using it, including a session that started using it after the scan.
- `held`: It is held by a holder that is not an existing session.
- `not_found`: The ID cannot be found.

**Errors:**

| Status | `code`            | When                                                                                                    |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------- |
| 503    | `unavailable`     | This deployment does not provide a media library                                                        |
| 400    | `invalid_request` | The request body is not one of the three forms above                                                    |
| 409    | `scan_incomplete` | A request without `force`, and a session has more rows than the limit. In this case nothing is deleted. |

## SSE protocol

SSE is how the server keeps pushing events to the client. Covel has two separate SSE streams. Their frame and envelope formats are different:

| Endpoint                 | Frame shape                                   | Envelope            | Purpose                    |
| ------------------------ | --------------------------------------------- | ------------------- | -------------------------- |
| `POST /api/actions`      | data-only (`data: {...}`, no `event:` header) | `SseEnvelope`       | Main stream for a turn     |
| `GET /api/events/stream` | named events (`event: <type>\ndata: {...}`)   | `SubscriptionEvent` | Side channel outside turns |

- **`POST /api/actions`**: the envelope carries `requestId` / `traceId` / `flowId` / `seq`. It carries the narrative text of a turn, runtime lifecycle, tool-call traces, and so on.
- **`GET /api/events/stream`**: the envelope carries `id` / `topic` / `type`. Events are broadcast by the EventBus. It carries cross-session notices, durable subscriptions, and events re-sent after a reconnect.
- In the Web client, both streams are read with `fetch()` + `ReadableStream` (`sendAction` in `api.ts` and `subscription.ts`).

> [!IMPORTANT]
> `/api/actions` uses data-only frames, so you **cannot** subscribe to it with `EventSource.addEventListener`. Only `/api/events/stream` uses named events.

**How the client parses a stream**

- It accepts LF, CRLF, and CR line endings.
- It commits a complete event only at a blank line. When the stream ends, an unfinished frame is not sent.
- On cancel, or when event handling fails, it releases the reader and cancels the response that has not finished.
- A subscription that is already closed does not bring its connection state back because of a late response.
- Cancelling a wait before a GET retry also gets a response. A cancel with a custom abort reason does not retry again and does not show a network error.

**When the Web client pauses the side subscription**

When the tab is hidden, or when the page is holding an `/api/actions` execution stream, the Web client pauses `/api/events/stream`. This frees the browser's same-origin HTTP connection. The execution stream keeps running.

When the page is visible again and all action streams have ended, the client resumes like this:

1. It reconnects with the saved event cursor.
2. It reads the session state from the server again, to fill in plugin data, messages, and background jobs from the paused time.

Also:

- A page that was opened in the background for the first time runs this same resume step.
- When a request was sent before the pause or close, a late response does not rebuild the old connection.
- When it restores messages, it replaces the player's local echo with the server's record by turn and content. This stops the same message from showing twice when the message IDs differ.

**A 404 in browser local storage mode**

When the side subscription gets a 404, the client recovers in this order:

1. It uploads the local checkpoint through the workspace's per-session queue, to restore the image on the server.
2. It clears the event cursor.
3. It reconnects.

Details:

- A pause and a resume reuse an upload that has not finished yet.
- A subscription that is already closed, or that switched to another session, does not reconnect. An old upload that has not yet entered the queue's critical section is cancelled.
- Remote mode does not trigger this recovery, and neither do 401 / 403.
- Repeated client errors still have a retry limit.

### Event type enum (`CovelEventType`)

The full definition is in `packages/shared/src/types/protocol.ts`. Every event sent from the server to the client belongs to one union type, `CovelEvent`. The type of an event name is `CovelEventType`.

Whether an event is forwarded to the `/api/actions` stream is decided by `COVEL_EVENT_META[type].forwardToActionStream`. The forwarding allowlist `FORWARDED_EVENT_TYPES` is generated entirely from this metadata.

For the full classification table, see [protocol.md § 1. Event types](./protocol.md#1-event-types-covelevent).

| Type                            | Category            | Description                                                                                                                                                            |
| ------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `narrative.delta`               | Narrative           | Increment of narrative text (streamed token by token)                                                                                                                  |
| `narrative.completed`           | Narrative           | Narrative text is complete                                                                                                                                             |
| `interaction.requested`         | Interaction         | Asks the player for input (form, choice, or confirmation)                                                                                                              |
| `ui.rendered`                   | UI                  | Sent after a `ui.render` proposal is submitted                                                                                                                         |
| `ui.part.update`                | UI                  | Status update for a UI part (one per part)                                                                                                                             |
| `state.changed`                 | State               | Game state changed                                                                                                                                                     |
| `state.snapshot.created`        | State               | Sent after a snapshot is written, by automatic, manual, or fork                                                                                                        |
| `session.forked`                | Session             | Sent after `POST /api/sessions/:id/fork` creates the child session                                                                                                     |
| `execution.started`             | Execution lifecycle | A turn starts running                                                                                                                                                  |
| `runtime.started`               | Execution lifecycle | A single runtime starts running                                                                                                                                        |
| `runtime.deferred`              | Execution lifecycle | A staged runtime was submitted with its original turn and moved to the background; the payload has `jobId/sourceTurnId`                                                |
| `runtime.completed`             | Execution lifecycle | A single runtime finishes running                                                                                                                                      |
| `runtime.failed`                | Execution lifecycle | A runtime fails                                                                                                                                                        |
| `execution.completed`           | Execution lifecycle | A turn finishes running                                                                                                                                                |
| `event.emitted`                 | Session lifecycle   | An event is emitted                                                                                                                                                    |
| `asset.progress`                | Asset               | Progress of multimodal generation (`0..100`)                                                                                                                           |
| `asset.generated`               | Asset               | Sent after an `asset.generate` proposal is submitted                                                                                                                   |
| `world.dimensions.changed`      | World               | The author's dimension declaration changed (hot update); does not reset the session's current values                                                                   |
| `dimensions.changed`            | State               | A committed current value changed; the payload has the provider, the public snapshot subset, and an optional settlement summary                                        |
| `dimensions.settlement.changed` | State               | A pending receipt or a receipt with no value change; the payload has no rules or initial values                                                                        |
| `plugin-data.changed`           | Plugin data         | Sent by every write path: `plugin-data-set`, DELETE, batch, and so on                                                                                                  |
| `turn.suspended`                | Flow control        | Sent after `finalizeExecution` successfully commits a suspension record                                                                                                |
| `turn.resumed`                  | Flow control        | Sent when `POST /api/sessions/:id/suspensions/:suspensionId/resume` restarts a runtime                                                                                 |
| `proposal.failed`               | Flow control        | One proposal failed to submit. It is reported clearly and never dropped quietly; the submitter writes it straight to the action stream                                 |
| `job-status.updated`            | Flow control        | A background function runtime reports progress through `ctx.progress`; append-only, forwarded to the action stream                                                     |
| `context.pruned`                | System              | The prompt went over the slot budget and the history was cut hard; only goes to the trace (used by `/debug`), not the action stream                                    |
| `context.compaction.failed`     | System              | History compaction failed, with the reason; only goes to the trace (used by `/debug`)                                                                                  |
| `commit.fanout.failed`          | System              | The turn was committed, but some events sent after the commit could not be published; only goes to the trace, and the subscription stream also receives `system.reset` |
| `error.occurred`                | System              | An execution error                                                                                                                                                     |

### Forwarded internal runtime events (included in `CovelEventType`)

These events are also full members of `CovelEvent`. `COVEL_EVENT_META` says for each one whether it is `forwardToActionStream`. The exhaustiveness check in the front end requires that each one is either handled or explicitly ignored.

| Event                                                                  | Source                           | Forwarded to `/api/actions` | Description                                                                                                                                                            |
| ---------------------------------------------------------------------- | -------------------------------- | :-------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.skipped`                                                      | `actions.ts`                     |             No              | A runtime was skipped because of cooldown / startTurn / maxTriggerCount                                                                                                |
| `character.upserted`                                                   | `session-commit-emitter.ts`      |             Yes             | Sent after a `character.upsert` proposal is committed                                                                                                                  |
| `tool.calling` / `tool.completed` / `tool.failed`                      | TurnEmitter                      |             Yes             | Tool-call traces (for the debug timeline)                                                                                                                              |
| `llm.calling` / `llm.responded` / `message.completed`                  | TurnEmitter                      |             Yes             | LLM call traces                                                                                                                                                        |
| `block.emitted` / `state.patch.applied`                                | TurnEmitter                      |             Yes             | Traces for a block being emitted / a state patch being applied                                                                                                         |
| `hook.fired` / `hook.rewrote` / `hook.aborted`                         | TurnEmitter                      |             Yes             | Hook behavior traces                                                                                                                                                   |
| `gateway.calling` / `gateway.responded` / `gateway.failed`             | TurnEmitter (`withGatewayTrace`) |             Yes             | Traces for a function runtime or an extension provider calling a provider through `ctx.gateway` (same as `llm.*`); a failure carries the `usage` the provider reported |
| `function.executing` / `function.completed`                            | TurnEmitter                      |             No              | Start and end traces of a function runtime handler; only goes through the subscription channel and `trace_events`                                                      |
| `recursive.calling` / `recursive.completed` / `recursive.failed`       | TurnEmitter                      |             No              | Traces of a recursive runtime; only goes through the subscription channel (topic `trace`)                                                                              |
| `utils.fetch.calling` / `utils.fetch.responded` / `utils.fetch.failed` | `withUtilsTrace`                 |             No              | Traces of a plugin's own wire calling a provider over HTTP (`ctx.utils.fetchWithRetry`)                                                                                |

See [protocol.md § Forwarded internal runtime events](./protocol.md#forwarded-runtime-internal-events-apiactions-forwards-them-included-in-covelevent) for details.

### Envelope format

The envelope is the fixed set of fields wrapped around each event. Each of the two streams uses one:

```typescript
// Shape of each data: line in an /api/actions data-only frame
interface SseEnvelope {
  type: string; // See the two event tables above (members of CovelEventType)
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string; // = traceId
  seq: number; // Increments within this stream
  timestamp: string;
  payload: Record<string, unknown>;
}

// data shape of a named event frame on /api/events/stream
interface SubscriptionEvent {
  id: string; // `${epoch}:${seq}`, used as the cursor on reconnect
  topic: SubscriptionTopic;
  type: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
```

`SseEnvelope` is defined in `packages/shared/src/types/api-contract.ts`, and `SubscriptionEvent` is defined in `packages/shared/src/types/subscription-events.ts`. The event types and their payloads are in `packages/shared/src/types/protocol.ts`. In the same file, `ProtocolEvent` (`id`, `type`, `sessionId`, an optional `turnId`, `source: { pluginId, runtimeId }`, `payload`, `timestamp`) is the shape of an internal server event.

## Storage mode notes

Covel has three deployment tiers. Each tier stores data in a different way.

In the browser, you can also switch the storage mode:

- `local`: data is saved in the player's browser, in IndexedDB.
- `remote`: data is saved through the server API, to the backend set by `STORE_BACKEND`.

### T1: Self-deploy

- **Server storage**: SQLite (the default, `./data/covel.db`). You can switch explicitly to Memory, but only for one-off tests.
- **Front-end storage**: remote is the default, and it uses the server's SQLite. Local mode uses the browser's IndexedDB.
- **Data flow**:
  - Remote mode: the front end reads and writes the server's store through the API.
  - Local mode: game records are saved as versioned checkpoints in the Dexie `covel-browser-vault`. Before a run, they are uploaded to a temporary MemoryStore. After the run, `SessionCommit` is applied in one atomic step.
  - Server features such as world generation hand their result to the front end through a `return-only` response, and the front end saves it.
- **API keys**: the user manages them. They are saved in the browser's localStorage.
- **Authentication**: none

```bash
# How to start
pnpm dev:server                       # SQLite backend (default)
STORE_BACKEND=memory pnpm dev:server  # Temporary Memory backend (data is lost on restart)
```

### T2: Demo host

- **Server storage**: Memory or SQLite
- **Front-end storage**: demos that allow public writes can use local IndexedDB. Private demos can also use remote server storage.
- **API keys**: the user manages them. They must be sent over HTTPS.
- **Authentication**: **required**.
  - Session-scoped endpoints enforce the session owner token.
  - Global endpoints and admin endpoints enforce the operator token (`COVEL_DESKTOP_REST_TOKEN`).
  - If no operator token is set, `validateSecurityPosture` refuses to start.
  - See the [authentication section](#authentication-session-owner-token) above for details.

### T3: Commercial

- **Server storage**: PostgreSQL (you must set `DATABASE_URL`)
- **Front-end storage**: all create, read, update, and delete of game data goes through the server API. The browser keeps only a display cache: form submission markers and the history timeline, checked against the session identity.
- **API keys**: managed at two levels, by the platform and by the user
- **Authentication**: required

```bash
# How to start
STORE_BACKEND=pg DATABASE_URL=postgresql://covel:pass@localhost:5432/covel pnpm dev:server
```

### Comparing storage backends

| Capability  | Memory                 | SQLite                                                  | PostgreSQL                                                                              |
| ----------- | ---------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Persistence | No (lost on restart)   | Yes (local file)                                        | Yes (remote database)                                                                   |
| Concurrency | Single process         | Single process                                          | Multiple processes (`pg_advisory_lock` makes one session run serially across processes) |
| Use case    | Tests / one-off demos  | Single-machine deployment (default)                     | Production                                                                              |
| Setup       | `STORE_BACKEND=memory` | Default (`STORE_BACKEND=sqlite`, can be set explicitly) | `STORE_BACKEND=pg` + `DATABASE_URL`                                                     |

> [!NOTE]
> **Session locks for multi-process deployments**
>
> - When `STORE_BACKEND=pg`, the server startup log prints `session lock: pg-advisory`.
> - Session-scoped changes, turns, resumes, detached commits, and so on take an advisory lock on a dedicated PG connection. This makes sure one key runs serially across several pods.
> - Keys nested or batched inside the same async branch share one reserved connection. This stops the connection pool with `max=1`, or a batch of several keys, from using up all the connections.
> - The Memory and SQLite backends use an in-process lock, which covers only a single process.

### Service lifecycle

This section explains how the server starts and shuts down. Developers who embed the API in their own host need it. Readers who only call the HTTP endpoints need to know one thing: during shutdown, new requests return `503 / server_shutting_down`.

**Startup**

- When the server starts, it records who closes each of these: the DataStore, MediaStore, the PG lock pool, the API service, and the file watchers.
- If a later startup step fails, the server goes through the same drain process as a normal exit. This process can be run more than once, and it keeps the original startup error.
- If API assembly fails, it releases the event transport and the plugin registrations it has already created. Storage injected from outside is still closed by the caller.
- The startup scan does not block API readiness. It is tracked through `ApiBootstrapResult.startupMaintenance`.

**Shutdown order**

1. Stop accepting new requests, file watching, and both background queues at the same time. Telling these producers to stop together lets background jobs release the session locks that foreground requests are waiting for.
2. Wait for them and for the startup scan to finish.
3. Drain the memory tasks.
4. Call `closePluginEntries()`.
5. Close the event bus, the underlying storage, and the connection pools.

Each drain stage has a time limit. If tracked work has not finished, the resources it depends on are kept, and the process's final exit handles them.

**What counts as "work finished"**

`ApiBootstrapResult.applicationWork.close()` tracks whether the business work is finished. Closing the HTTP connection, or creating the Response, does not count as finished.

- Normal requests: this covers the full middleware and handler.
- Also tracked: actions, world generation, the SSE callbacks of long-lived subscriptions and their read and write queues, and the suspension scan triggered by a request.

**How each kind of work is handled during shutdown**

- New requests return `503 / server_shutting_down`.
- Player turns, manual runtimes, resumes, and world generation receive the host's cancel signal.
- Queued actions and resumes check again after they get the lock.
- A cancelled commit is rolled back. State that was already committed successfully is not undone.
- Long-lived subscriptions stop reading and writing, and release their registration.

**A few boundaries**

- A client disconnecting from the action SSE does not cancel the turn. After a refresh, use the execution recovery protocol.
- A cancel from the host is not treated as the player aborting.
- After world generation receives a cancel from the caller, it stops retrying the provider. A late model output does not count as a valid result.
- A normal RPC handler, or code a plugin starts itself that does not respond to cancellation, cannot be forcibly stopped inside the same process. Task tracking does not replace the plugin's capability limits, and it does not replace the recovery protocol of an external side effect.

**Embedded callers**

- They must follow the same order above. They cannot just call `worker.close()` and close the storage right away.
- An outer Hono host can inject its own `applicationWork` into `bootstrapApi`, and put its middleware ahead of the host's routes. This way, the API shares one shutdown boundary with the configuration, model, and other routes.

### Key environment variables

For the full list, see [`env-registry.md`](./env-registry.md).

| Variable            | Description                  | Default           |
| ------------------- | ---------------------------- | ----------------- |
| `STORE_BACKEND`     | Storage backend type         | `sqlite`          |
| `SQLITE_PATH`       | SQLite database path         | `./data/covel.db` |
| `DATABASE_URL`      | PostgreSQL connection string | -                 |
| `SERVER_PORT`       | Server port                  | `3001`            |
| `DEPLOYMENT_TIER`   | Deployment tier              | `self`            |
| `CORS_ORIGIN`       | Origins allowed by CORS      | -                 |
| `ENABLE_DEBUG_PAGE` | Enable the debug page        | `false`           |
| `RATE_LIMIT_RPM`    | Rate limit (requests/minute) | `60`              |

### Opening the effective configuration

`POST /api/config/open-folder` opens a configuration file in the system's file manager. The request body is `{ "target": "llm.toml" }`.

Where the target resolves to:

| `target`   | Location opened                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.toml` | If `COVEL_LLM_TOML` is set, opens that file (a relative path is taken from the server's working directory). Otherwise opens `<covelHome>/llm.toml` |
| `keys.env` | Always under `covelHome`                                                                                                                           |

When the file does not exist:

- Desktop mode, `llm.toml` missing: it creates the file from the built-in default configuration, then opens it. The built-in default configuration has the same slots as the fallback configuration in effect, so nothing changes until you edit it. The response is `{ "ok": true, "created": true }`.
- Any other target that does not exist, or `llm.toml` missing outside desktop mode: returns `400` with `code` `open_target_unavailable`.

On success the response is `{ "ok": true, "created": <boolean> }`.

> [!NOTE]
> Opening a file does not make the running gateway reload. After you edit it, call `POST /api/llm-config/reload` for the model configuration to take effect.

### Editing a configuration file as text

These three endpoints let the app read and change configuration files as text.

**`GET /api/config/raw`** lists the files the server lets the app edit:

- `llm.toml`: the path the server actually loads, which is `source.path` in `GET /api/llm-config`.
- `config.toml`: desktop mode only.
- `keys.env` is never in the list.

**`GET /api/config/raw/:name`** returns `{ name, path, exists, applies, content, digest }`:

- `applies`: for `llm.toml` it is `reload` (takes effect as soon as you save), and for `config.toml` it is `restart` (takes effect after a restart).
- When the file does not exist yet, `content` is a starter text, and `digest` is the digest of an empty file.

**`PUT /api/config/raw/:name`** takes the body `{ content, baseDigest }`. The server handles it in this order:

1. It checks the text with the same parser it uses to load this file.
2. It checks `baseDigest`. It must be the digest of the file as it is on disk now.
3. It copies the original file to `<name>.bak`, then replaces it atomically.
4. `llm.toml` takes effect immediately.

The response is the same set of fields as the read, plus `backup` (the path of the backup file) and `reload` (`{ ok, slots, error? }`).

Errors:

| Status | `code`                        | When                                                                                              |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| 404    | `config_file_unknown`         | The file name is not in the allowed list                                                          |
| 400    | `config_file_request_invalid` | `content` or `baseDigest` is not a string                                                         |
| 413    | `config_file_too_large`       | The text is over 256 KiB                                                                          |
| 400    | `config_file_invalid`         | The text did not pass parsing. The response carries the parser's message, and nothing is written. |
| 409    | `config_file_changed`         | The file was changed after it was read                                                            |

The three endpoints have the same gate as the install endpoints:

- The managed tiers (`demo` / `commercial`) require the operator token.
- Under the desktop shell, the desktop token is required.
- In production, `COVEL_INSTALL_API_ENABLED=1` is required.

### Installed resource storage and vector configuration

**Installing a world (`POST /api/install/world`)**

- Before it returns, the installed package is loaded into the DataStore. The response is `201`, with `restartRequired: false`.
- The world shows up in `GET /api/worlds` right away. This works even when the host has no recursive file watching.
- If activation fails, only the package directory that this install created is deleted, so you can try the install again.
- An uploaded world has `source: "generated-file"` and is bound to the user worlds directory, so DELETE works right away.
- If the world ID already exists, it returns 409 and does not overwrite the existing record.
- Installing a plugin still returns `restartRequired: true`.

**Validation before ZIP activation**

- If worldData has error-level diagnostics, it returns 400 before any record is created. This covers a missing descriptor or source, a malformed source, and a source that does not match its own schema.
- Warning-level diagnostics are still allowed.
- Validation checks the package contents as they are. It does not apply local overrides, and it does not run community code.
- The fault-tolerance rules for seeding at startup do not change.

**The target directory already exists**

- Both ZIP install endpoints return `409 { error: "target already exists: <id>" }` when the target directory already exists. A rename conflict reported as `EPERM` on Windows counts too.
- When you get `EPERM` but the target directory cannot be found, the original error is kept.
- If publishing fails, the staging directory is deleted, and the existing install is kept.

**Restart and refresh after an install**

- In Electron, `covel:restart-server` does two things: it restarts the sidecar, and once the health check passes, it makes the native window navigate to the new port.
- The Web client keeps its reload overlay. It must not reload the old URL itself, and it must not try a cross-origin jump.
- In development mode, the external Vite page is reloaded.
- Uninstalling a plugin still needs a restart before the discovered code is unloaded. Uninstalling does not delete the session data the plugin has saved.

**Generated world files**

- Generated, revised, and translated world files are written into a hidden staging directory. The complete copy passes the same package preflight as ZIP installation before publication: manifest and world-data read-back must have no errors, and local overrides are excluded.
- This package preflight does not require receiving plugins to be enabled; session preflight still handles session-data contract checks.
- Existing packages and identities in the database are kept. An ID conflict or an activation failure is reported through one SSE error event.
- If activation fails, only the package created by this request is deleted.

**Directory import on desktop**

- The staged copy is validated first, and then published, just like above.
- A manifest that is a link, a copy that fails, or a target that is inside the source directory is refused, so no half-installed package is left behind.
- World and plugin discovery skip hidden staging directories.

**Install directories**

- Installation and discovery share `COVEL_USER_WORLDS_DIR` and `COVEL_USER_PLUGINS_DIR`.
- By default these are `worlds/` and `plugins/` under `COVEL_HOME` (`~/.covel` when it is not set).
- Docker Compose keeps these two directories in the `appdata` volume. Desktop paths are still decided by the desktop shell.

**Vector configuration**

`VECTOR_BACKEND=none` turns off:

- automatic locking of the embedding model;
- writes to semantic memory;
- vector recall and archive search.

Keyword memory still works, and existing embeddings are kept. Outside the memory subsystem, an explicitly requested provider embedding is not affected.

### Community plugin pending-approval state

When a session is created, the community plugin IDs the player chose are kept.

Entries from `GET /api/sessions/:id/plugins` have an optional field `approvalRequired`:

- It is `true` when a plugin has been chosen, but the current session has not yet been authorized to run it. In that case `active` is still `false`.
- The front end should clearly show "Paused" and re-authorize through the existing enable and approval endpoints. Do not treat it as the player having cancelled their choice.
- Authorization is not kept after the server process restarts.

### GET /api/sessions/:id/plugin-diagnostics

Returns a read-only snapshot of plugin registrations, and the recent service calls of the current session. Reading it does not activate any entry, and it does not run plugin code.

- Authentication is the same as for other session endpoints. The response stage checks the session instance once more.
- The optional query parameter `pluginId` filters plugins by exact package ID. The result includes the calls where it appears as the caller or the provider.
- The response has `Cache-Control: no-store`.

| Status | When                            |
| ------ | ------------------------------- |
| 404    | `pluginId` is an unknown plugin |
| 400    | A query parameter is invalid    |

**Response**

Returns `PluginDiagnosticsSnapshot` (from `@covel/shared`):

| Field              | Description                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `sessionId`        | The session it belongs to                                                                 |
| `capturedAt`       | When the snapshot was taken                                                               |
| `plugins[]`        | The status and registrations of each plugin, see below                                    |
| `calls[]`          | Recent service calls, see below                                                           |
| `extensionCalls[]` | Call counts grouped by extension point and provider, see below                            |
| `history`          | `{ "scope": "process", "limit": 100 }`, which describes the scope of `calls[]`, see below |

**`plugins[]`**

Each item has `pluginId`, `source`, `active`, `hostState`, `sessionState`, `serverCodeApproved`, `runtimeIds`, `registrations`, and `commands`. It also has the optional `autoAdded`, `rejection`, `approvalRequired`, `error`, and `registrationError`. The status and dependency results come from the same read-only resolution used by the session plugin list.

- `hostState`: the publish state of the entry across the whole process.
- `sessionState`: `active | inactive | approval-required | rejected`.
- `serverCodeApproved`: worked out from the live authorization of the current session.
- A plugin being loaded in the process does not mean this session is allowed to run it. Revoking authorization also does not destroy an entry that other sessions share.
- `error`: only a fixed explanatory text.
- `registrationError`: `{ code: "plugin_registration_invalid", registration }`. It comes only from registration error types the host recognizes. It is not inferred from an error string, and it does not carry the raw exception.

`registrations` lists what is actually registered:

| Field          | Content                        |
| -------------- | ------------------------------ |
| `tools[]`      | Tool names                     |
| `hooks[]`      | `{ id, event }`                |
| `actions[]`    | RPC action names               |
| `services[]`   | `{ name, contract }`           |
| `extensions[]` | `{ point, id, order?, slot? }` |

Actual registrations are returned only for a package that is active in the current session, is approved, and whose host state is not error. For other packages this list is empty.

`commands[]` is the declared commands `{ name, action, registered }`. `registered` says whether this action is in the registry above. It does not replace the permission check at run time.

**`calls[]`**

Each record has:

- `callId`, and optional `parentCallId` / `turnId` / `runtimeId`;
- `callerPluginId`, `providerPluginId`, `name`, `contract`;
- `completedAt`, `durationMs`;
- `outcome`: `success` / `timeout` / `cancelled` / `error`;
- an optional `errorCode`, taken from a fixed set of categories. A failed final-output check and a failed ownership check are both `output-validation`;
- extension calls also carry `extension: { point, id, slot? }`, taken from the registration.

**`extensionCalls[]`**

Grouped by `point` and `providerPluginId`, with `total / success / error / timeout / cancelled`.

- It sums the same `calls` batch returned in this response. It is not a total over the whole lifetime.
- A cache hit does not add to the count.
- When no usable provider is found, there is no call record.
- Skip and fail-turn each count an actual failure only once.

**The scope of `history` and the call records**

- The whole process keeps at most 500 completed calls.
- After filtering by the current session instance, it returns at most 100, newest first.
- Records are not shared between processes, and they are not persisted.
- Failures before a caller passes admission are not written to this session's history.
- A record has no input, no output, no raw error, no credentials, and no private session scope.
- A session rebuilt with the same ID does not see the history of the old session.
- When a request does not match a registered descriptor, the service identifier shows `<unavailable>`. This stops arbitrary request content from being copied in.
- A diagnostic string that can be displayed is at most 256 UTF-16 units. When it is cut, it ends with `...[truncated]`. Internal matching of the session still uses the full identity.

> [!NOTE]
> This window is for development diagnostics. It is not a full audit log.

**Relation to persistent traces**

- Extension calls with a real turn emitter, compaction, and function service calls are also written as persistent traces, through `plugin.service.completed`.
- The trace reuses the callId, the parent call, the traceId, and the turn link. The server waits for the trace write attempt to finish before it returns.
- A failure to store the trace does not change the call result. The provider's duration does not include the time spent reading and writing the trace.
- UI background projections that have no turn emitter go only into the in-process window. They do not fake a turn.

**The `/plugins` command**

The framework's command catalog has `/plugins [pluginId]`, which opens this diagnostics view:

| Item      | Value                                                                            |
| --------- | -------------------------------------------------------------------------------- |
| ID        | `framework:plugins`                                                              |
| action    | `slash-plugins`                                                                  |
| Argument  | Optional string `pluginId`. Without an argument, it shows all installed packages |
| Execution | `POST /api/sessions/:id/plugin-rpc`, with `kind: "command"`                      |
| Result    | `result.clientAction: { type: "open-plugin-diagnostics", pluginId? }`            |

- A normal action request cannot stand in for this command context.
- The command does not trigger a player turn, and it does not call a model.
- When the Web client receives it, it opens `view=plugins` of `/debug`, keeping the current `sid` and the optional `pluginId`.
- The debug page's `view` supports `traces` / `data` / `cost` / `plugins`, and the default is `traces`. The plugin filter takes effect only in the `plugins` view.

### Session UI projections

**`GET /api/sessions/:id/ui-slots`** returns `{ items: UiSlotSnapshot[] }`, which is the value each UI slot should show now.

Optional query parameters:

| Parameter | Description                                                   |
| --------- | ------------------------------------------------------------- |
| `prefix`  | A prefix of slot names, for example `stage.`                  |
| `slot`    | One exact, supported slot name. An unknown name returns `400` |
| `key`     | An exact character ID, used for `character.visual@1`          |

Each snapshot is `{ slot, key?, value, revision }`:

- `revision` identifies the value. A client must not treat it as an ordered counter.
- When there is no cache, it is worked out on demand from the committed data.
- When a value with a key is removed, it is shown as `value: null`.

**`GET /api/sessions/:id/media/image-flow`** returns `{ flow: null | { pluginId, entryRuntimeId, assetRuntimeIds } }`. It tells the UI which plugin, and which of its runtimes, are currently responsible for generating images.

- The `media.image-flow@1` extension gives each provider 500 ms. A provider that fails is skipped.
- A runtime ID returned by a provider must belong to that provider's own plugin.

**AI world generation**

- After the manifest is written, if the ID already exists, it is given a free suffix.
- When a local validation fails, the correction request carries the previous answer and the validation error.
- When the output is cut off, or the model stream has no completion event, it reports the error at once. A broken result is not rewritten as if it were a complete package.
- The final save still runs an atomic conflict check, so a world with the same name that appears during generation is not overwritten.
- Generation, revision, and translation on one server share an admission mark through the entire SSE lifetime and cleanup. A new request receives `429 operation_in_progress` immediately while busy, without calling the model; completion or failure releases the mark.
- This mark does not block editing or deletion. Saving still takes the world operation lock and rechecks: generation cannot overwrite an existing ID, revision cannot overwrite changes made while the model ran, and translation cannot write into a deleted or replaced package.

**Locale overrides for world data**

- When translating nested object lists, the locale overrides of world data follow each source's `localeArrayKeys`.
- The preflight, import, sync, and translation endpoints all share this key-matching rule. Reordering the main list does not give a keyed translation to a different entry.
