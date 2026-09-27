# @covel/plugin-director

Opt-in narration guidance, disabled by default. The package has no schedulable runtime and does not write session data. `PLUGIN.md` declares a `prompt.segment@1` provider, registered by `server/index.js`.

The provider returns one localized, stable system segment with `audience: "story"`. The host selects story outputs by `outputKind` and places the segment before the stable cache boundary; other runtime kinds receive no director segment. The text in `hooks/_preamble.js` guides scene delivery and player agency without changing world canon or making an LLM call.

Enable `director` in a world's plugin selection or for a session through `PUT /api/sessions/:id/plugins/:pluginId`. Only sessions that activate the package receive its segment. The prompt construction contract is documented in [plugin extensions](../../docs/reference/plugin-extensions.md).

Run `pnpm --filter @covel/plugin-director test` after changing its provider or preamble.
