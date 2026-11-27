### Changed

- **Model connection tests wait up to one minute.** The [model probe](../en/reference/api.md#post-apiaiping) returns sooner when it has a result.

### Fixed

- **The development server uses the shell's proxy.** `pnpm dev` passes `HTTPS_PROXY`, `ALL_PROXY`, or `HTTP_PROXY` to the backend as the [static system proxy](../en/reference/env-registry.md#desktop-proxy), so model tests no longer connect directly.
- **Model test errors use the full row width.** Expanding error details keeps the model name, protocol, and controls readable in Providers & keys.
