import type { PluginMessages } from "@covel/plugin-handlers-utils";
import { resolveI18nText } from "./i18n.js";

export type { PluginMessages };
import {
  canonicalizeLocale,
  localesShareLanguageAndScript,
} from "./locale-registry.js";

/** The `messages` section of one `locales/<locale>.yaml` of a plugin. */
export interface PluginMessageCatalog {
  readonly locale: string;
  /** English text to its translation in `locale`. */
  readonly messages: Readonly<Record<string, string>>;
}

const cache = new WeakMap<
  readonly PluginMessageCatalog[],
  Map<string, PluginMessages>
>();

/**
 * What plugin code is given as `ctx.messages` for a session in `locale`.
 *
 * Each message uses the shared exact-locale and same-language/script lookup:
 * a partial `zh-CN` catalog can inherit `zh`, while `zh-Hant` cannot. Messages
 * without a compatible translation keep the English text in the code.
 */
export function pluginMessagesFor(
  catalogs: readonly PluginMessageCatalog[] | undefined,
  locale: string | undefined,
): PluginMessages | undefined {
  if (!catalogs || catalogs.length === 0) return undefined;
  const sessionLocale = canonicalizeLocale(locale ?? "") ?? "";
  const cached = cache.get(catalogs)?.get(sessionLocale);
  if (cached) return cached;

  const labels: Record<string, Record<string, string>> = {};
  for (const catalog of catalogs)
    for (const [text, translation] of Object.entries(catalog.messages))
      (labels[text] ??= {})[catalog.locale] = translation;
  const translations: Record<string, string> = {};
  if (sessionLocale) {
    for (const [text, variants] of Object.entries(labels)) {
      const compatible = Object.fromEntries(
        Object.entries(variants).filter(([language]) =>
          localesShareLanguageAndScript(sessionLocale, language),
        ),
      );
      if (Object.keys(compatible).length > 0)
        translations[text] =
          resolveI18nText({ en: text, ...compatible }, sessionLocale) ?? text;
    }
  }
  const messages: PluginMessages = Object.freeze({
    translations: Object.freeze(translations),
    labels: Object.freeze(labels),
  });

  const byLocale = cache.get(catalogs) ?? new Map<string, PluginMessages>();
  cache.set(catalogs, byLocale);
  byLocale.set(sessionLocale, messages);
  return messages;
}
