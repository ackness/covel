### Security

- **Plugin load errors no longer reveal the server's install path.** `GET /api/plugins` writes the plugin directory as `<plugin>` in the `error` of a package that failed to load. The full message stays in the server log.

### Fixed

- **`GET /api/framework/capabilities` lists the builtin tools the server runs.** It used to return a hand-written list that had drifted from the registry.
