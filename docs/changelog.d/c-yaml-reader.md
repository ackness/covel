### Security

- **Plugin localization tools reject executable frontmatter.** Loading, installation, validation, translation, and authoring checks share the same plain YAML manifest reader. Runtime directory symlinks are excluded consistently from discovery and localization scans.

### Fixed

- **Missing runtime manifests have consistent diagnostics.** Put shared code in `lib/`; every directory under `runtimes/` needs `RUNTIME.md`. Validation and installation report the offending path, while the loader warns and keeps the package’s other runtimes available. See the [plugin reference](../en/reference/plugins.md#package-and-runtime-files).
