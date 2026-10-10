import type { World } from "../types/world.js";
import { WORLD_LOCALIZED_TEXT_KEY } from "./i18n.js";

/**
 * The `metadata` keys a world summary keeps: what the world list, a world
 * card, the session-prep header and the plugin-settings pane read. Every
 * other key (dimensions, embedded characters and lorebook, character schema,
 * world data, plugin policy) belongs to the full record.
 */
export const WORLD_SUMMARY_METADATA_KEYS = [
  "source",
  "storage",
  "packageManaged",
  "generated",
  "cover",
  "accentColor",
  "supportedLocales",
  "packageInfo",
  "defaultViewMode",
  "pluginSettings",
] as const;

/** Translated texts a summary keeps; the lore translations stay out. */
const SUMMARY_LOCALIZED_TEXT_FIELDS = ["name", "description"] as const;

type SummarizableWorld = Pick<World, "id" | "createdAt" | "updatedAt"> & {
  readonly name: unknown;
  readonly description: unknown;
  readonly locale?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * The summary of a world: the same record without `lore` and `dimensions`,
 * and with `metadata` cut to what the list screens show. Applying it to a
 * summary returns an equal summary.
 */
export function summarizeWorld<T extends SummarizableWorld>(
  world: T,
): Omit<T, "lore" | "dimensions"> {
  const {
    lore: _lore,
    dimensions: _dimensions,
    ...rest
  } = world as T & {
    lore?: unknown;
    dimensions?: unknown;
  };
  const metadata = summaryMetadata(world.metadata);
  return {
    ...rest,
    metadata,
  } as Omit<T, "lore" | "dimensions">;
}

function summaryMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const kept: Record<string, unknown> = {};
  for (const key of WORLD_SUMMARY_METADATA_KEYS) {
    if (Object.hasOwn(metadata, key)) kept[key] = metadata[key];
  }
  const localized = metadata[WORLD_LOCALIZED_TEXT_KEY];
  if (localized && typeof localized === "object" && !Array.isArray(localized)) {
    const texts: Record<string, unknown> = {};
    for (const field of SUMMARY_LOCALIZED_TEXT_FIELDS) {
      if (Object.hasOwn(localized, field))
        texts[field] = (localized as Record<string, unknown>)[field];
    }
    if (Object.keys(texts).length > 0) kept[WORLD_LOCALIZED_TEXT_KEY] = texts;
  }
  return kept;
}
