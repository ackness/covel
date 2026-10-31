### Added

- **Plugins can publish restricted static theme packs.** `contributes.ui.theme` supports localized palettes, shared layout presets and AST-compiled CSS, including zero-runtime community packages. Author validation, ZIP admission and discovery share the same compiler; player selection and style mounting are not yet available. Contract: `docs/reference/theme-packages.md`.
- **Theme backgrounds use content-bound public bitmap resources.** Only indexed PNG, JPEG, WebP, GIF and AVIF bytes are published through the existing asset route, with purpose-specific listings, exact hashes and no HTML bridge.

### Changed

- **UI discovery always returns a separate typed `theme` array.** Resolved themes include full SHA-256 identity, all localized text maps and compiled CSS; invalid themes produce isolated diagnostics while sibling themes and panels remain available. Existing development sessions and appearance settings need no recreation.
