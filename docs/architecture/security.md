# Security Boundaries

This page explains the server's security boundaries and why each one is drawn
where it is. Route-level auth contracts live in
[`../reference/api.md`](../reference/api.md#鉴权session-owner-token); environment
variables live in [`../guide/env-registry.md`](../guide/env-registry.md); desktop
proxy settings live in [`../guide/desktop-config.md`](../guide/desktop-config.md).

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

Loopback (`localhost`, `127.0.0.1`, `::1`) bypasses the `https` requirement so
Ollama-style local servers work in development.

### DNS pinning

A string check alone leaves a DNS-rebinding gap between validation and connect.
In direct mode, the core provider requests (`postJson` / `getJson` /
`postFormData`) and the plugin `fetchWithRetry` helper
(`packages/ai-provider/src/plugin-utils.ts`; exposed as `ctx.utils.fetchWithRetry`
to handlers and `covel.http.fetchWithRetry` to entry modules) resolve DNS through
a pinning dispatcher (`adapters/http/dns-safety.ts`). Every A/AAAA answer must be
publicly routable, loopback hostnames must resolve to loopback, and the socket is
pinned to the validated answer.

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

Failure mode this prevents: a request-scoped custom preset (`X-Slot-Config`
overlay) that redirects a provider to another origin would otherwise receive the
operator's key. Such a preset gets no environment key and no trusted default
headers; it must supply its own key.

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

## Other server guards

| Guard              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Code                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Bind address       | `127.0.0.1` by default; `COVEL_BIND_HOST` opts into `0.0.0.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `apps/server/src/app.ts`                     |
| Signed media URLs  | `MediaRef` URLs are signed with `COVEL_MEDIA_TOKEN_SECRET`. Desktop shells must provision it or images fail to load; web uses a per-boot secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `apps/server/src/middleware/media-token.ts`  |
| Session IDs        | `{worldId}-{uuid8}` from `crypto.randomUUID()`, resistant to enumeration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | session routes                               |
| World IDs          | `/^[a-z0-9_-]{1,64}$/i` whitelist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | world routes                                 |
| World gallery      | `GET /api/worlds/:id/gallery*` serves images of a world package without a session, to whoever can list worlds. A request names the two parts of a file's address; it is answered only when the gallery listing itself contains that file: a raster image (PNG, JPEG, WebP, never SVG) that the package's `media/gallery.json` lists up to the opening, or, without that file, one directly inside a public `kind: media` source. Paths resolve inside the package with symlinks rejected; sources with `enabled: false` or `visibility: hidden` are not served. The one audio file it serves is the `.mp3` / `.wav` that `world.yaml` names as `themeMusic`, under the same path rules | `apps/server/src/world-data/gallery.ts`      |
| Write origin       | CORS only keeps a page from reading a response; a "simple" cross-site request (a form post, `fetch` with `text/plain`) still runs its handler. A `POST` / `PUT` / `PATCH` / `DELETE` that carries an `Origin` is refused with `403 origin_not_allowed` before any route unless the origin is on the CORS allowlist or its host is the host the request was sent to (`Host`, or `X-Forwarded-Host` behind a proxy). A request without `Origin` is a non-browser client and passes. This is not authentication, and it does not cover DNS rebinding                                                                                                                                      | `apps/server/src/middleware/origin-guard.ts` |
| Rate limiting      | `rateLimiter()` and `singleFlight()`; `RATE_LIMIT_RPM` sets the budget                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `apps/server/src/middleware/rate-limit.ts`   |
| Raw config files   | `GET` / `PUT /api/config/raw*` read and write `llm.toml` (and `config.toml` in desktop mode) as text. They share the install guard: operator token on a hosted tier, desktop token under the shell, `COVEL_INSTALL_API_ENABLED=1` in production. The names are a fixed list, never a path from the request; `keys.env` is not on it. A text is written only after the server's own parser accepts it                                                                                                                                                                                                                                                                                   | `apps/server/src/routes/raw-config-api.ts`   |
| Error sanitization | `app.onError` returns `"Internal server error"` in production; stacks and paths go only to `console.error`. Development returns `err.message`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `routes/api/bootstrap.ts`, `app.ts`          |
