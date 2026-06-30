/**
 * View adapters for `buildSessionContextSnapshot`.
 *
 * Extracted from `session-context.ts` so the loader stays focused on store
 * I/O and guard semantics.
 */

import { resolveI18nDeep } from "@covel/shared";
import type { WorldRecord } from "./session-context-store.js";
import type { WorldContextView } from "./types.js";

export interface BuildViewInput {
  readonly worldId?: string;
  readonly worldRecord: WorldRecord | null;
  readonly schemaMap: Record<string, unknown> | undefined;
  readonly entriesMap: Record<string, unknown> | undefined;
  /** Session locale — used to localize i18n dimensions before injection. */
  readonly locale?: string;
}

export function buildWorldContextView(input: BuildViewInput): WorldContextView {
  const worldRecord = input.worldRecord;
  if (!worldRecord && !input.worldId) {
    return { id: "", entries: [] };
  }
  const id = input.worldId ?? worldRecord?.id ?? "";

  const entriesArray = input.entriesMap
    ? Object.entries(input.entriesMap).map(([key, content]) => ({
        key,
        content,
      }))
    : [];

  let tone: string | undefined;
  let openingScenario: string | undefined;
  let dimensions: Record<string, unknown> | undefined;
  let extra: Record<string, unknown> | undefined;

  const metadata =
    worldRecord?.metadata && typeof worldRecord.metadata === "object"
      ? (worldRecord.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    const dims = metadata.dimensions;
    if (dims && typeof dims === "object") {
      // Localize i18n (`{ zh, en }`) leaves to the session locale BEFORE the
      // dimensions reach the prompt, so the narrator sees one language instead
      // of a raw bilingual blob (mirrors how `lore` is resolved at load time).
      // This also lets `tone` / `openingScenario` below extract cleanly when
      // they were authored as i18n records.
      dimensions = resolveI18nDeep(dims, input.locale) as Record<
        string,
        unknown
      >;
      const t = dimensions.tone;
      if (typeof t === "string") tone = t;
      const sc = dimensions.startingConditions;
      if (sc && typeof sc === "object") {
        const os = (sc as Record<string, unknown>).openingScenario;
        if (typeof os === "string") openingScenario = os;
      }
    }
    // Surface remaining metadata keys through `extra` for forward-compat.
    for (const [k, v] of Object.entries(metadata)) {
      if (k === "dimensions") continue;
      extra = extra ?? {};
      extra[k] = v;
    }
  }

  return {
    id,
    lore: worldRecord?.lore,
    tone,
    openingScenario,
    dimensions,
    schema: input.schemaMap,
    entries: entriesArray,
    extra,
  };
}
