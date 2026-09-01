# Adding a Web locale

1. Run `pnpm i18n:add ja-JP`, or copy `en-US.json` to `<canonical-bcp47>.json` manually. Do not reuse a built-in code or alias such as `zh`, `zh-Hans`, `en`, or `ru`. The scaffold adds the plural categories required by `Intl.PluralRules` for plural bases already marked in English.
2. Translate values only. Keep every base key, JSON type, array item, and `{{ interpolation }}` token unchanged. Translate the scaffolded plural placeholders too.
   Any base string containing `{{count}}` may add locale-specific i18next plural forms such as `_few` and `_many`; their shape and interpolation tokens are checked.
3. Run:

   ```bash
   pnpm check:i18n
   pnpm --filter @covel/web test
   pnpm --filter @covel/web build
   ```

No TypeScript registration is required. The filename automatically supplies the locale code; Covel derives its display names with `Intl.DisplayNames`, adds it to settings and language selectors, and falls back to `en-US` for missing framework or native Desktop text.

The JSON catalog translates the Web UI only. Framework prompts can add `prompts/server/<name>.<locale>.md`; agent plugins can add `PLUGIN.<locale>.md`; worlds can add `WORLD.<locale>.md`. Exact locale files win, then primary-language files, then the documented English/canonical fallback.

Catalogs are loaded on demand. Runtime-installed plugins cannot replace the already-built core UI catalog, but plugin and world content may use the same locale through `I18nText`, `PLUGIN.<lang>.md`, `WORLD.<lang>.md`, and WorldData locale variants.
