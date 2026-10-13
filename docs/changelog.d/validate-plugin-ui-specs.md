### Fixed

- **`pnpm validate:plugin` checks a plugin's UI spec files.** A misspelt component name, a spec with neither or both of `view` and `webview`, a `repeat.statePath` that is not an absolute path string or `{ "$item": "field" }`, and an `$item` / `$bindItem` field name with a leading slash now fail validation with the spec file and the JSON path of the node, instead of showing only as a missing panel in the app. The ZIP install runs the same checks, so a package with such a spec is refused. Rules: `docs/reference/plugins.md` and `docs/reference/ui-panels.md`.
