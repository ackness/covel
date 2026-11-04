### Added

- **Plugins can publish restricted static theme packs.** `contributes.ui.theme` supports localized palettes, shared layout presets and AST-compiled CSS, including zero-runtime community packages. Author validation, ZIP admission and discovery share the same compiler; players explicitly choose one pack per session on this device. Contract: `docs/reference/theme-packages.md`.
- **Theme backgrounds use content-bound public bitmap resources.** Only indexed PNG, JPEG, WebP, GIF and AVIF bytes are published through the existing asset route, with purpose-specific listings, exact hashes and no HTML bridge.
- **Session themes preserve host recovery and player adjustments.** Restricted styles affect narrative text and decorative content only; Use default appearance remains available in immersive stage and plugin views. Discovery refreshes retain pending save results and failure warnings. Save failures, missing resources and changed content fall back safely without changing the base appearance. Scene Stage provides an optional reading pack.

### Changed

- **UI discovery always returns a separate typed `theme` array.** Resolved themes include full SHA-256 identity, all localized text maps and compiled CSS; invalid themes produce isolated diagnostics while sibling themes and panels remain available. Existing development sessions and appearance settings need no recreation.
- **Choosing stage view keeps the current story and next action available.** Entering from text or a plugin view offers optional rereading with the session theme while choices and free input stay ready; session restoration still skips already-read history. Host recovery remains outside the themed text and available while the game surface loads.
