### Removed

- **Compiled runtime manifests and `/api/plugin-flows` no longer expose `pluginType`.** Package manifests, plugin summaries, and flow entries use `kind` (`core` or `plugin`); runtime manifests carry no package category. Update clients that read the removed field. See the [API reference](../reference/api.md).

### Fixed

- **Model capability controls use the same input, output, and feature names as the server.** Custom model output choices now include `video`, as documented in the [slot reference](../reference/slots.md).
