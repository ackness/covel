### Changed

- **Unmatched plugin asset paths return JSON 404 responses.** The `/plugin-assets` namespace stays reserved after dot-segment normalization, so incomplete URLs cannot serve public static files or the application index. See [security boundaries](../en/internals/security.md#plugin-pages-loaded-by-url).
