import type { PluginMessages } from "@covel/plugin-handlers-utils";

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
 * The session's catalog is the one for the same locale, or else for the same
 * language and script: `zh-CN` reads `zh`, `zh-Hant` does not. A session with
 * no catalog reads the English text in the code.
 */
export function pluginMessagesFor(
  catalogs: readonly PluginMessageCatalog[] | undefined,
  locale: string | undefined,
): PluginMessages | undefined {
  if (!catalogs || catalogs.length === 0) return undefined;
  const sessionLocale = canonicalizeLocale(locale ?? "") ?? "";
  const cached = cache.get(catalogs)?.get(sessionLocale);
  if (cached) return cached;

  const session =
    catalogs.find(
      (catalog) => canonicalizeLocale(catalog.locale) === sessionLocale,
    ) ??
    (sessionLocale
      ? catalogs.find((catalog) =>
          localesShareLanguageAndScript(sessionLocale, catalog.locale),
        )
      : undefined);
  const labels: Record<string, Record<string, string>> = {};
  for (const catalog of catalogs)
    for (const [text, translation] of Object.entries(catalog.messages))
      (labels[text] ??= {})[catalog.locale] = translation;
  const messages: PluginMessages = Object.freeze({
    translations: Object.freeze({ ...session?.messages }),
    labels: Object.freeze(labels),
  });

  const byLocale = cache.get(catalogs) ?? new Map<string, PluginMessages>();
  cache.set(catalogs, byLocale);
  byLocale.set(sessionLocale, messages);
  return messages;
}
