### Fixed

- Resolve theme fallbacks without rewriting saved preferences, show advisory contrast checks on theme import/save, translate builtin theme labels in every UI catalog, and constrain world accent lightness.
- Load worlds with invalid accent colours using the default accent and a server warning; keep format and lightness errors in `pnpm validate:world` for authors to fix.
