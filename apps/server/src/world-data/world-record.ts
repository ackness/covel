import {
  WORLD_EDITIONS_KEY,
  WORLD_LOCALIZED_TEXT_KEY,
  resolveI18nText,
} from "@covel/shared";
import type { WorldRecord } from "@covel/store";

/** Project a validated manifest into the common file/store world record. */
export function worldRecordFromManifest(
  manifest: Readonly<Record<string, unknown>>,
  lore: string,
  metadata: Record<string, unknown> = {},
  now = new Date().toISOString(),
): WorldRecord {
  const locale = manifest.defaultLocale as string | undefined;
  const dimensions = manifest.dimensions as Record<string, unknown> | undefined;
  // `name` and `description` below are one language, for stores and lists.
  // Keep the translations too: a session in another locale reads them.
  const isLocaleMap = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const localizedText = {
    ...(isLocaleMap(manifest.name) ? { name: manifest.name } : {}),
    ...(isLocaleMap(manifest.summary) ? { description: manifest.summary } : {}),
  };
  return {
    id: manifest.id as string,
    name:
      resolveI18nText(
        manifest.name as string | Record<string, string>,
        locale,
      ) ?? "",
    description:
      resolveI18nText(
        manifest.summary as string | Record<string, string>,
        locale,
      ) ?? "",
    lore: lore || undefined,
    tags: manifest.tags as string[] | undefined,
    locale,
    metadata: {
      dimensions:
        dimensions && Object.keys(dimensions).length ? dimensions : undefined,
      dimensionSources: manifest.dimensionSources,
      pluginPolicy: manifest.pluginPolicy,
      pluginSettings: manifest.pluginSettings,
      worldDataPath: manifest.worldData,
      characterSchema: manifest.characterSchema,
      ...(manifest.defaultViewMode
        ? { defaultViewMode: manifest.defaultViewMode }
        : {}),
      // The locales the world has content for; a session is in one of them.
      ...(Array.isArray(manifest.supportedLocales)
        ? { [WORLD_EDITIONS_KEY]: manifest.supportedLocales }
        : {}),
      ...(Object.keys(localizedText).length
        ? { [WORLD_LOCALIZED_TEXT_KEY]: localizedText }
        : {}),
      ...metadata,
    },
    createdAt: now,
    updatedAt: now,
  };
}
