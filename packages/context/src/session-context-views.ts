/**
 * View adapters for `buildSessionContextSnapshot`.
 *
 * Extracted from `session-context.ts` so the loader stays focused on store
 * I/O and guard semantics.
 */

import {
  WORLD_LOCALIZED_TEXT_KEY,
  WORLD_PACKAGE_INFO_KEY,
  localizedWorldText,
  modelFacingJson,
  resolveI18nDeep,
} from "@covel/shared";
import type { DimensionSnapshot } from "@covel/shared";
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

  const metadata =
    worldRecord?.metadata && typeof worldRecord.metadata === "object"
      ? (worldRecord.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    // Surface remaining metadata keys through `extra` for forward-compat.
    for (const [k, v] of Object.entries(metadata)) {
      if (k === "dimensions" || k === WORLD_LOCALIZED_TEXT_KEY) continue;
      // Credits are the package author's own text, for cards only. Keeping
      // them out of prompt templates means that text never reaches a model.
      if (k === WORLD_PACKAGE_INFO_KEY) continue;
      extra = extra ?? {};
      extra[k] = v;
    }
  }

  return {
    id,
    // The session's language, when the world ships that translation.
    ...localizedWorldText(worldRecord, input.locale),
    tags: worldRecord?.tags,
    lore: worldRecord?.lore,
    dimensions: structuredClone(input.dimensions ?? {}),
    dimensionProviderPluginId: input.dimensionProviderPluginId,
    // Localize i18n leaves in the schema too (e.g. attribute `name` /
    // `description` records) so prompt-injected `<world-schema>` shows one
    // language, mirroring how dimensions are resolved above. The record's
    // session ID and times are not part of what a prompt shows.
    schema:
      input.schemaMap !== undefined
        ? (modelFacingJson(
            resolveI18nDeep(input.schemaMap, input.locale),
          ) as Record<string, unknown>)
        : undefined,
    entries: entriesArray,
    extra,
  };
}
