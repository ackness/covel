### Added

- **Plugin authors can extract registration declarations from their own entry code.** `pnpm plugin:extract <dir>` syncs six `contributes` lists in canonical `PLUGIN.md`, preserving other fields, comments and the body. `--check` reports drift without writing; `--json` emits a structured report. The command executes with the author's permissions. Installation and static validation remain declaration-only; see `docs/plugins/local-code.md`.
