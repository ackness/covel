### Fixed

- **A plugin's world data file may end in a suffix such as `.bak` or `.min`.** `authoring.source.path` rejected `characters/characters.bak.json` or `media/scenes.min.json` as a language version of a kernel file. Now only a two-letter language code (`.fr`, `.zh-CN`) or a three-letter one with a region (`.yue-HK`) makes a language version. See `docs/reference/world-data.md`.
- **`pnpm i18n status` and `pnpm i18n lock` go on past a plugin they cannot read.** A plugin whose runtime directory holds a misnamed manifest stopped the whole run; now the command names that plugin and its problem, checks the others and exits with status 1. The translation check in `pnpm check` reports such a bundled plugin the same way.
