# Security Boundaries

This page explains the server's security boundaries and why each one is drawn
where it is. Route-level auth contracts live in
[`../reference/api.md`](../reference/api.md#鉴权session-owner-token); environment
variables live in [`../guide/env-registry.md`](../guide/env-registry.md); desktop
proxy settings live in [`../guide/desktop-config.md`](../guide/desktop-config.md).
To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md).

## Outbound requests (SSRF guard)

`validateBaseUrl()` (`packages/ai-provider/src/adapters/http.ts`, string checks in
`adapters/http/url-safety.ts`) is **open by default**: any public `https` host is
allowed, and there is no host allowlist environment variable. Third-party plugin
authors targeting custom provider hosts need no configuration.

It blocks:

- RFC1918 / link-local addresses (`10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`,
  `fc00::`, `fe80::`);
- cloud metadata hostnames (`metadata.google.internal`, `metadata.internal`);
- non-`https` URLs on remote hosts, and non-`http(s)` protocols.

IP literals are checked against the same complete public-address policy as DNS
answers before transport selection. This also blocks carrier-grade NAT,
benchmark, documentation, unspecified and multicast ranges, and applies to
IPv4 embedded in IPv6. Literal connections do not invoke socket DNS lookup;
they cannot rely on the DNS dispatcher alone. On the `self` tier the explicit
loopback targets below retain their local-server exception.

IPv6's `2000::/3` allocation is insufficient to establish public reachability.
The guard also rejects reserved/benchmark IETF protocol space, both `2001:db8::/32`
and `3fff::/20` documentation ranges, and Teredo/6to4 transition prefixes.
Specific globally reachable IETF allocations remain allowed. The special-purpose
classifications follow the [IANA IPv6 registry](https://www.iana.org/assignments/iana-ipv6-special-registry/).

On the `self` tier (desktop and self-deploy, the default), loopback
(`localhost`, `127.0.0.1`, `::1`) is allowed and bypasses the `https`
requirement, so local servers such as Ollama work: the server is the player's
own machine.

Hosted tiers (`demo` / `commercial`) have no loopback exception. There a player
can name a model `baseUrl` in a request-scoped preset (`X-Slot-Config`), and the
server's loopback holds its own internal services. Both checks reject the three
names — the string check and the connect-time DNS check — for every caller:
core provider requests, operator `llm.toml` endpoints included, and plugin
`fetchWithRetry`. A hosted operator reaches a model on the same host through a
public `https` name.

### DNS pinning

A string check alone leaves a DNS-rebinding gap between validation and connect.
In direct mode, the core provider requests (`postJson` / `getJson` /
`postFormData`) and the plugin `fetchWithRetry` helper
(`packages/ai-provider/src/plugin-utils.ts`; exposed as `ctx.utils.fetchWithRetry`
to handlers and `covel.http.fetchWithRetry` to entry modules) resolve DNS through
a pinning dispatcher (`adapters/http/dns-safety.ts`). Every A/AAAA answer must be
publicly routable, loopback hostnames must resolve to loopback (`self` tier only;
on a hosted tier they are rejected), and the socket is pinned to the validated
answer.

### Response size ceiling

The endpoint that answers a provider request can be one a player named, so the
server does not buffer whatever it sends. Every body the framework reads from a
core provider request is counted while it is read, and the read is cancelled
when the count passes a ceiling (`adapters/http/response.ts`, values in
`adapters/http/constants.ts`); a `Content-Length` above the ceiling fails before
the first read. The ceilings are safety limits, not quotas, and there is no
setting for them:

- a JSON or text body — model answers, error bodies, model lists, image answers
  with base64 images, the model database download: 256 MiB;
- a binary media body (synthesized audio): 50 MiB, the default limit of media
  ingest for one asset;
- one server-sent event of a streamed answer (the text before its blank line):
  256 MiB. A stream has no limit on its total length; the request budget ends it.

A body over the ceiling fails the call as a provider error that is not retried
against the same endpoint; a configured backup model is still tried, as after
any unreadable answer.
The limit does not cover a response a plugin reads itself: `fetchWithRetry` hands
the `Response` to plugin code, and a plugin's own wire does its own request.
`ctx.media.ingestUrl` counts bytes against its `maxBytes`.

### Desktop proxy modes

Desktop `system` / `http` / `socks` proxy modes route only framework-owned core
provider and model-database requests through an Undici `ProxyAgent`
(`packages/ai-provider/src/outbound-network.ts`). Proxy-side DNS replaces local
pinning for those trusted targets. Plugin `fetchWithRetry` always stays on the
strict, direct, pinned path so third-party code cannot use a proxy's remote DNS to
bypass the plugin network boundary.

### Self-tier exemption (core provider path only)

On the `self` tier (desktop and self-deploy default, already bound to loopback),
the direct core provider path — the user's own configured LLM `baseUrl` — accepts
any resolver answer for a hostname; the socket is still pinned to that answer.
Single-user machines commonly run TUN proxies (Clash, mihomo, sing-box, Surge)
that map every domain into a private or benchmark range and route by SNI, and LAN
endpoints such as Ollama at `192.168.x.x`. The public-only rule rejected those
legitimate setups.

The exemption is deliberately narrow. It does not apply to:

- the plugin `fetchWithRetry` path — third-party code must not probe the local
  network, even on a desktop install;
- IP-literal URLs — the string check still blocks private literals;
- hosted tiers (`demo` / `commercial`) — a cloud network's private answers can
  reach real internal services.

## Provider keys

Request-supplied keys arrive through the `X-Provider-Keys` header and are never
persisted server-side. Server-environment and platform keys reach the gateway
separately as `envApiKeys`. The provider registry
(`packages/ai-provider/src/provider-registry.ts`) attaches an environment key only
when the resolved target's `baseUrl` origin matches trusted configuration
(`llm.toml` or registered provider defaults).

The web client sends only the keys of providers its requests can reach: the
provider each model role resolves to (the saved binding, otherwise the
server's own provider for that role) plus a provider a request names directly,
such as a model-list probe. A key for a provider no role uses never leaves the
browser, which matters when the server belongs to someone else. Until the
client has read the server's roles and presets it sends every saved key.
(`buildProviderKeysHeader` in `apps/web/src/services/api/model-settings.ts`.)

Failure mode this prevents: a request-scoped custom preset (`X-Slot-Config`
overlay) that redirects a provider to another origin would otherwise receive the
operator's key. Such a preset gets no environment key and no trusted default
headers; it must supply its own key.

The built-in providers (`BUILTIN_PROVIDER_CONNECTIONS` in `@covel/shared`) are
registered provider defaults: an environment key named for one of them attaches
to that provider's official origin and to no other. The model list request
(`POST /api/ai/models`) resolves its target as request-scoped, so the same rule
holds there.

A model on a loopback address (`localhost`, `127.0.0.1`, `::1`) is ready
without a key: local services such as Ollama take none. This changes only the
readiness check; a key that is configured is still sent, and on a hosted tier
the outbound guard still rejects the request.

A text wire a plugin registers (`covel.registerWires({ text })`) receives the
resolved endpoint and key of each slot whose `protocol` names it, and the
prompts and answers of that slot's calls. A slot that does not name the wire
gives it nothing. The wire is plugin server code, so the rules of
[Community plugin code](#community-plugin-code) decide whether it runs.
A request may select the wire only when its session has the providing plugin
active (the active set already reflects the player's approval of a community
plugin). A request with no session (connection test, model list, world
generation) may select the wire of a builtin plugin; on the `self` tier, where
the one player approved every loaded plugin, it may also select the wire of a
community plugin, and on a hosted tier it may not. This holds for request-scoped presets, `llm.toml` slots and a runtime's
own slot preference alike; the call fails with a configuration error that names
the plugin to enable.

At rest, the desktop app keeps the keys in `<covelHome>/keys.env` as plain
`KEY=VALUE` lines with mode `0600`, set again on every write (a no-op on
Windows); the web app keeps them in `localStorage` (`covel:keys`). They are not
encrypted. The renderer needs the plain values to build `X-Provider-Keys`, so
encryption at rest would leave the `covel:keys:load` IPC channel (trusted sender
only) as it is, and on an unsigned build Electron `safeStorage` only added a
macOS Keychain prompt. File mode and browser origin keep the keys from other OS users and other sites; they
do not keep them from code running as the user, which includes an approved
community plugin (next section).

## Community plugin code

Plugin server JavaScript (`entry`, handlers, guards, hooks, wires) runs inside
the server process with the server's privileges. There is no process, VM, or
module sandbox. What stands between a community package and those privileges is
consent:

- Before approval, a `community` package is data. Install, preview, listing and
  validation parse its files and import none of them; the two-phase approval
  (`covel:plugin-server-code`, then the action grant — see
  [Hosted auth](#hosted-auth)) gates the first import.
- After approval, the code can do what the server process can: read and write
  the files of the server's OS user (`keys.env`, `llm.toml`, the SQLite file),
  read `process.env`, open sockets, and start processes.
- `permissions.http` is an allowlist on the plugin API: `ctx.utils.fetchWithRetry`,
  `ctx.media.ingestUrl`, and the media bindings built on them
  (`packages/runtime/src/function-runtime/http-permissions.ts`). It stops a
  package from calling an origin it did not declare through that API. It does
  not stop code that calls the global `fetch` or `node:https` itself.
- The session-bound store view, per-plugin tool lookup, and the proposal
  pipeline are authority boundaries of the plugin API, with the same limit.

`ctx.gateway.resolveSlot()` is the same kind of boundary. It returns the
`apiKey` and auth headers of the slot or preset it is asked about, for any slot
name, because a plugin that implements its own wire (`registerWires`) needs them
to call its provider. The plugin manifest names slots only through `type: slot`
settings, whose value is the player's choice at run time, so there is no static
list to enforce against; and a package that cannot read the key through
`resolveSlot` can still read it as the `config` of its own wire, or from the
process it runs in. A per-slot check on this one method would look like
containment without being it, so none exists. A service call made on another
plugin's behalf never carries key material (`lendGateway` in
`packages/runtime/src/plugin-services.ts`). Approve a community package only if
you would hand its author your provider keys.

Approving a community package therefore means trusting its author with the
account the server runs under, and the install and authorization dialogs say
that the code runs without a process sandbox.

Two cheaper measures were considered and are not used, because each would look
like containment without being it:

- A scan of the package's JavaScript for `node:` imports, `process.env`, or
  `eval` is defeated by building the name from two strings, and a clean result
  would read as an audit.
- `worker_threads` with a module loader that filters `import` specifiers
  contains nothing: a worker has the process's file and network access and
  reaches the built-in modules without `import`, through
  `process.getBuiltinModule`.

Containment needs a separate OS process with restricted permissions, or an
isolate, and a plugin API that crosses it by message. That is the change to make
before community packages are distributed to players who cannot judge the
author.

## Hosted auth

`demo` and `commercial` tiers enforce:

- a per-session **owner token** — minted at session creation, stored only as a hash
  in `SessionRecord.metadata`, returned once — on every session-scoped route;
- an **operator token** (`COVEL_DESKTOP_REST_TOKEN`, also a master key that passes
  any owner check) on global and admin routes: session create/list, world writes,
  AI/model routes, and community server-code activation.

`validateSecurityPosture` (`apps/server/src/security-posture.ts`) fails boot on a
hosted tier that lacks the operator token, the media secret, or a CORS origin. The
`self` tier, desktop, and development are a strict no-op: tokens are ignored and
single-user local play is unchanged.

Community server code (`entry`, handlers, hooks, wires, runtime JavaScript) is
import-gated behind two-phase approval: a `covel:plugin-server-code` grant, then
the action grant.

### Server settings

A few player settings are carried out by the server (trace retention), so the
server stores them in its database and a browser writes them through
`PUT /api/config/server-settings`. This is a second, narrower door beside the
desktop-only `/api/config/settings`, `/api/config/keys`, `/api/config/proxy`
and `/api/config/data-root`, which stay behind `COVEL_DESKTOP_REST=1`: a plain
self-hosted web deployment does not get file, key, proxy or path writes.

- **Who writes.** `DEPLOYMENT_TIER=self` only, the tier where the one player
  owns the server; the desktop bearer token is required as well when the shell
  set one. On `demo` / `commercial` the write is refused before the token is
  looked at, the operator token included: there the values are the operator's
  and come from the environment, which also wins over a stored value on `self`.
- **What can be written.** Only a key listed in `SERVER_SETTINGS`
  (`packages/shared/src/env/server-settings.ts`) and only a value its schema
  accepts. The list is closed and each value is an enumerated or bounded
  choice; a key that could name a path, a URL, a host or a credential does not
  belong in it. An unknown key rejects the whole request.
- **What can be read.** `GET /api/config/server-settings` is public on every
  tier and returns the value in force of those keys only. Do not add a setting
  whose value in force must stay private.
- **Reach.** The origin check for writes (`origin_not_allowed`) applies as to
  every other `PUT`. A `self` server that is reachable by other people lets
  them change these settings, as it lets them use every other route; expose a
  `self` server only to its owner.

## Translations from outside a package

`$COVEL_HOME/translations` (`COVEL_USER_TRANSLATIONS_DIR`) holds plugin
translations that did not come with the plugin: translation packages the user
copied there and machine translations made on that machine. The loader reads
them as data:

- Only labels and `messages` are read. A prompt body (`*.zh.md`) is read from
  the plugin package only, so a translation cannot change an instruction.
- A label section keeps label fields only (`displayName`, `description`,
  `label`, `title`, `summary`, `about`); anything else in it is dropped, as for
  the plugin's own locale files.
- The author's translation wins wherever both translate the same text.
- Symbolic links are not followed; only regular files are read.

The text is still model-facing in one case: a `messages` entry for text that
plugin code writes into state or context. That makes a translation package
the same class of input as a world package's lore, and it is why the
directory is a local, operator-controlled path with no install endpoint.

## Package credits and author links

A plugin, world or collection may state its author, license and home page, and
the author may add a short message and up to six labelled links
(`author`, `license`, `homepage`; fields in
[`docs/reference/plugins.md`](../reference/plugins.md#作者信息)). This is text
from whoever made the package, shown to a player who has not started playing.
The limits on it:

- **Display only.** The host makes no decision from these fields. They are
  left out of the world view that prompt templates read, so the author's
  message never reaches a model.
- **Plain text.** The message and labels render as text: no Markdown, no HTML
  and no images, so a package cannot make the client fetch a remote resource
  when its card is shown.
- **`https` links only.** The manifest schema rejects any other scheme
  (`http:`, `javascript:`, `file:`) and an address with a user name or
  password, which can hide the real host.
- **The player opens a link, after a warning.** A click shows the full address
  and its host, and says that the link comes from the package author and that
  Covel has not checked the site. The link opens in the system browser only
  after the player confirms. The host name is shown in ASCII, so a look-alike
  name in another script appears as `xn--…`.
- **Before play only.** Credits appear on world cards, the world page, the
  session preparation screen and the installed-package list. The play view
  does not show them. An install preview shows the author's name and no links.

## Page policy and external images

The built main page carries a `Content-Security-Policy` meta tag
(`apps/web/src/lib/page-csp.ts`, injected by the Vite build; the dev server
does not get it because Vite needs inline scripts and a hot-reload socket):

```
script-src 'self'; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; connect-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

Scripts are the app's own files only: no inline script, no inline event
handler, no `eval`, no remote script. The built page has one external module
script and nothing inline (Zod is configured not to probe for `eval`,
`apps/web/src/lib/zod-config.ts`). Frames are limited to the own origin; the
only frame the app creates is the plugin frame host described below.
`connect-src` is the own origin (plus `blob:` / `data:`), there are no plugins
(`object-src 'none'`), and `base-uri` and `form-action` are pinned to the own
origin. `style-src` keeps `'unsafe-inline'`: React `style` props, the theme
system's injected rules and imported theme CSS need it, and removing it is a
separate step. `style-src` / `font-src` allow `https:` because an imported
theme's own CSS may load remote stylesheets and fonts. The policy sets no
`img-src`.

`tests/e2e/page-policy.spec.ts` loads the built app's main screens and a
session with plugin panels and fails on any `securitypolicyviolation` event.

### Plugin HTML

A plugin's `webview` HTML is code the player approved, and it must not reach
the app's origin: the settings and provider keys in `localStorage`, cookies,
or the API with the player's session tokens. It runs two frames down from the
app's page.

1. **The frame host** is `/plugin-frame.html`, a static file of the web build
   (`apps/web/public/plugin-frame.html`), the same for every plugin and
   session. The app frames it with `sandbox="allow-scripts"` (no
   `allow-same-origin`), so it is an opaque origin. It is loaded by URL, not
   as `srcdoc` or `blob:`: a `srcdoc`, `blob:` or `data:` frame inherits the
   policy of the page that creates it, which would force the app's page to
   allow inline script, while a document loaded from a URL has only the policy
   of its own response. Its policy, in a `<meta>` of the file:

   ```
   default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; frame-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'
   ```

   The Covel server sends the same policy as a response header with
   `sandbox allow-scripts; frame-ancestors 'self'` added
   (`apps/server/src/middleware/plugin-frame-headers.ts`), so the document is
   an opaque origin even when its address is opened directly, and no other
   site can frame it. A static host that serves the build without these
   headers still gets the `<meta>` policy and the frame's `sandbox` attribute.

2. **The plugin document** is a `srcdoc` frame that the frame host creates,
   again with `sandbox="allow-scripts"`. It inherits the frame host's policy:
   inline script and style run, nothing loads from the network, and
   `frame-src 'none'` on the frame host stops the plugin document from
   navigating itself to a network address (a document's own policy cannot
   stop its own navigation; its parent's `frame-src` does).

The plugin's HTML does not travel through a URL. The app already holds it
(`GET /api/ui-specs`, with that route's session authorization) and sends it to
the frame host with the bridge port, so `/plugin-frame.html` takes no plugin,
session or file name and cannot be used to read another plugin's or another
session's files. The file is part of the build, so the desktop app (served by
its loopback sidecar), the browser-private profile and offline use need
nothing else, and there is no second origin for a self-hoster to configure. A
separate real origin (another port or subdomain) would add no isolation that
the opaque origin lacks here, and would cost every self-hoster a second
listener, DNS name or proxy rule.

**The bridge** (`apps/web/src/components/session/plugin-bridge.ts`). The app
listens on no window `message` event. For each frame element it creates one
`MessageChannel` and transfers one end to that frame's `contentWindow`; the
frame host passes it to the plugin document once, and a document that loads in
either frame later gets no port. What arrives on the port is untrusted input,
parsed with Zod: a request names one of the actions the host offers for that
panel (bound to the owning plugin) and a plain parameter object; anything else
is dropped or answered with a fixed failure text. A handler's error never
crosses, so a server error or a credential in it stays in the app. The bridge
carries the plugin's own data, the locale, the lock state, the panel context
and the theme. It carries no session token and no provider key, and plugin
HTML has no way to call the API except through an offered action.

The app ships its own fonts (`@fontsource-variable/*`, SIL OFL 1.1) and makes
no request to a font host at start.

**Markdown images.** Story text and world documents are rendered by one
component (`apps/web/src/components/ui/markdown.tsx`). An image served by the
app itself (same origin, the media store, `data:` and `blob:`) loads at once.
An image on another origin is not requested: the player sees a placeholder
that names the host, with "Load this image" and "Always load images from this
host in this world"; the second choice is stored per world in the
`media.allowedImageHosts` setting. This stops a model from carrying text from
the conversation out in an image URL and stops an unseen host from learning
the player's address. Loaded images send no referrer. Plugin webviews and
json-render panels are not Markdown and keep their own rules.

## Other server guards

Desktop menu imports open the shared package installer and use the same server validation, archive limits and trust flow as web imports. The old native IPC channels that copied a directory or ZIP directly into resource directories are no longer exposed.

A hook that returns no value continues. A transform hook failure retains earlier successful rewrites. Security guard exceptions and timeouts remain fail-closed; only treating every hook fault as a continuation would bypass approval and commit guards. Rewrite traces contain changed-key summaries rather than full before/after prompts.

Session mutations, player actions, suspension resumes and action RPCs share the
live-session guard in `routes/api/session/locked-mutation.ts`. While holding the
session lock, they recheck existence, owner authorization, immutable incarnation,
the deletion marker and the caller's allowed statuses before writing. An action
whose SSE response is already open reports an entry denial through
`error.occurred` with the same machine-readable code as the JSON guard. Detached
runtime jobs retain their separate admission and commit locks.

Execution status reads (`GET /api/sessions/:id/execution`) bind the session
incarnation that passed owner authorization to the existing response-side read
barrier. If that session disappears or is recreated under the same public ID
while the lookup is in flight, the response is replaced with
`409 session_incarnation_changed`; retry input from the replacement is not
returned to the old request. This check does not wait for a long-running session
action to release its lock.

| Guard              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Code                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bind address       | `127.0.0.1` by default; `COVEL_BIND_HOST` opts into `0.0.0.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/server/src/app.ts`                      |
| Signed media URLs  | `MediaRef` URLs are signed with `COVEL_MEDIA_TOKEN_SECRET`. Desktop shells must provision it or images fail to load; web uses a per-boot secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/server/src/middleware/media-token.ts`   |
| Media library      | `GET /api/media/library` and `POST /api/media/library/delete` list and delete every stored asset without naming a session, and the listing issues signed URLs with the scope `media-library:` that read any asset. They exist only where one player owns the whole store (`self`, desktop); on `demo`, `commercial` and the browser-private profile they answer `503` and the scope is refused, operator token or not, because the store has no per-owner media index                                                                                                                                                                                                                  | `apps/server/src/routes/api/media-library.ts` |
| Session IDs        | `{worldId}-{uuid8}` from `crypto.randomUUID()`, resistant to enumeration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | session routes                                |
| World IDs          | `/^[a-z0-9_-]{1,64}$/i` whitelist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | world routes                                  |
| World reads        | `GET /api/worlds` and `GET /api/worlds/:id` need no identity, in every tier: whoever can reach the server reads each world record, including a stored (generated) world's embedded characters, lorebook, contract data and any content its author marked hidden. Writes are gated; reads are not. A hosted deployment that cannot show that content to every visitor must keep the server behind its own access control                                                                                                                                                                                                                                                                | `apps/server/src/routes/api/worlds/crud.ts`   |
| World gallery      | `GET /api/worlds/:id/gallery*` serves images of a world package without a session, to whoever can list worlds. A request names the two parts of a file's address; it is answered only when the gallery listing itself contains that file: a raster image (PNG, JPEG, WebP, never SVG) that the package's `media/gallery.json` lists up to the opening, or, without that file, one directly inside a public `kind: media` source. Paths resolve inside the package with symlinks rejected; sources with `enabled: false` or `visibility: hidden` are not served. The one audio file it serves is the `.mp3` / `.wav` that `world.yaml` names as `themeMusic`, under the same path rules | `apps/server/src/world-data/gallery.ts`       |
| Write origin       | CORS only keeps a page from reading a response; a "simple" cross-site request (a form post, `fetch` with `text/plain`) still runs its handler. A `POST` / `PUT` / `PATCH` / `DELETE` that carries an `Origin` is refused with `403 origin_not_allowed` before any route unless the origin is on the CORS allowlist or its host is the host the request was sent to (`Host`, or `X-Forwarded-Host` behind a proxy). A request without `Origin` is a non-browser client and passes. This is not authentication, and it does not cover DNS rebinding                                                                                                                                      | `apps/server/src/middleware/origin-guard.ts`  |
| Rate limiting      | `rateLimiter()` and `singleFlight()`; `RATE_LIMIT_RPM` sets the budget. A client address has one budget per concrete path and a second, eight times as large, per route template (`/api/sessions/:id/state`), so each session keeps its own budget while rotating a path parameter stops at the larger one; the counter table holds at most 10,000 entries, evicting the oldest window first                                                                                                                                                                                                                                                                                           | `apps/server/src/middleware/rate-limit.ts`    |
| Raw config files   | `GET` / `PUT /api/config/raw*` read and write `llm.toml` (and `config.toml` in desktop mode) as text. They share the install guard: operator token on a hosted tier, desktop token under the shell, `COVEL_INSTALL_API_ENABLED=1` in production. The names are a fixed list, never a path from the request; `keys.env` is not on it. A text is written only after the server's own parser accepts it                                                                                                                                                                                                                                                                                   | `apps/server/src/routes/raw-config-api.ts`    |
| Error sanitization | `app.onError` returns `"Internal server error"` in production; stacks and paths go only to `console.error`. Development returns `err.message`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `routes/api/bootstrap.ts`, `app.ts`           |

Resume failures and unexpected snapshot/fork failures pass through the standard classifier after required cleanup (`apps/server/src/api-error.ts`, `routes/api/resume.ts`, `routes/api/snapshots.ts`). Failed resume responses do not return the runtime result. They name the runtime's own failure or the commit failure, the same text a turn reports to the player in `runtime.failed`; any other exception is a generic 500 in production. The known fork media-reference failure keeps its code with a fixed safe message. An already-open world-translation stream (`routes/api/worlds/translate.ts`) uses the same sanitized error content without changing its HTTP status; the reason a translation was refused (no translation, a reply that is not JSON, a changed placeholder) is reported, and unexpected store or provider errors are not. Causes are logged server-side. These changes do not claim sanitization of every trace, game-content or logging surface.
