### Fixed

- **Same-origin HTTPS writes now work behind TLS-terminating proxies with dynamic IPs.** `origin-guard` now upgrades a plain `http:` request's expected scheme to `https:` on the same `Host` when `X-Forwarded-Proto: https` or RFC 7239 `Forwarded: proto=https` is present, fixing `403 origin_not_allowed` on Render and similar cloud deployments where `TRUSTED_PROXY_IPS` cannot pin dynamic proxy ranges, while keeping `X-Forwarded-Host` restricted to `TRUSTED_PROXY_IPS` and still blocking cross-site writes and `http://` scheme downgrades. See [security](../en/internals/security.md).
