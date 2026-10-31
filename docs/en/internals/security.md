# Security boundaries

This page explains which security boundaries the Covel server has, and why each boundary is drawn where it is. It is written for people who change the server, run a hosted instance, or want to know "what it means to approve a community plugin".

Related material is on other pages:

- Authentication rules for each route: [`../reference/api.md`](../reference/api.md#authentication-session-owner-token)
- Environment variables: [`../reference/env-registry.md`](../reference/env-registry.md)
- Desktop proxy settings: [`../reference/desktop-config.md`](../reference/desktop-config.md)
- CI cache trust boundary: [`CONTRIBUTING.en.md`](../../CONTRIBUTING.en.md). Release or explicit-commit runs can execute arbitrary source and must not save files produced by that execution into the workflow ref's caches. Trusted Node digest checks reject replacement files but do not authorize another ref to write caches.
- Remote Dagger credentials and trusted branches: [`CONTRIBUTING.en.md`](../../CONTRIBUTING.en.md#dagger-connection-check). mTLS verifies certificate possession; GitHub Environment policies control repository and branch access.
- Reporting a vulnerability: [`SECURITY.md`](../../../SECURITY.md)

Below, the "deployment tier" (`DEPLOYMENT_TIER`) comes up many times. `self` is the default. It means the desktop app, and instances that a person deploys for their own use. `demo` is the tier for public web instances, meant for the official web app, which is not supported yet. `commercial` is the strictest tier, reserved for a possible future commercial edition. There are no accounts, tenant isolation, or quotas, and this repository does not maintain it. `demo` and `commercial` both require tokens. Together they are called the hosted tiers.

## Host profile

The server decides once, at startup: it combines the deployment tier, the storage it actually uses and a few switches into a host profile (`apps/server/src/host-profile.ts`) and puts it in every request. Route permission checks, the media routes, the server settings, a request's own model settings and the trace retention all ask it, and no longer read environment variables themselves. `@covel/ai-provider` receives its own part at startup (`configureProviderHostPolicy`). The desktop app always passes `DEPLOYMENT_TIER=self` when it starts the server.

The host profile has three forms:

- **personal**: the `self` tier with data kept by the server. The desktop app, a web app someone deploys for their own use, and `pnpm dev` are all this form. Routes ask for no token; only when the desktop shell set its launch token do the config and file APIs require it. The network boundary is the loopback bind plus the Host check.
- **browser-private**: the `self` tier with `NODE_ENV=production` and a MemoryStore as the storage actually in use. Each player's data lives in their own browser, and the server holds only temporary copies. Anyone may create a session, generate a world, and list and test models with their own keys; a session needs its owner token; every other operation that reaches beyond what belongs to one player needs the operator token. The browser reaches models on a player's computer or local network through the [local model relay](#local-model-relay). Public trials use this form: for the deployment steps see [Deploy a trial on Render](../start/deploy-render.md), and for what players are told see [Play on a public trial](../start/hosted-trial.md).
- **hosted**: `demo` / `commercial`, see [Hosted auth](#hosted-auth).

Each route states which "actions" it performs, and the host profile decides how each form answers. In the table, operator means the operator token (`COVEL_DESKTOP_REST_TOKEN`), which may be sent in `Authorization: Bearer`, `X-Session-Token` or `?session_token=`; "operator (Bearer)" accepts only `Authorization: Bearer`. "Desktop token" means the token is required when `COVEL_DESKTOP_REST_TOKEN` is set, and the action is open when it is not.

<!-- prettier-ignore -->
| Action | Covers | personal | browser-private | hosted |
| --- | --- | --- | --- | --- |
| `session.access` | Reading or changing one session | Open | Owner token | Owner token |
| `session.create` | Creating a session, forking a new session from a snapshot | Open | Open | Operator |
| `session.list` | Listing every session | Open | Empty list (open with `ENABLE_DEBUG_PAGE`) | Operator, otherwise an empty list |
| `world.write` | Writing the shared world catalog | Open | Operator | Operator |
| `world.generate` | Generating, revising or translating a world with the server's models | Open | Open | Operator |
| `plugin.community` | Approving, enabling or running a community plugin's server code | Open | Operator | Operator |
| `server.diagnostics` | Model endpoints, config paths, load errors, which keys are configured | Open | Operator, otherwise these fields are left out | Operator, otherwise these fields are left out |
| `model.probe` | Listing a provider's models, testing a model | Open | Open | Operator |
| `model-db.refresh` | Downloading a new model database | Open | Operator | Operator |
| `server.settings` | Writing server settings | Desktop token | Refused | Refused |
| `host.config` | The desktop shell's settings, keys, proxy, data folder, update check | Desktop token | Operator (Bearer) | Operator (Bearer) |
| `host.files` | Installing, uninstalling and reloading packages, reading and writing raw config files | Desktop token; in production without a token, needs `COVEL_INSTALL_API_ENABLED=1` | Same | Operator (Bearer) |
| `media.cleanup` | Deleting media that no session references | Open | Operator | `demo`: operator; `commercial`: refused |
| `media.library` | The media library across sessions | Open | Refused (503) | Refused (503) |

The browser-private column opens to visitors only what they do with their own keys and saves: creating sessions, generating worlds, and listing and testing models (the settings page needs this to add a provider and test a key). Every other global operation belongs to the operator, as on the hosted tiers, each for its own reason:

- `plugin.community`: a community package's server code has no sandbox and runs in the process that every visitor's keys pass through (see [Community plugin code](#community-plugin-code)).
- `server.diagnostics`: model endpoints and config paths belong to the operator.
- `server.settings`, `host.config`: the operator sets the server settings and host configuration through environment variables.
- `media.cleanup`: the server sees only the sessions it holds a mirror of right now, so a cleanup would delete media that saves in other browsers still reference.

Besides these actions, the host profile decides:

- **Network**: only the personal form runs the Host check (`network.checkHost`). Browser-private and the hosted tiers rely on tokens: visitors can reach them directly anyway, so a DNS-rebinding page gets nothing a visitor could not get.
- **A request's own model settings**: on `self` they may change every capability of a model; on hosted tiers they may only narrow them (`credentials.capabilityOverrides`).
- **Provider requests**: in the personal form the model address the user configured may resolve to the local network (see [Self-tier exemption](#self-tier-exemption-core-provider-path-only)), and a request outside any session may use a community plugin's wire; browser-private and the hosted tiers allow neither (`credentials.provider`), because visitors are strangers to one another and a private address in a cloud network may lead to a real internal service.
- **Retention**: only in the personal form do the server settings a player stores (such as how long traces are kept) count; on browser-private and the hosted tiers they belong to the operator.

The server refuses to start in these cases, and the error names the variable:

- `DEPLOYMENT_TIER` is not one of `self`, `demo`, `commercial` (case and surrounding spaces do not count).
- A hosted tier lacks `COVEL_MEDIA_TOKEN_SECRET` or `COVEL_DESKTOP_REST_TOKEN`; `commercial` lists no `CORS_ORIGIN`.
- A hosted tier or the browser-private form sets `COVEL_ALLOWED_HOSTS`: the Host check runs only in the personal form, so the value has no effect.
- `commercial` sets `COVEL_MEDIA_CLEANUP_ENABLED`: the cleanup endpoint is always closed on that tier.

`apps/server/tests/bootstrap/route-access.test.ts` lists every API route of the server and the actions it needs. A new route fails the test until it is added to that table. The test also requests every route under a host profile that closes every action, which catches a route that decides from environment variables on its own; apart from `host-profile.ts`, no code in the server or the core packages may read these deployment variables.

The `POST /api/install/validate/plugin` and `POST /api/install/validate/world` endpoints reuse `host.files` and never import or execute package code. Directory requests resolve real paths, require containment in the corresponding allowed roots, and reject symlinked package roots. Uploads reuse installation’s ZIP path and size checks; temporary files are removed when the request ends. Reports make package paths relative and hide temporary, user and other host paths. Raw CLI errors never enter HTTP responses. World validation with the live plugin catalogue does not change process-global data conventions.

## Outbound requests (SSRF guard)

The server sends requests to model providers on the player's behalf. The SSRF protection makes sure these requests cannot be pointed at services on the internal network or on the local machine.

`validateBaseUrl()` (`packages/ai-provider/src/adapters/http.ts`, with the string checks in `adapters/http/url-safety.ts`) **allows by default**: any public `https` host can be reached, and there is no environment variable for a host allowlist. A third-party plugin author who wants to reach a custom provider host needs no configuration.

It blocks:

- RFC1918 and link-local addresses (`10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`, `fc00::`, `fe80::`);
- cloud metadata host names (`metadata.google.internal`, `metadata.internal`);
- URLs on a remote host that are not `https`, and protocols other than `http(s)`.

When a URL has an IP written directly in it (an IP literal):

- Before a transport is chosen, it is checked with the same full public-address rules that apply to DNS results.
- This rule also blocks carrier-grade NAT, benchmarking, documentation examples, unspecified, and multicast ranges. It also applies to IPv4 embedded inside IPv6.
- A literal connection never triggers a DNS lookup on the socket, so the DNS layer alone cannot stop it.
- On the `self` tier, the loopback addresses listed below keep their exception for local services.

An IPv6 address inside `2000::/3` is not enough to show that it is reachable on the public internet. The protection also rejects:

- IETF reserved and benchmarking protocol address space;
- the two documentation ranges `2001:db8::/32` and `3fff::/20`;
- the Teredo and 6to4 transition prefixes.

Specific ranges that the IETF has assigned and that really are globally reachable are still allowed. These special-purpose classifications are based on the [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).

In the personal form (the desktop app and self-deployment, the default form of the `self` tier), loopback addresses (`localhost`, `127.0.0.1`, `::1`) can be reached, and `https` is not required. This is what lets a local service such as Ollama work: the server runs on the player's own machine.

The browser-private form and the hosted tiers (`demo` / `commercial`) have no loopback exception. The reason:

- There, a player can set a model `baseUrl` in a request-level preset (`X-Slot-Config`);
- and the server's loopback address runs its own internal services.

So both the string check and the DNS check at connection time reject these three names, for every caller: core provider requests (including endpoints the operator configured in `llm.toml`) and a plugin's `fetchWithRetry`. A hosted operator who wants a model on the same machine must give it a public `https` name.

### DNS pinning

A string check alone leaves a gap for DNS rebinding between "check" and "connect": at check time the domain points to a public address, but at connect time it has been changed to an internal one.

In direct-connection mode, both kinds of request below resolve DNS through a dispatcher that "pins" the address (`adapters/http/dns-safety.ts`):

- core provider requests (`postJson` / `getJson` / `postFormData`);
- the plugin `fetchWithRetry` helper (`packages/ai-provider/src/plugin-utils.ts`; in a handler it is `ctx.utils.fetchWithRetry`, and in an entry module it is `covel.http.fetchWithRetry`).

The dispatcher's rules:

- Every A/AAAA result must be a publicly routable address.
- A loopback host name must resolve to a loopback address (only on the `self` tier; the hosted tiers reject it outright).
- The socket is pinned to the address that passed the check, and is not resolved again afterward.

No environment variable can turn this dispatcher off. Test runs replace the global `fetch` to pose as a provider. Only when the test run's own startup code (`vitest.base.ts`) sets a marker on `globalThis` (`OUTBOUND_TEST_FETCH_HOOK` in `outbound-network.ts`) does the transport hand the request to that stand-in. A server started with `NODE_ENV=test` does not have this marker, so it still uses the pinned-address transport.

### Redirects

Requests the framework makes itself follow no redirect: core provider requests, the model database download, the version check, and plugin installs from GitHub. They all go through `outboundFetch` (`packages/ai-provider/src/outbound-network.ts`), which always asks Undici for `redirect: "manual"`.

- A caller that passes `redirect: "manual"` gets the 3xx response as it is and checks each hop itself.
- Anything else (no value, `error`, `follow`) fails on a 3xx without sending a second request.

The reason is that no check looks at a `Location`: the string check sees only the first URL, an IP literal skips the pinned DNS lookup, and in a proxy mode the proxy resolves the next hop. Following a `302 Location: http://169.254.169.254/` would reach a cloud metadata service.

The plugin `fetchWithRetry` does not follow redirects either; `ctx.media.ingestUrl` follows them itself and runs the string check again on every hop. The desktop shell's loopback HTTP requests to the sidecar explicitly use `redirect: "error"`, refusing redirects to other destinations.

### Response size ceiling

An endpoint that answers a provider request may be one the player typed in, so the server does not buffer whatever amount the other side sends.

- For every response body that the framework reads from a core provider request, it counts the bytes as it reads. When the count goes over the limit, it cancels the read (`adapters/http/response.ts`, with the values in `adapters/http/constants.ts`).
- When `Content-Length` is over the limit, it fails before the first read.

These limits are security limits, not quotas, and there are no settings for them:

- JSON or text response bodies: 256 MiB. This includes model answers, error bodies, model lists, image answers with base64 images, and the model database download.
- Binary media response bodies (synthesized audio): 50 MiB, which is the default limit for a single resource when media is ingested.
- A single server-sent event in a streamed answer (the text before a blank line): 256 MiB. The total length of the stream has no limit. The request's time budget ends it.

When a response body goes over the limit, the call fails as a provider error, and the same endpoint is not retried. If a fallback model is configured, it is still tried, the same as for any answer that cannot be read.

This limit does not cover responses that a plugin reads itself:

- `fetchWithRetry` hands the `Response` straight to the plugin's code;
- a wire that a plugin implements makes its own requests;
- `ctx.media.ingestUrl` counts bytes against its own `maxBytes`.

### Runtime and HTTP client updates

Native decoder and TLS security fixes come from the runtime; the response-size limits above cannot replace them. Source and Docker deployments use at least Node 26.12.1. Provider requests and the desktop shell's sidecar requests use the separate npm Undici 8.12.2 package. The request header `Accept-Encoding: identity` does not prevent the client from decoding a Brotli response sent by the server.

Security updates may bypass the normal seven-day dependency delay, but `minimumReleaseAgeExclude` lists only specific reviewed versions. Transitive Undici dependencies are updated within their respective major lines rather than forcing every consumer onto one major.

Desktop pins Electron 45.0.0 and always starts the installer's own executable with RunAsNode for the backend. Plugins and databases still execute in a separate sidecar child process, with startup and shutdown managed through private IPC. Renderer windows disable Node integration. The installer no longer includes an extra Node runtime, and players do not need to install Node.

Electron 45 includes the public-key blocklist patch for the compromised eMudhra intermediate certificates. It links Chromium's Brotli; its [Brotli revision `cfa184a`](https://github.com/google/brotli/commit/cfa184a997ac19454d5a3ae97f6d600aac2445a6) contains [decoder fix `0ed4268`](https://github.com/google/brotli/commit/0ed4268a4401abcb4472096340477cf4af7d1a2b). These verified patches do not establish that embedded Node 24.22.0 contains every security fix in Node 24.22.1.

Core HTTP paths use npm Undici 8.12.2, URL normalization, and `dns.lookup`, reducing use of affected paths in older Node networking implementations. These measures do not replace native TLS/DNS fixes. Plugins that call native networking APIs directly, and specialized direct PostgreSQL configurations outside the core HTTP path, retain residual risk. Recheck actual dependencies and patches when adding network paths or upgrading Electron. Source and Docker deployments continue to use Node 26.12.1.

Every managed startup, restart, and recovery checks target and actual Electron/Node versions, platform and architecture, and the RunAsNode fuse. The main and preload digests are bound to target resources, and release verification reads the actual ASAR entry point and both bundles. Mismatched or mixed resources fail without environment overrides or a host-Node fallback. Child environments remove `NODE_OPTIONS`, `NODE_PATH`, and inherited Electron mode controls while retaining legitimate CA, proxy, and key settings. See [backend runtime](./desktop-packaging.md#backend-runtime).

### Desktop proxy modes

The desktop app's `system` / `http` / `socks` proxy modes send only the framework's own core provider requests and model database requests through an Undici `ProxyAgent` (`packages/ai-provider/src/outbound-network.ts`). For these trusted targets, DNS is resolved on the proxy side, in place of local address pinning.

A plugin's `fetchWithRetry` always uses the strict, direct, address-pinned path. This way third-party code cannot use the proxy's remote DNS to get around the plugin's network boundary.

### Self-tier exemption (core provider path only)

In the personal form (the desktop app and self-deployment, which only listen on loopback anyway), the direct core provider path, which is the LLM `baseUrl` the user configured, accepts any result the resolver gives for the host name. The socket is still pinned to that result.

This is needed because two common cases on a single-user machine would be blocked by a "public addresses only" rule:

- TUN proxies (Clash, mihomo, sing-box, Surge) map every domain to a private or benchmarking range, and then route by SNI;
- endpoints on the local network, such as Ollama on `192.168.x.x`.

The exemption is kept deliberately narrow. It does not apply to:

- the plugin `fetchWithRetry` path: third-party code must not probe the local network, and neither should a desktop install;
- URLs with an IP literal: the string check still blocks literal private addresses;
- the browser-private form and the hosted tiers (`demo` / `commercial`): a private address on a cloud network may lead to a real internal service.

## Provider keys

Model provider keys come from two sources, and they take two paths:

- A key that comes with a request arrives in the `X-Provider-Keys` header. The server never stores it. It lives only in that request's async context (`apps/server/src/request-llm-context.ts`), and there is no global key table. It is not written to disk, the database, a checkpoint or a log; the request log records only the method, the path and the status code.
- The one exception is a credential handed to a background job. When a turn queues a background job that runs after the response, that request's model services (including their keys) are registered in process memory (`apps/server/src/routes/api/plugin-rpc/runtime-job-credentials.ts`). The registration is bound to the job ID, the session and the session's incarnation, and no other request can overwrite it. It is dropped when a worker starts running the job, when the session is deleted, or when it expires (5 minutes by default). Without handed-over credentials, the job can run only with the models the server configured itself; if the server has no usable model, the job stays in the queue and waits.
- Keys in the server's environment variables, and platform keys, are passed to the gateway separately, as `envApiKeys`.

The provider registry (`packages/ai-provider/src/provider-registry.ts`) attaches an environment key in only one case: the origin of the resolved target `baseUrl` matches a trusted configuration (`llm.toml`, or a registered provider default).

The Web client sends only the keys of the providers its requests need:

- the provider each model role resolves to (the saved binding; when there is no binding, it is the provider the server configured for that role);
- a provider named directly in the request, for example when probing the model list.

A key for a provider that no role uses never leaves the browser. This matters when the server belongs to someone else. Until the client has read the server's roles and presets, it sends all the saved keys. (`buildProviderKeysHeader` in `apps/web/src/services/api/model-settings.ts`.)

This rule guards against this case: a request-level custom preset (an `X-Slot-Config` override) points a provider at another origin, and without protection that provider would receive the operator's key. Now such a preset cannot get environment keys, and it cannot get the trusted default headers either. It must bring its own key.

Built-in providers (`BUILTIN_PROVIDER_CONNECTIONS` in `@covel/shared`) count as registered provider defaults. An environment key named after one of them is attached only to that provider's official origin, and nowhere else. The model list request (`POST /api/ai/models`) resolves its target as a request-level target, so the same rule holds there.

A plugin cannot choose the address of a model. It only writes the name of the role it wants (`agent.model` / `function.model`). Which provider, model, address, and protocol are used is decided by the configuration of the player or the operator. An `llm.toml` in a plugin's directory is not read. So whether a plugin is bundled or community, and whether it has server code or not, its manifest and configuration files cannot make the player's keys go to an address it chose.

A model on a loopback address (`localhost`, `127.0.0.1`, `::1`) counts as ready without a key. Local services such as Ollama do not need one. This changes only the readiness check. If a key is configured it is still sent, and on the hosted tiers the outbound protection still rejects the request.

A plugin can register its own text wire (`covel.registerWires({ text })`). A wire is plugin code that sends and receives model requests for a certain protocol.

- A slot whose `protocol` names this wire receives the endpoint and key that the slot resolves to, plus the prompt and the answer of each call for that slot.
- A slot that does not name it gets nothing.
- A wire is the plugin's server code, so whether it can run is decided by the rules in [Community plugin code](#community-plugin-code).

When a request can use a given wire:

- A request that belongs to a session: only if the session has enabled a plugin that provides this wire. (The enabled set already reflects the player's approval of community plugins.)
- A request that belongs to no session (connection tests, model lists, world generation): it can use a wire from a built-in plugin. In the personal form, the one player approves all loaded plugins, so it can also use the wire of a community plugin. The browser-private form and the hosted tiers do not allow this.

Request-level presets, `llm.toml` slots, and a runtime's own slot preference all follow this rule. When it is not met, the call fails as a configuration error, and the error message says which plugin needs to be enabled.

How keys are stored on disk:

- On the desktop app, the file is `<covelHome>/keys.env`. It holds plain `KEY=VALUE` lines, with file permission `0600`, which is set again on every write (this has no effect on Windows).
- On the Web, the keys are in `localStorage` (`covel:keys`).
- Neither place is encrypted. The renderer process needs plaintext to build `X-Provider-Keys`. So even if the file were encrypted on disk, the `covel:keys:load` IPC channel (which accepts only trusted senders) would still return the same plaintext. On unsigned builds, Electron `safeStorage` would only add one more macOS Keychain prompt.

File permissions and the browser's same-origin policy keep out other system users and other websites. They cannot keep out code that runs as this same user, and that includes approved community plugins (see [Community plugin code](#community-plugin-code)).

## Local model relay

On a shared form (browser-private and the hosted tiers), the server cannot reach the player's computer or local network, so the player's browser relays requests to model addresses there. This is called the local model relay. The host profile's `credentials.modelRelay` decides whether it is offered; the personal form does not offer it, because it can reach the local machine and the local network itself. For what players are told, see [Play on a public trial](../start/hosted-trial.md#use-a-model-on-your-own-computer-or-local-network).

**Flow.**

1. When the player has added a model address on the local machine or local network, and the server reports `deployment.modelRelay` in `/api/health`, the browser opens `GET /api/model-relay/stream` (SSE) with a channel ID generated at random inside the page, and sends the same channel ID in `X-Model-Relay` with its model requests.
2. The server attaches that channel's relay to this request's `GatewayOptions` (`apps/server/src/middleware/per-request-llm.ts`). Both the agent adapter and function gateway preserve it for setup, streamed narration, and plugin calls; the gateway then copies it into every provider config. Credentials handed to a background job carry it too (see [Provider keys](#provider-keys)).
3. `postJson` / `getJson` switch to the relay only when four conditions all hold: the host is a shared form; the config carries a relay; the provider registry marks the config `relayable`, which means its address came from the player's request and no server-owned key or header is attached (a key from the server environment, or a key or header from `llm.toml`); and `baseUrl` is an address on the local machine or local network (`isLocalNetworkBaseUrl`, `packages/shared/src/utils/local-network.ts`: loopback addresses, private address ranges, `100.64.0.0/10`, IPv6 local addresses, and names ending in `.local`, `.lan`, `.internal`, `.home.arpa` or `.localhost`). All other requests still go through the SSRF checks and the pinned connection. For a relayed request, the server itself does not connect to the address. `postFormData`, which uploads files, does not use the relay.
4. The server hands the request (URL, method, headers, JSON body) to the browser through the stream. The browser answers in several POSTs: the status and response headers, body chunks, then the end or a failure (`/api/model-relay/requests/:id/*`). The server assembles them into one streaming `Response` (`apps/server/src/model-relay/registry.ts`).

**Who can use a channel.**

- The channel ID is the only credential: 32 random bytes, kept only in page memory and sent only in a request header, never in a URL, a log, a trace or a checkpoint. The server's relay object refers to it only inside a closure, so serializing a config does not carry it out.
- A request can hand model calls only to the channel it names itself; answers are accepted only for request IDs issued on that channel.
- These routes are public in the host profile (no operator or owner token check) and are protected by the channel ID. Cross-site writes are still rejected by the Origin check.

**What the browser is willing to do** (`apps/web/src/services/model-relay.ts`).

- It requests only the provider addresses the player added in this browser: the same scheme, host and port, a path under that address's path, and still an address on the local machine or local network. A request whose path contains an encoded separator (`%2F`, `%5C`, `%2E`) is refused. `http://[::1]` is refused, because the page policy can only name `127.0.0.1` and `localhost`.
- It uses only GET and POST, with `credentials: "omit"`, `redirect: "error"` and `referrerPolicy: "no-referrer"`, and drops request headers such as cookie, host, origin and referer.
- It always refuses plain http addresses on the local network: the browser's mixed-content rules do not let an HTTPS page reach them, and the page CSP opens http only for the local machine.
- A request that does not meet these conditions is only answered with a failure; it is never sent.
- Within the allowed scope, the server can send any GET or POST to this address, just as a server holding an API key can call any API of that provider. So players should write the address down to the actual API path (for example `http://localhost:11434/v1`), which keeps the model server's admin API out of scope.

**Limits.** At most 16 in-flight requests per channel; a request body of 16 MiB and an answer of 64 MiB (the network path has a higher ceiling, see [Response size ceiling](#response-size-ceiling)); each chunk is also bound by the 1 MiB request body limit; the answer's headers are awaited for at most 15 minutes; a model call waits at most 10 seconds for the channel to connect; opening a channel is rate-limited per IP like the event stream (`RATE_LIMIT_RPM`), and a process holds at most 512 channels, beyond which the server answers `503 model_relay_busy`. A channel has one stream: connecting again under the same channel ID closes the older stream and fails its in-flight requests. The server refuses a malformed status line or response header (`400 model_relay_invalid_answer`), and the browser's failure message is reduced to one line before it reaches a log.

**Multiple instances.** A channel exists only in the process that opened it. In a multi-instance deployment, a model request must reach the instance that holds the channel; otherwise it fails with the error that your browser is not connected.

**What never goes through the relay.**

- The server's own model addresses and keys: a config without the `relayable` mark still goes through the SSRF checks, so on a shared form it still cannot reach a local address, as before, and never appears in a request a player's browser receives.
- Plugin wires: the provider config handed to plugin code has the relay removed (`apps/server/src/routes/api/bootstrap/plugin-wires.ts`), so plugin code cannot reach a player's browser.
- Conclusions cached by address: the same local address is a different machine for every player, so relayed requests skip the embedding-dimension cache and the "encrypted reasoning refused" cache.

**Desktop window and the personal form.** The relay is off entirely here: the routes answer `404`, no `X-Model-Relay` is sent, the page policy gains no local http, and models on the local machine or network are still reached by the server directly.

## Desktop windows

Desktop windows enable `contextIsolation` and `sandbox`, disable `nodeIntegration`, and do not enable Node integration in subframes. Electron 45's sandboxed preload provides no Node module shims or `Buffer`; the bridge uses only Electron's sandbox APIs. `preload.ts` exposes `window.covelIpc` through `contextBridge`: app metadata, plus `invoke` and `on` restricted to allowlisted channels. Subscription callbacks do not receive the Electron event object.

Sensitive IPC, including plaintext keys, the REST token, and settings reads and writes, requires the sender to be its `webContents.mainFrame` and its URL to match the main window's committed loopback HTTP origin. Same-origin child frames are rejected too. Recovery channels (retry startup and open the logs, config, or data directory) also require the main frame, but accept the current splash document generated by the main process. The splash cannot read keys or the REST token.

`windows.ts` blocks main-frame navigation and redirects to other origins; programmatic loads of the splash or app URL by the main process are outside this event guard. `window.open` creates no new window: HTTPS and loopback HTTP links open in the system browser, other HTTP links require confirmation, and other schemes are rejected. These restrictions do not stop malicious scripts within the trusted main page or isolate approved plugin server code.

Sender checks and startup error delivery have regression tests in `apps/desktop/scripts/restart-server.test.mjs`; origin and splash URL matching tests are in `apps/desktop/src/trusted-origin.selfcheck.ts`.

## Community plugin code

Internal approval keys for server code, runtimes and events cannot be registered or requested as ordinary RPC actions. Manifest, entry registration and request validation enforce the [reserved-prefix rule](../reference/plugins.md#contributes-fields), preserving per-action consent for trusted sources.

A plugin's server-side JavaScript (`entry`, handler, guard, hook, wire) runs in the server process, and has all of the server's permissions. There is no process sandbox, no VM sandbox, and no module sandbox. Execution requires player consent or the instance's [trusted-source policy](../reference/plugin-installation.md#trusted-sources). That policy reduces server-code and runtime prompts, adds no sandbox, and cannot protect against a stolen GitHub account; signed publication metadata is not implemented:

- A write service (`access: write`) lets its provider's code change the provider's own data within another plugin's turn. The capability snapshot records it as `<contract> (write)`, so a trusted-source package that adds a write service or turns a service into one prompts again (see [Capability snapshot](../reference/plugin-installation.md#capability-snapshot)). Its writes go through PreStateCommit, dataset rules and the commit with the provider's identity, and a write service gets no model or HTTP access. Raw staged values stay in the kernel's commit plan; every result returned through `ctx.recursiveCall`, including flattened descendants, omits `operationWrites`, so the caller learns those values only through the service's declared output.
- The accepted v1 boundary requires trusting local writers to the plugin directory. Anyone able to write that directory can replace package files and forge the source, digest and capability snapshot in `.covel-install.json`. Integrity verification does not defend against local filesystem writes.
- Manifest loading, installation, validation, and localization share one plain YAML reader that rejects engine directives such as `---js` before parsing.
- Before approval, a `community` package is just data. Installing, previewing, listing, and validating only parse its files. Nothing is imported. The two-step approval (first `covel:plugin-server-code`, then the specific operations; see [Hosted auth](#hosted-auth)) guards the first import.
- After approval, this code can do anything the server process can do: read and write files that the server's system user can access (`keys.env`, `llm.toml`, the SQLite file), read `process.env`, open sockets, and start processes.
- `permissions.http` is an allowlist on the plugin API. Every framework request channel of a community package is checked against it (`packages/runtime/src/function-runtime/http-permissions.ts`):
  - A runtime's `ctx.utils.fetchWithRetry`, `ctx.media.ingestUrl`, and the media bindings built on them are checked against that runtime's declaration.
  - `covel.http` of the `entry` module (used by tools, hooks, RPC, form validators, services, extensions and wires) is checked against the declaration of the whole package: the `permissions.http` of the root `PLUGIN.md` plus those of every runtime (`apps/server/src/routes/api/bootstrap/entry-http.ts`).
  - The `context.utils` that a service or extension handler receives is replaced by the check of the provider's own package. It does not borrow the caller's.
  - While a wire serves a slot, it may also reach the endpoint configured for that slot. The player sets that address; the plugin does not declare it.
  - Builtin packages are not checked, as for runtimes. The SSRF check runs for every package.
- This allowlist stops a package from reaching an origin it did not declare through this API. It cannot stop code that calls the global `fetch` or `node:https` directly.
- A media wire a plugin registers carries that plugin, like a text wire: in a session it can be chosen only when the plugin is enabled there; a request that belongs to no session can choose only a builtin plugin's wire, and on the `self` tier a community plugin's as well.
- `framework` is a reserved ID that no package can take. A request with `pluginId: "framework"` runs only a framework default action, so the route's trust decision and the handler that runs are the same one.
- The bound session store view, the lookup of tools by plugin, and the proposal pipeline are also permission boundaries of the plugin API, and they have the same limit.
- A read service's `ctx.pluginData` is bound to the session and provider plugin, filters `_hidden.*`, and returns separate copies. `world` copies the caller's view, and `getOwnSettings()` reads only provider settings. Services receive no write methods or proposal channel; see the [service context](../reference/plugin-extensions.md#what-a-service-can-and-cannot-access).

`ctx.gateway.resolveSlot()` is the same kind of boundary.

- Whatever slot name is asked for, it returns that slot's or preset's `apiKey` and auth headers. A plugin that implements its own wire (`registerWires`) needs these to call its provider.
- A plugin manifest mentions slots only through `type: slot` settings. The value of a setting is the player's choice at run time, so no static list exists that could be used to restrict it.
- A package that cannot read the key from `resolveSlot` can still read it from its own wire's `config`, or from the process it runs in.
- So a per-slot check on this one method would look like isolation but would not be, and that is why there is no such check.
- A service call made on behalf of another plugin never carries key material (`lendGateway` in `packages/runtime/src/plugin-services.ts`).

> [!IMPORTANT]
> Approve a community package only if you are willing to give your provider keys to its author.

So approving a community package amounts to entrusting the operating system account that runs the server to its author. The install dialog and the authorization dialog both say that this code runs without a process sandbox.

Two simpler approaches were considered and not adopted. The reason is the same for both: they look like isolation, but they are not.

- Scanning the package's JavaScript for `node:` imports, `process.env`, or `eval`. This can be bypassed by splitting a name into two strings and joining them, and a "scan passed" result gets mistaken for an audit.
- Using `worker_threads` with a module loader that filters `import` specifiers. This isolates nothing: a worker has the process's file and network access, and it can reach built-in modules through `process.getBuiltinModule` without any `import`.

Real isolation needs a separate operating system process with limited permissions, or an isolate, plus a plugin API that crosses the boundary through messages. This change must be made before community packages are distributed to players who cannot judge whether an author can be trusted.

## Hosted auth

The `demo` and `commercial` tiers enforce two kinds of token:

- One **owner token** per session. It is generated when the session is created, is stored only as a hash in `SessionRecord.metadata`, and is returned only once. Every session-level route requires it.
- One **operator token** (`COVEL_DESKTOP_REST_TOKEN`). It is a master key, and it passes every owner check. Global and admin routes require it: creating, forking and listing sessions, writing worlds, AI and model routes, and enabling community server code. A fork makes a new session, so it asks the same question as creating one: the owner token alone cannot fork.

If the hosted tiers lack an operator token or a media key, the server refuses to start. `commercial` also requires an explicit list of CORS origins (see [Host profile](#host-profile)). The desktop app and personal self-hosted `self` instances (the personal form) do not check session owner tokens. The browser-private form still checks them.

The personal form trusts other processes on the same machine. Loopback listening and Host and Origin checks limit access from the local network and web pages, but cannot distinguish other local programs. Those programs can call token-free `/api/*` endpoints just as the desktop window does. When `COVEL_DESKTOP_REST_TOKEN` is set, routes that write server settings, access desktop configuration and keys, install or reload packages, or read and write raw config files still require the launch token in `Authorization: Bearer`. The [Host profile](#host-profile) rules `server.settings`, `host.config`, and `host.files` define the scope.

The import of community server code (`entry`, handlers, hooks, wires, runtime JavaScript) is guarded by two-step approval: first `covel:plugin-server-code` is granted, then the specific operations.

Sensitive desktop configuration reads and writes require the launch token when one is configured, including `GET /api/config/keys`, which returns only provider names. The public model catalogs (`/api/presets`, `/api/llm-config`) of the browser-private form and the hosted tiers omit `baseUrl` to avoid exposing private gateway addresses and credentials in URLs; operator-token holders can still read the addresses.

### Server settings

A few player settings must be enforced by the server (for example, how long traces are kept). So the server stores them in its own database, and the browser writes them through `PUT /api/config/server-settings`.

This is a second door, narrower than the few desktop-only endpoints. `/api/config/settings`, `/api/config/keys`, `/api/config/proxy`, and `/api/config/data-root` still need `COVEL_DESKTOP_REST=1` to be open. An ordinary self-hosted Web deployment cannot write files, keys, proxy settings, or paths.

- **Who can write.** Only the personal form, the one form where the only player owns the server. When the desktop shell has set a bearer token, that token is also required. In the browser-private form and on `demo` / `commercial`, a write is rejected before the token is even checked, and the operator token does not change that. There, the values belong to the operator and come from environment variables. In the personal form, an environment variable also takes priority over a stored value.
- **What can be written.** Only the keys listed in `SERVER_SETTINGS` (`packages/shared/src/env/server-settings.ts`), and each value must be accepted by that key's schema. This list is closed and values are schema-validated. `trust.sources` lists GitHub owners or repository names and is overridden by `COVEL_TRUSTED_SOURCES`; it accepts no arbitrary URLs, paths or credentials. If an unknown key appears, the whole request is rejected.
- **What can be read.** `GET /api/config/server-settings` is public on every tier, and returns only the effective values of these keys. Do not add a setting whose effective value must stay secret.
- **Who can reach it.** The origin check on writes (`origin_not_allowed`) applies here as it does to any other `PUT`. A `self` server that other people can reach lets them change these settings, the same as it lets them use every other route. A `self` server should be exposed only to its owner.

## Translations from outside a package

`$COVEL_HOME/translations` (`COVEL_USER_TRANSLATIONS_DIR`) holds plugin translations that do not come with a plugin: translation packs that the user copied in, and machine translations made on this machine. The loader reads them as data:

- It reads only labels and `messages`. Prompt bodies (`*.zh.md`) are read only from the plugin package, so a translation cannot change the instructions.
- A label section keeps only the label fields (`displayName`, `description`, `label`, `title`, `summary`, `about`), and the rest is discarded. A plugin's own locale files are handled the same way.
- When the same text is translated on both sides, the author's translation wins.
- Symbolic links are not followed, and only regular files are read.

In one case these texts are still read by the model: `messages` entries translate text that plugin code writes into state or context. This puts translation packs and the setting text of world packs in the same class of input. For this reason, the directory is a local path controlled by the operator, and there is no install interface for it.

## Package credits and author links

A plugin, world, or collection can state its author, license, and homepage. The author can also add a short note and up to six labeled links (`author`, `license`, `homepage`; for the fields, see [`docs/reference/plugins.md`](../reference/plugins.md#author-information)). This is text written by the person who made the package, and it is shown to players who have not started playing yet. The limits on it:

- **Display only.** The host makes no decisions based on these fields. The world view that prompt templates read does not include them, so the author's note does not reach the model.
- **Plain text.** The note and the labels are rendered as text: no Markdown, no HTML, no images. So a package cannot make the client request remote resources when it shows the card.
- **Only `https` links.** The manifest schema rejects other protocols (`http:`, `javascript:`, `file:`), and it also rejects addresses with a user name or password, because those can be used to hide the real host.
- **The player opens a link, and sees a warning first.** On click, the full address and its host are shown, with a note that the link comes from the package's author and that Covel has not checked the site. The link opens in the system browser only after the player confirms. The host name is shown in ASCII, so a name faked with other characters appears as `xn--…`.
- **Shown only before play.** Author information appears on world cards, world pages, the session-prep screen, and the installed package list. The play screen does not show it. The install preview shows only the author's name, not the links.

## Page policy and external images

The built main page has a `Content-Security-Policy` meta tag (`apps/web/src/lib/page-csp.ts`, injected by the Vite build; development relaxes script and connection sources for Vite while retaining the same CSS resource restrictions):

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self' blob: data: https:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

What each part means:

- **Scripts** can only be the application's own files. There are no inline scripts, no inline event handlers, no `eval`, and no remote scripts. The built page has only one external module script and no inline content. (Zod is configured not to probe `eval`; see `apps/web/src/lib/zod-config.ts`.)
- **Frames** are limited to the same origin. Plugin UI uses the frame host or multi-file pages described below; theme contrast checks also use a temporary frame without scripts.
- `connect-src` allows the same origin, `blob:`, `data:` and `https:`. Application JavaScript downloads player-imported images over HTTPS; CSS image and font requests do not use this directive. A server in a shared form adds the local machine's `http://127.0.0.1:*` and `http://localhost:*` when it serves the page, for the [local model relay](#local-model-relay) (`withLocalModelRelayConnect`, `packages/shared/src/utils/page-policy.ts`). The built page, the personal form and the desktop window do not have these two, and the whole of `http:` is never opened.
- There are no browser plugins (`object-src 'none'`).
- `base-uri` and `form-action` are fixed to the same origin.
- `style-src` keeps `'unsafe-inline'`: React's `style` attributes, rules that the theme system injects, and imported theme CSS all need it. Removing it is a separate piece of work.
- Styles and fonts cannot request external hosts; images are limited to the same origin, `data:` and `blob:`. `default-src` also limits unspecified resource types to the same origin.

Theme CSS is untrusted content. Themes share the settings document, and CSP does not prevent them from changing or obscuring the interface. Saved API keys and operator tokens never populate inputs. New drafts use only the DOM `value` JavaScript property, never the HTML attribute that CSS selectors can read. Show reveals only the new draft, which clears after replacement; Clear removes the saved value. See [theme packages](../reference/theme-packages.md) for background downloads and format limits.

`tests/e2e/page-policy.spec.ts` loads the main screens of the built application and a session with a plugin panel, and fails if any `securitypolicyviolation` event appears.

### Plugin HTML

The following two-frame arrangement describes single-file HTML. Multi-file views use the direct URL arrangement below.

A plugin's `webview` HTML runs in a browser sandbox. It must never reach the origin the application runs on: the settings and provider keys in `localStorage`, the cookies, and the API with the player's session token. It runs in a second-level frame, below the application page.

1. **The frame host** is `/plugin-frame.html`, a static file in the Web build (`apps/web/public/plugin-frame.html`). It is the same for every plugin and every session.

   - The application embeds it with `sandbox="allow-scripts"` (and no `allow-same-origin`), so it has an opaque origin.
   - It is loaded by URL, not through `srcdoc` or `blob:`. The reason: a frame created with `srcdoc`, `blob:`, or `data:` inherits the policy of the page that created it, which would force the application page to allow inline scripts. A document loaded by URL is bound only by the policy in its own response.

   Its policy is written in a `<meta>` tag in the file:

   ```
   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'
   ```

   The Covel server also sends the same policy as a response header, plus `sandbox allow-scripts; frame-ancestors 'self'` (`apps/server/src/middleware/plugin-frame-headers.ts`). This way, even if someone opens its address directly, the document has an opaque origin, and other websites cannot embed it. Static hosting that does not send these headers still has the `<meta>` policy and the frame's `sandbox` attribute.

2. **The plugin document** is a `srcdoc` frame created by the frame host, also with `sandbox="allow-scripts"`. It inherits the frame host's policy:

   - inline scripts and styles can run;
   - nothing can be loaded from the network;
   - `frame-src 'none'` on the frame host stops the plugin document from navigating itself to a network address. (A document's own policy cannot stop its own navigation; the parent document's `frame-src` can.)

The plugin's HTML is not passed by URL. The application already holds it (`GET /api/ui-specs`, with that route's session authentication), and then sends it, together with the bridge port, to the frame host. So:

- `/plugin-frame.html` does not accept a plugin name, session name, or file name, so it cannot be used to read files of another plugin or another session.
- This file is part of the build. The desktop app (which serves the page from its loopback sidecar), the browser-private setup, and offline use need nothing else, and a self-hoster does not have to configure a second origin.
- A separate real origin (another port or subdomain) would give no more isolation than the opaque origin here, but it would make every self-hoster configure an extra listening port, DNS name, or proxy rule.

**The bridge** (`apps/web/src/components/session/plugin-bridge.ts`). There is only one message channel between the application and the plugin document:

- The application does not listen for any window `message` events.
- For each frame element it creates a `MessageChannel`, and hands one end to that frame's `contentWindow`. The frame host passes it to the plugin document once. After that, no document loaded at any frame level can get the port.
- Anything received on the port is untrusted input, and it is parsed with Zod. A request must name an operation that the host provides for that panel (already bound to the owning plugin), plus a plain argument object. Anything else is either dropped or answered with a fixed failure text.
- Handler errors are never passed back, so server errors, or any credentials inside them, stay in the application.
- The bridge carries only the plugin's own data, the language, the lock state, the panel context, and the theme.
- It does not carry the session token or any provider key. Plugin HTML has no way to call the API except through the operations the host provides.

The application ships its own fonts (`@fontsource-variable/*`, SIL OFL 1.1), and at startup it sends no requests to any font host.

**Markdown images.** Story text and world documents are rendered by the same component (`apps/web/src/components/ui/markdown.tsx`).

- Images that the application provides itself (same origin, the media library, `data:`, and `blob:`) load immediately.
- Images on other origins are not requested. The player sees a placeholder with the host name, and two options: "Load this image" and "Always load images from {host} in this world". The second choice is saved per world, in the `media.allowedImageHosts` setting.
- This has two purposes: a model cannot push text from the conversation out in an image URL, and a host the player has not seen does not get the player's address.
- Once allowed, external images are downloaded by JavaScript and displayed as embedded data; external URLs never reach `<img>`. Only HTTPS raster images with CORS support are accepted, with the same limits as theme images; failures show a placeholder. Requests send no credentials or referrer.
- Plugin webviews and json-render panels are not Markdown, and they have their own rules.

### Plugin pages loaded by URL

A multi-file view loads directly from `/plugin-assets/<pluginId>/<digest>/<entry>` into one `sandbox="allow-scripts"` iframe. It has no `srcdoc` or outer host. The [page contract](../reference/ui-panels.md#multi-file-pages) defines its CSP, file types and limits.

<!-- prettier-ignore -->
| Threat | Boundary |
| --- | --- |
| Reading app storage, cookies or preload APIs | Opaque origin, without `allow-same-origin`; the frame receives no Electron IPC or provider credentials |
| Network, nested frames, forms, base changes and inline code | Response CSP blocks connections, frames, forms, base URLs, objects, inline scripts and eval; classic same-origin scripts, styles and images can load; custom fonts use embedded data: URIs because relative font URLs fail without CORS permission for the opaque origin |
| Reading package files or escaping the root | Realpath containment at indexing; lstat omits links and junctions; the route serves only listed files and checks O_NOFOLLOW, regular-file status, indexed size and realpath again |
| Running a directly opened SVG | Non-entry responses use `Content-Security-Policy: sandbox` |
| API calls from opaque documents | Every `/api` method rejects `Origin: null` before CORS with `foreign_request_refused` |
| API self-navigation without Origin | `Sec-Fetch-Dest: iframe`, `frame`, `embed` and `object` are refused on `/api`; no Sec-Fetch-Site heuristic |
| Navigation and port reuse | The main page's `frame-src 'self'` blocks other origins; same-origin navigation remains possible, but gets no second bridge port and `/api` is separately guarded |
| Content changes and session reads | URL digest covers every published file; consent remains plugin ID + capability + whole-spec hash through SettingsStore |
| Missing, stale or failed pages | 8-second ready handshake, credential-free HEAD probe and Retry overlay; host back controls remain available |

`script-src 'self'` deliberately uses the browser-visible origin rather than an absolute path source: the server cannot infer that origin behind Vite or a reverse proxy. A page can load other same-origin public static files, including another plugin's published assets or app scripts, but still cannot read app storage, use the API or make connections. Authors must keep secrets and server code out of the published root. Public delivery needs no cookies, token, second origin or media-token exception. The asset route omits CORP because an opaque-origin page must load its own classic subresources. It also omits CORS allow headers; font requests require CORS, so custom fonts must use embedded `data:` URIs. Entry HTML revalidates on every reuse with an ETag that includes the host bridge hash, allowing host upgrades to refresh the injected script address. The bridge source is shared with single-file views and injected by the host; it adds no write capability.

## Other server guards

**Import from the desktop menu.** Imports from the desktop menu open the shared package installer, and use the same server-side validation, archive limits, and trust flow as imports on the Web. The older native IPC channels that copied a directory or ZIP straight into the resource directory are no longer open.

**When a hook fails.**

- A hook with no return value means "continue".
- When a rewriting hook fails, the rewrites that succeeded earlier are kept.
- An exception or timeout in a security guard is still handled as "deny" (fail-closed). If every hook failure were treated as "continue", approval and commit guards could be bypassed.
- The trace of a rewrite records only a summary of which keys were changed. It does not record the full prompt from before and after the rewrite.

**Session writes.** Session changes, player actions, resuming suspensions, and action RPCs all share the live-session guard in `routes/api/session/locked-mutation.ts`.

- While holding the session lock and before writing, they check again: whether the session exists, owner authorization, the immutable session incarnation, the deletion mark, and the states the caller allows.
- If an operation's SSE response is already open, a rejection is reported through `error.occurred`. The machine-readable error code is the same as for the JSON guard.
- Background runtime jobs that run apart from the main flow keep their own admission lock and commit lock.

**Subscription content.** An SSE connection admits events only from the session incarnation that passed owner authorization. Replay state is allocated only after that authorization. Producers capture the incarnation before async work; deletion controls bypass topic filters, and cross-origin reordering cannot deliver another incarnation to the old connection. See the [protocol](../reference/protocol.md) for handshake and reconnect rules.

**Plugin data management.** Whether a plugin is enabled by default is not a data ownership boundary. Admin tools and scripts follow the same [plugin data write rules](../reference/api.md#plugin-data) for every plugin; `kind: core` provides no extra protection.

**Reading execution state.** `GET /api/sessions/:id/execution` binds the session incarnation that passed owner authorization to the existing read barrier on the response side.

- If, while the query is running, the session disappears, or it was rebuilt with the same public ID, the response is replaced with `409 session_incarnation_changed`. The retry input of the new session is never returned to the old request.
- This check does not wait for a long-running session operation to release its lock.

<!-- prettier-ignore -->
| Guard | Behavior | Code |
| --- | --- | --- |
| Bind address | Listens on `127.0.0.1` by default. Set `COVEL_BIND_HOST` to change it to `0.0.0.0` | `apps/server/src/app.ts` |
| Host name | In the personal form (the default form of the `self` tier: the desktop app, self-deployment, `pnpm dev`), the host name in the `Host` request header must be `localhost`, `127.0.0.1`, `[::1]`, or listed in `COVEL_ALLOWED_HOSTS`. Otherwise every method is rejected with `403 host_not_allowed` before it reaches any route or static file. Listening on loopback limits who can connect, not which name a browser connects by: with DNS rebinding an attacker points their own domain at `127.0.0.1`, the browser treats the local server as that page's own origin, and CORS and the write-origin check both let it through, but the request's `Host` is still the attacker's domain. The port is not compared. A request with no `Host` does not come from a browser, and it is allowed. The browser-private form and the `demo` / `commercial` tiers use their own authentication policy and skip this check. To open a self-hosted web app from other machines, list its domain or address in `COVEL_ALLOWED_HOSTS` | `apps/server/src/middleware/host-guard.ts` |
| Signed media URLs | The URLs of `MediaRef` are signed with `COVEL_MEDIA_TOKEN_SECRET`. The desktop shell must provide this key, or images will not load. The Web uses a key generated at each start | `apps/server/src/middleware/media-token.ts` |
| Media library | `GET /api/media/library` and `POST /api/media/library/delete` list and delete all stored resources without naming a session. The list also issues signed URLs scoped to `media-library:`, which can read any resource. They exist only where one player owns the whole store (`self`, the desktop app). On `demo`, `commercial`, and the browser-private setup, they answer `503`, and this scope is rejected too, whether or not an operator token is sent, because the store has no media index divided by owner | `apps/server/src/routes/api/media-library.ts` |
| Session IDs | `{worldId}-{uuid8}`, from `crypto.randomUUID()`. Hard to enumerate | session routes |
| World IDs | Allowlist `/^[a-z0-9_-]{1,64}$/i` | world routes |
| World reads | `GET /api/worlds` and `GET /api/worlds/:id` require no identity on any tier. Anyone who can reach the server can read every world record, including the characters, lore, and contract data embedded in stored (generated) worlds, and content the author marked as hidden. Writes are guarded, and reads are not. A hosted deployment that cannot show this content to every visitor must put the server behind its own access control | `apps/server/src/routes/api/worlds/crud.ts` |
| World gallery | `GET /api/worlds/:id/gallery*` serves the images in a world package without a session. Anyone who can list the world can reach them. The request gives the two parts of a file address. It answers only when the gallery list itself contains this file: a bitmap (PNG, JPEG, WebP, never SVG) listed by the package's `media/gallery.json` and not later than the opening scene. When there is no such file, it answers for a file directly inside a public `kind: media` source. Paths are resolved inside the package, and symbolic links are refused. Sources with `enabled: false` or `visibility: hidden` are not served. The only audio file it serves is the `.mp3` / `.wav` named by `themeMusic` in `world.yaml`, under the same path rules | `apps/server/src/world-data/gallery.ts` |
| Write origin | CORS can only stop a page from reading the response. "Simple" cross-site requests (form submissions, `fetch` with `text/plain`) still run the handler. A `POST` / `PUT` / `PATCH` / `DELETE` that carries an `Origin` is rejected with `403 origin_not_allowed` before it enters any route, unless the origin is on the CORS allowlist, or its host is the host the request was sent to (`Host`, or `X-Forwarded-Host` behind a proxy). A request with no `Origin` is a non-browser client, and it is allowed. This is not authentication; the Host name check above stops DNS rebinding. Before CORS, all methods on `/api` and `/api/*` reject trimmed case-insensitive `Origin: null` or embedded destinations (`iframe`, `frame`, `embed`, `object`) with `403 foreign_request_refused`, without CORS allow headers. The guard does not inspect Sec-Fetch-Site and does not cover plugin asset/frame routes. | `apps/server/src/middleware/origin-guard.ts` and `apps/server/src/middleware/foreign-request-guard.ts` |
| Rate limiting | `rateLimiter()` and `singleFlight()`. `RATE_LIMIT_RPM` sets only the quota of `GET /api/events/stream` (per IP per minute, default 60); other routes have their quotas written into each route, for example 10 for media upload, 30 for `POST /api/actions`, and 120 for reading session state (per minute). Each client address has one quota for each concrete path, and a second quota for each route template (`/api/sessions/:id/state`), which is eight times the first. This gives each session its own quota, while rotating path parameters runs into the larger one. The counter table keeps at most 10,000 entries, and evicts the entries with the oldest time window first | `apps/server/src/middleware/rate-limit.ts` |
| Raw config files | `GET` / `PUT /api/config/raw*` read and write `llm.toml` as text (and `config.toml` in desktop mode). They share the install guard: the hosted tiers require the operator token, the desktop shell requires the desktop token, and production requires `COVEL_INSTALL_API_ENABLED=1`. The file names come from a fixed list, never from a path in the request. `keys.env` is not on the list. Text is written only after the server's own parser accepts it. Parse and validation errors for `llm.toml` give the line, the column and the key, never a value substituted for `${VAR}`, so the refusal, the log and the Settings page cannot carry a secret | `apps/server/src/routes/raw-config-api.ts` |
| Error sanitization | In production, `app.onError` returns `"Internal server error"`. Stack traces and paths go only to `console.error`. In development, it returns `err.message` | `routes/api/bootstrap.ts`, `app.ts` |

**Error messages in failure responses.** When a suspension fails to resume, or a snapshot or branch fails unexpectedly, the error goes through the standard error classifier (`apps/server/src/api-error.ts`, `routes/api/resume.ts`, `routes/api/snapshots.ts`) after the necessary cleanup is done.

- The response for a failed resume does not return runtime results. It says only whether the runtime itself failed or the commit failed. The text is the same as the text a turn reports to the player through `runtime.failed`. Any other exception is a generic 500 in production.
- A known "media reference failed while branching" keeps its error code, with a fixed safe message.
- A world translation stream that is already open (`routes/api/worlds/translate.ts`) uses the same sanitized error content, and does not change its HTTP status. The reasons a translation is rejected are reported (no translation, the reply is not JSON, a placeholder was changed). Unexpected storage or provider errors are not reported.
- The causes are all recorded in the server log.
- These changes do not mean that every trace, game content, or log output has been sanitized.

A `bridge: session` view in `contributes.ui.view` can additionally read a validated, bounded session projection with hidden keys removed. Mounting requires explicit player consent for the capability, bound to the plugin ID and the content hash of the spec plus HTML, regardless of source. A world default cannot bypass consent. SettingsStore saves consent on this device; the view bar menu can revoke it. This read capability adds no page write API. See [Plugin views](../reference/ui-panels.md#plugin-views) for scope and limits.

## Importing third-party content: data conversion only

SillyTavern content import uses bounded PNG chunk walking (including remaining-length checks before reading data), bounded JSON with Zod validation, fixed output paths, text sanitizing and fixed macro substitutions. PNG cover files have text and other metadata removed. No extension, script, card regex or executable macro runs. Unsupported fields and conversion losses are reported. Preview writes nothing; import uses the ZIP world's existing validation and activation under the world lock, guarded by `host.files` and `world.write`. Sanitizing does not make prompts trustworthy: lore and narration notes enter model context at the same trust level as other third-party world packages. See [the import guide](../worlds/import-sillytavern.md).

## Character perspective and private delegation

Witnessed history and name-addressed calls are bounded context capabilities, not security isolation for approved server code. This helper reads committed presence-bearing stories only for characters in the current world. Existing tool/service approvals and read permissions remain unchanged. Callers remain responsible for their brief and instruction.

Delegation privacy uses kernel-recorded provider and call identity to project streams, persisted traces, parent tool records and trace copies of later requests. It trusts neither plugin-supplied redaction flags nor global key-name deletion. The actual parent model still uses intent. Settings routes retain host-profile, session-owner, settle and lock checks; choosing a service grants no execution permission. See [protocol](../reference/protocol.md#private-delegation-projections).
