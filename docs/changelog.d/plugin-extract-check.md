### Added

- **`pnpm check` verifies that bundled plugins declare what their entries register.** `pnpm check:manifests` now also runs `plugin:extract --check` on every bundled plugin with an entry, in one process, and lists the differing keys with the fix command. `pnpm validate:plugin` stays static. Documented in [commands](../en/internals/commands.md) and [plugins with local code](../en/plugins/local-code.md#4-write-the-entry-file).
- **`pnpm plugin:extract` syncs `extensions`.** Extensions are added and dropped by `<point>/<id>`; options such as `order` and `slot` of entries that stay registered are kept. `commands` is still only reported.

### Changed

- **A plugin whose registrations and `contributes` disagree fails to load with the fix command in the error.** `Undeclared registration`, `Missing registration`, `Undeclared extension` and `Missing extension implementation` errors now end with `Sync PLUGIN.md with the entry: pnpm plugin:extract <plugin-dir>`. Duplicate registrations keep their message, since extraction cannot fix them.
- **The plugin guides and scaffolds list the sync as a fixed step after every entry change.** See [essentials](../en/plugins/essentials.md#after-changing-the-entry-sync-the-declarations) and [testing](../en/plugins/testing.md#validation).
