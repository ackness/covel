### Security

- **The local server answers only to loopback host names.** On the `self` tier (the default, the desktop app and `pnpm dev`) a request whose `Host` header is not `localhost`, `127.0.0.1`, `[::1]` or a name in the new `COVEL_ALLOWED_HOSTS` variable gets `403 host_not_allowed`, on every method. A web page can no longer point its own domain at your machine (DNS rebinding) to drive the token-less API. `demo` and `commercial` are unchanged. Rule: `docs/internals/security.md`.

### Upgrade notes

- **A self-hosted instance opened from other machines must list its names.** If players reach your instance by a domain, a LAN address or through a reverse proxy, set `COVEL_ALLOWED_HOSTS` (for example `covel.example.com,192.168.1.20`) before upgrading. Opening it at `localhost` or `127.0.0.1` needs nothing. Details: `docs/reference/env-registry.md`.
