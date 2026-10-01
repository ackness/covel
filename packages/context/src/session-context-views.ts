/**
 * View adapters for `buildSessionContextSnapshot`.
 *
 * Extracted from `session-context.ts` so the loader stays focused on store
 * I/O and guard semantics.
 */

import { resolveI18nDeep, resolveI18nText } from "@covel/shared";
import type { DimensionSnapshot, JsonValue } from "@covel/shared";
import type { WorldRecord } from "./session-context-store.js";
import type { WorldContextView } from "./types.js";

export interface BuildViewInput {
  readonly worldId?: string;
  readonly worldRecord: WorldRecord | null;
  readonly schemaMap: Record<string, unknown> | undefined;
  readonly entriesMap: Record<string, unknown> | undefined;
  readonly dimensions?: DimensionSnapshot;
  readonly dimensionProviderPluginId?: string;
  /** Session locale — used to localize i18n dimensions before injection. */
  readonly locale?: string;
}

export function buildWorldContextView(input: BuildViewInput): WorldContextView {
  const worldRecord = input.worldRecord;
  const id = input.worldId ?? worldRecord?.id ?? "";

  const entriesArray = input.entriesMap
    ? Object.entries(input.entriesMap).map(([key, content]) => ({
        key,
        content,
      }))
    : [];

  let extra: Record<string, unknown> | undefined;

  // `world.tone` / `world.openingScenario` are template-facing text fields.
  // Derive them from the dimension snapshot so authored prompts keep working
  // after dimensions became open definitions: `tone` resolves its
  // narrativeStyle (falling back to genre list), `openingScenario` reads the
  // startingConditions object's openingScenario field. Values may be i18n.
  const tone = deriveToneText(input.dimensions?.tone, input.locale);
  const openingScenario = deriveOpeningScenario(
    input.dimensions?.startingConditions,
    input.locale,
  );

  const metadata =
    worldRecord?.metadata && typeof worldRecord.metadata === "object"
      ? (worldRecord.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    // Surface remaining metadata keys through `extra` for forward-compat.
    for (const [k, v] of Object.entries(metadata)) {
      if (k === "dimensions") continue;
      extra = extra ?? {};
      extra[k] = v;
    }
  }

  return {
    id,
    name: worldRecord?.name,
    description: worldRecord?.description,
    tags: worldRecord?.tags,
    lore: worldRecord?.lore,
    tone,
    openingScenario,
    dimensions: structuredClone(input.dimensions ?? {}),
    dimensionProviderPluginId: input.dimensionProviderPluginId,
    // Localize i18n leaves in the schema too (e.g. attribute `name` /
    // `description` records) so prompt-injected `<world-schema>` shows one
    // language, mirroring how dimensions are resolved above.
    schema:
      input.schemaMap !== undefined
        ? (resolveI18nDeep(input.schemaMap, input.locale) as Record<
            string,
            unknown
          >)
        : undefined,
    entries: entriesArray,
    extra,
  };
}

/**
 * Render a dimension's value as prompt-facing text. `x-i18n` leaves resolve
 * per locale; a plain string passes through; an object picks its
 * narrativeStyle first, then falls back to its genre list. Non-text shapes
 * (numbers, booleans) return undefined rather than a meaningless dump.
 */
function dimensionText(
  entry: DimensionSnapshot[string] | undefined,
  preferredKey: string,
  locale: string | undefined,
): string | undefined {
  if (!entry) return undefined;
  const value = entry.value;
  if (typeof value === "string") return resolveI18nText(value, locale) ?? value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    const preferred = record[preferredKey];
    if (preferred !== undefined) {
      const text = resolveI18nText(
        preferred as string | Record<string, string>,
        locale,
      );
      if (typeof text === "string" && text.trim()) return text;
      if (typeof preferred === "string") return preferred;
    }
    const genres = record.genres;
    if (Array.isArray(genres)) {
      const names = genres
        .map((genre) =>
          typeof genre === "string"
            ? genre
            : resolveI18nText(genre as Record<string, string>, locale),
        )
        .filter(
          (genre): genre is string =>
            typeof genre === "string" && genre.length > 0,
        );
      if (names.length) return names.join(", ");
    }
  }
  return undefined;
}

function deriveToneText(
  entry: DimensionSnapshot[string] | undefined,
  locale: string | undefined,
): string | undefined {
  return dimensionText(entry, "narrativeStyle", locale);
}

function deriveOpeningScenario(
  entry: DimensionSnapshot[string] | undefined,
  locale: string | undefined,
): string | undefined {
  return dimensionText(entry, "openingScenario", locale);
}
