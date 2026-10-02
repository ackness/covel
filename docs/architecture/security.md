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

## Other server guards

| Guard              | Behavior                                                                                                                                        | Code                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Bind address       | `127.0.0.1` by default; `COVEL_BIND_HOST` opts into `0.0.0.0`                                                                                   | `apps/server/src/app.ts`                    |
| Signed media URLs  | `MediaRef` URLs are signed with `COVEL_MEDIA_TOKEN_SECRET`. Desktop shells must provision it or images fail to load; web uses a per-boot secret | `apps/server/src/middleware/media-token.ts` |
| Session IDs        | `{worldId}-{uuid8}` from `crypto.randomUUID()`, resistant to enumeration                                                                        | session routes                              |
| World IDs          | `/^[a-z0-9_-]{1,64}$/i` whitelist                                                                                                               | world routes                                |
| Rate limiting      | `rateLimiter()` and `singleFlight()`; `RATE_LIMIT_RPM` sets the budget                                                                          | `apps/server/src/middleware/rate-limit.ts`  |
| Error sanitization | `app.onError` returns `"Internal server error"` in production; stacks and paths go only to `console.error`. Development returns `err.message`   | `routes/api/bootstrap.ts`, `app.ts`         |
