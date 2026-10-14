# Security boundaries

This page explains which security boundaries the Covel server has, and why each boundary is drawn where it is. It is written for people who change the server, run a hosted instance, or want to know "what it means to approve a community plugin".

Related material is on other pages:

- Authentication rules for each route: [`../reference/api.md`](../reference/api.md#authentication-session-owner-token)
- Environment variables: [`../reference/env-registry.md`](../reference/env-registry.md)
- Desktop proxy settings: [`../reference/desktop-config.md`](../reference/desktop-config.md)
- Reporting a vulnerability: [`SECURITY.md`](../../../SECURITY.md)

Below, the "deployment tier" (`DEPLOYMENT_TIER`) comes up many times. `self` is the default. It means the desktop app, and instances that a person deploys for their own use. `demo` and `commercial` are hosted instances for other people. Together they are called the hosted tiers.

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

On the `self` tier (the desktop app and self-deployment, which are the defaults), loopback addresses (`localhost`, `127.0.0.1`, `::1`) can be reached, and `https` is not required. This is what lets a local service such as Ollama work: the server runs on the player's own machine.

The hosted tiers (`demo` / `commercial`) have no loopback exception. The reason:

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

### Desktop proxy modes

The desktop app's `system` / `http` / `socks` proxy modes send only the framework's own core provider requests and model database requests through an Undici `ProxyAgent` (`packages/ai-provider/src/outbound-network.ts`). For these trusted targets, DNS is resolved on the proxy side, in place of local address pinning.

A plugin's `fetchWithRetry` always uses the strict, direct, address-pinned path. This way third-party code cannot use the proxy's remote DNS to get around the plugin's network boundary.

### Self-tier exemption (core provider path only)

On the `self` tier (the default for the desktop app and self-deployment, which only listen on loopback anyway), the direct core provider path, which is the LLM `baseUrl` the user configured, accepts any result the resolver gives for the host name. The socket is still pinned to that result.

This is needed because two common cases on a single-user machine would be blocked by a "public addresses only" rule:

- TUN proxies (Clash, mihomo, sing-box, Surge) map every domain to a private or benchmarking range, and then route by SNI;
- endpoints on the local network, such as Ollama on `192.168.x.x`.

The exemption is kept deliberately narrow. It does not apply to:

- the plugin `fetchWithRetry` path: third-party code must not probe the local network, and neither should a desktop install;
- URLs with an IP literal: the string check still blocks literal private addresses;
- the hosted tiers (`demo` / `commercial`): a private address on a cloud network may lead to a real internal service.

## Provider keys

Model provider keys come from two sources, and they take two paths:

- A key that comes with a request arrives in the `X-Provider-Keys` header. The server never stores it.
- Keys in the server's environment variables, and platform keys, are passed to the gateway separately, as `envApiKeys`.

The provider registry (`packages/ai-provider/src/provider-registry.ts`) attaches an environment key in only one case: the origin of the resolved target `baseUrl` matches a trusted configuration (`llm.toml`, or a registered provider default).

The Web client sends only the keys of the providers its requests need:

- the provider each model role resolves to (the saved binding; when there is no binding, it is the provider the server configured for that role);
- a provider named directly in the request, for example when probing the model list.

A key for a provider that no role uses never leaves the browser. This matters when the server belongs to someone else. Until the client has read the server's roles and presets, it sends all the saved keys. (`buildProviderKeysHeader` in `apps/web/src/services/api/model-settings.ts`.)

This rule guards against this case: a request-level custom preset (an `X-Slot-Config` override) points a provider at another origin, and without protection that provider would receive the operator's key. Now such a preset cannot get environment keys, and it cannot get the trusted default headers either. It must bring its own key.

Built-in providers (`BUILTIN_PROVIDER_CONNECTIONS` in `@covel/shared`) count as registered provider defaults. An environment key named after one of them is attached only to that provider's official origin, and nowhere else. The model list request (`POST /api/ai/models`) resolves its target as a request-level target, so the same rule holds there.

A model on a loopback address (`localhost`, `127.0.0.1`, `::1`) counts as ready without a key. Local services such as Ollama do not need one. This changes only the readiness check. If a key is configured it is still sent, and on the hosted tiers the outbound protection still rejects the request.

A plugin can register its own text wire (`covel.registerWires({ text })`). A wire is plugin code that sends and receives model requests for a certain protocol.

- A slot whose `protocol` names this wire receives the endpoint and key that the slot resolves to, plus the prompt and the answer of each call for that slot.
- A slot that does not name it gets nothing.
- A wire is the plugin's server code, so whether it can run is decided by the rules in [Community plugin code](#community-plugin-code).

When a request can use a given wire:

- A request that belongs to a session: only if the session has enabled a plugin that provides this wire. (The enabled set already reflects the player's approval of community plugins.)
- A request that belongs to no session (connection tests, model lists, world generation): it can use a wire from a built-in plugin. On the `self` tier, the one player approves all loaded plugins, so it can also use the wire of a community plugin. The hosted tiers do not allow this.

Request-level presets, `llm.toml` slots, and a runtime's own slot preference all follow this rule. When it is not met, the call fails as a configuration error, and the error message says which plugin needs to be enabled.

How keys are stored on disk:

- On the desktop app, the file is `<covelHome>/keys.env`. It holds plain `KEY=VALUE` lines, with file permission `0600`, which is set again on every write (this has no effect on Windows).
- On the Web, the keys are in `localStorage` (`covel:keys`).
- Neither place is encrypted. The renderer process needs plaintext to build `X-Provider-Keys`. So even if the file were encrypted on disk, the `covel:keys:load` IPC channel (which accepts only trusted senders) would still return the same plaintext. On unsigned builds, Electron `safeStorage` would only add one more macOS Keychain prompt.

File permissions and the browser's same-origin policy keep out other system users and other websites. They cannot keep out code that runs as this same user, and that includes approved community plugins (see the next section).

## Community plugin code

A plugin's server-side JavaScript (`entry`, handler, guard, hook, wire) runs in the server process, and has all of the server's permissions. There is no process sandbox, no VM sandbox, and no module sandbox. The only thing between a community package and these permissions is the player's consent:

- Before approval, a `community` package is just data. Installing, previewing, listing, and validating only parse its files. Nothing is imported. The two-step approval (first `covel:plugin-server-code`, then the specific operations; see [Hosted auth](#hosted-auth)) guards the first import.
- After approval, this code can do anything the server process can do: read and write files that the server's system user can access (`keys.env`, `llm.toml`, the SQLite file), read `process.env`, open sockets, and start processes.
- `permissions.http` is an allowlist on the plugin API, applied to `ctx.utils.fetchWithRetry`, `ctx.media.ingestUrl`, and the media bindings built on them (`packages/runtime/src/function-runtime/http-permissions.ts`). It stops a package from reaching an origin it did not declare through this API. It cannot stop code that calls the global `fetch` or `node:https` directly.
- The bound session store view, the lookup of tools by plugin, and the proposal pipeline are also permission boundaries of the plugin API, and they have the same limit.

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
- One **operator token** (`COVEL_DESKTOP_REST_TOKEN`). It is a master key, and it passes every owner check. Global and admin routes require it: creating and listing sessions, writing worlds, AI and model routes, and enabling community server code.

If the hosted tiers lack an operator token, a media key, or CORS origins, `validateSecurityPosture` (`apps/server/src/security-posture.ts`) makes startup fail. The `self` tier, the desktop app, and development environments do nothing of the kind: tokens are ignored, and single-user local play is not affected.

The import of community server code (`entry`, handlers, hooks, wires, runtime JavaScript) is guarded by two-step approval: first `covel:plugin-server-code` is granted, then the specific operations.

### Server settings

A few player settings must be enforced by the server (for example, how long traces are kept). So the server stores them in its own database, and the browser writes them through `PUT /api/config/server-settings`.

This is a second door, narrower than the few desktop-only endpoints. `/api/config/settings`, `/api/config/keys`, `/api/config/proxy`, and `/api/config/data-root` still need `COVEL_DESKTOP_REST=1` to be open. An ordinary self-hosted Web deployment cannot write files, keys, proxy settings, or paths.

- **Who can write.** Only `DEPLOYMENT_TIER=self`, the one tier where the only player owns the server. When the desktop shell has set a bearer token, that token is also required. On `demo` / `commercial`, a write is rejected before the token is even checked, and the operator token does not change that. There, the values belong to the operator and come from environment variables. On `self`, an environment variable also takes priority over a stored value.
- **What can be written.** Only the keys listed in `SERVER_SETTINGS` (`packages/shared/src/env/server-settings.ts`), and each value must be accepted by that key's schema. This list is closed, and every value is either an enum value or an option with a range. Keys that could point to a path, URL, host, or credential do not belong here. If an unknown key appears, the whole request is rejected.
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

The built main page has a `Content-Security-Policy` meta tag (`apps/web/src/lib/page-csp.ts`, injected by the Vite build; the dev server does not have it, because Vite needs inline scripts and a socket for hot reload):

```
script-src 'self'; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; connect-src 'self' blob: data:; frame-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'
```

What each part means:

- **Scripts** can only be the application's own files. There are no inline scripts, no inline event handlers, no `eval`, and no remote scripts. The built page has only one external module script and no inline content. (Zod is configured not to probe `eval`; see `apps/web/src/lib/zod-config.ts`.)
- **Frames** are limited to the same origin. The only frame the application creates is the plugin frame host described below.
- `connect-src` is the same origin (plus `blob:` / `data:`).
- There are no browser plugins (`object-src 'none'`).
- `base-uri` and `form-action` are fixed to the same origin.
- `style-src` keeps `'unsafe-inline'`: React's `style` attributes, rules that the theme system injects, and imported theme CSS all need it. Removing it is a separate piece of work.
- `style-src` / `font-src` allow `https:`, because an imported theme's own CSS may load remote stylesheets and fonts.
- This policy does not set `img-src`.

`tests/e2e/page-policy.spec.ts` loads the main screens of the built application and a session with a plugin panel, and fails if any `securitypolicyviolation` event appears.

### Plugin HTML

A plugin's `webview` HTML is code that the player has approved. But it must never reach the origin the application runs on: the settings and provider keys in `localStorage`, the cookies, and the API with the player's session token. It runs in a second-level frame, below the application page.

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
- Loaded images do not send a referrer.
- Plugin webviews and json-render panels are not Markdown, and they have their own rules.

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

**Reading execution state.** `GET /api/sessions/:id/execution` binds the session incarnation that passed owner authorization to the existing read barrier on the response side.

- If, while the query is running, the session disappears, or it was rebuilt with the same public ID, the response is replaced with `409 session_incarnation_changed`. The retry input of the new session is never returned to the old request.
- This check does not wait for a long-running session operation to release its lock.

| Guard              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Code                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Bind address       | Listens on `127.0.0.1` by default. Set `COVEL_BIND_HOST` to change it to `0.0.0.0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `apps/server/src/app.ts`                      |
| Signed media URLs  | The URLs of `MediaRef` are signed with `COVEL_MEDIA_TOKEN_SECRET`. The desktop shell must provide this key, or images will not load. The Web uses a key generated at each start                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `apps/server/src/middleware/media-token.ts`   |
| Media library      | `GET /api/media/library` and `POST /api/media/library/delete` list and delete all stored resources without naming a session. The list also issues signed URLs scoped to `media-library:`, which can read any resource. They exist only where one player owns the whole store (`self`, the desktop app). On `demo`, `commercial`, and the browser-private setup, they answer `503`, and this scope is rejected too, whether or not an operator token is sent, because the store has no media index divided by owner                                                                                                                                                                                                                                    | `apps/server/src/routes/api/media-library.ts` |
| Session IDs        | `{worldId}-{uuid8}`, from `crypto.randomUUID()`. Hard to enumerate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | session routes                                |
| World IDs          | Allowlist `/^[a-z0-9_-]{1,64}$/i`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | world routes                                  |
| World reads        | `GET /api/worlds` and `GET /api/worlds/:id` require no identity on any tier. Anyone who can reach the server can read every world record, including the characters, lore, and contract data embedded in stored (generated) worlds, and content the author marked as hidden. Writes are guarded, and reads are not. A hosted deployment that cannot show this content to every visitor must put the server behind its own access control                                                                                                                                                                                                                                                                                                               | `apps/server/src/routes/api/worlds/crud.ts`   |
| World gallery      | `GET /api/worlds/:id/gallery*` serves the images in a world package without a session. Anyone who can list the world can reach them. The request gives the two parts of a file address. It answers only when the gallery list itself contains this file: a bitmap (PNG, JPEG, WebP, never SVG) listed by the package's `media/gallery.json` and not later than the opening scene. When there is no such file, it answers for a file directly inside a public `kind: media` source. Paths are resolved inside the package, and symbolic links are refused. Sources with `enabled: false` or `visibility: hidden` are not served. The only audio file it serves is the `.mp3` / `.wav` named by `themeMusic` in `world.yaml`, under the same path rules | `apps/server/src/world-data/gallery.ts`       |
| Write origin       | CORS can only stop a page from reading the response. "Simple" cross-site requests (form submissions, `fetch` with `text/plain`) still run the handler. A `POST` / `PUT` / `PATCH` / `DELETE` that carries an `Origin` is rejected with `403 origin_not_allowed` before it enters any route, unless the origin is on the CORS allowlist, or its host is the host the request was sent to (`Host`, or `X-Forwarded-Host` behind a proxy). A request with no `Origin` is a non-browser client, and it is allowed. This is not authentication, and it does not defend against DNS rebinding                                                                                                                                                               | `apps/server/src/middleware/origin-guard.ts`  |
| Rate limiting      | `rateLimiter()` and `singleFlight()`. `RATE_LIMIT_RPM` sets only the quota of `GET /api/events/stream` (per IP per minute, default 60); other routes have their quotas written into each route, for example 10 for media upload, 30 for `POST /api/actions`, and 120 for reading session state (per minute). Each client address has one quota for each concrete path, and a second quota for each route template (`/api/sessions/:id/state`), which is eight times the first. This gives each session its own quota, while rotating path parameters runs into the larger one. The counter table keeps at most 10,000 entries, and evicts the entries with the oldest time window first                                                               | `apps/server/src/middleware/rate-limit.ts`    |
| Raw config files   | `GET` / `PUT /api/config/raw*` read and write `llm.toml` as text (and `config.toml` in desktop mode). They share the install guard: the hosted tiers require the operator token, the desktop shell requires the desktop token, and production requires `COVEL_INSTALL_API_ENABLED=1`. The file names come from a fixed list, never from a path in the request. `keys.env` is not on the list. Text is written only after the server's own parser accepts it. Parse and validation errors for `llm.toml` give the line, the column and the key, never a value substituted for `${VAR}`, so the refusal, the log and the Settings page cannot carry a secret                                                                                                                                                                                                                                                                                           | `apps/server/src/routes/raw-config-api.ts`    |
| Error sanitization | In production, `app.onError` returns `"Internal server error"`. Stack traces and paths go only to `console.error`. In development, it returns `err.message`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `routes/api/bootstrap.ts`, `app.ts`           |

**Error messages in failure responses.** When a suspension fails to resume, or a snapshot or branch fails unexpectedly, the error goes through the standard error classifier (`apps/server/src/api-error.ts`, `routes/api/resume.ts`, `routes/api/snapshots.ts`) after the necessary cleanup is done.

- The response for a failed resume does not return runtime results. It says only whether the runtime itself failed or the commit failed. The text is the same as the text a turn reports to the player through `runtime.failed`. Any other exception is a generic 500 in production.
- A known "media reference failed while branching" keeps its error code, with a fixed safe message.
- A world translation stream that is already open (`routes/api/worlds/translate.ts`) uses the same sanitized error content, and does not change its HTTP status. The reasons a translation is rejected are reported (no translation, the reply is not JSON, a placeholder was changed). Unexpected storage or provider errors are not reported.
- The causes are all recorded in the server log.
- These changes do not mean that every trace, game content, or log output has been sanitized.
