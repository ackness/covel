### Fixed

- **GitHub previews show package descriptions in the UI language.** Plugin locale files and world translation overlays remain available as `I18nText` through installation and update previews.
- **Plugin code notices include all declared imports and TypeScript module files.** Preview and ZIP metadata use the loader’s import enumeration, including world projections, with `.mts` and `.cts` file detection.
- **Every plugin install path requires self-contained runtime files.** GitHub, ZIP, offline collections, and updates reject nonempty runtime dependency declarations with instructions for the author; development dependencies remain allowed.
