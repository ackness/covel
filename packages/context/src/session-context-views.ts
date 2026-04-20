/**
 * View adapters for `buildSessionContextSnapshot`.
 *
 * Extracted from `session-context.ts` so the loader stays focused on store
 * I/O and guard semantics. Two adapters here:
 *
 *  - `buildWorldContextView` — structured `WorldContextView` for new
 *    consumers (Sprint 2 lorebook activator, plugin UI).
 *  - `buildLegacyConfigView` — byte-identical reproduction of
 *    `apps/server/src/routes/api/load-session-config.ts` output so the
 *    existing `{{ config.* }}` template surface does not regress while the
 *    refactor is rolling.
 */

import type { WorldRecord } from '@covel/store';
import type { WorldContextView } from './types.js';

export interface BuildViewInput {
  readonly worldId?: string;
  readonly worldRecord: WorldRecord | null;
  readonly schemaMap: Record<string, unknown> | undefined;
  readonly entriesMap: Record<string, unknown> | undefined;
}

export function buildWorldContextView(input: BuildViewInput): WorldContextView {
  const worldRecord = input.worldRecord;
  if (!worldRecord && !input.worldId) {
    return { id: '' };
  }
  const id = input.worldId ?? worldRecord?.id ?? '';

  // Design decision: `WorldContextView.entries` is an array of
  // `{ key, content }` rows so consumers can iterate deterministically; the
  // map-shaped `legacyConfigView.worldEntries` remains untouched for
  // byte-for-byte parity with `loadSessionConfig`. The array form is the
  // Sprint 2 activator's preferred input shape.
  const entriesArray = input.entriesMap
    ? Object.entries(input.entriesMap).map(([key, content]) => ({ key, content }))
    : [];

  let tone: string | undefined;
  let openingScenario: string | undefined;
  let dimensions: Record<string, unknown> | undefined;
  let extra: Record<string, unknown> | undefined;

  const metadata =
    worldRecord?.metadata && typeof worldRecord.metadata === 'object'
      ? (worldRecord.metadata as Record<string, unknown>)
      : undefined;
  if (metadata) {
    const dims = metadata.dimensions;
    if (dims && typeof dims === 'object') {
      dimensions = dims as Record<string, unknown>;
      const t = dimensions.tone;
      if (typeof t === 'string') tone = t;
      const sc = dimensions.startingConditions;
      if (sc && typeof sc === 'object') {
        const os = (sc as Record<string, unknown>).openingScenario;
        if (typeof os === 'string') openingScenario = os;
      }
    }
    // Surface remaining metadata keys through `extra` for forward-compat.
    for (const [k, v] of Object.entries(metadata)) {
      if (k === 'dimensions') continue;
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

/**
 * Reproduce `loadSessionConfig` output byte-for-byte: same keys (absent
 * when the source is empty), same insertion order, same value shapes.
 */
export function buildLegacyConfigView(input: BuildViewInput): Readonly<Record<string, unknown>> {
  const configData: Record<string, unknown> = {};

  try {
    if (input.schemaMap !== undefined) {
      configData.worldSchema = input.schemaMap;
    }
    if (input.entriesMap !== undefined) {
      configData.worldEntries = input.entriesMap;
    }
    const worldRecord = input.worldRecord;
    if (worldRecord?.metadata) {
      const meta = worldRecord.metadata as Record<string, unknown>;
      const dims = meta.dimensions;
      if (dims) {
        configData.worldDimensions = dims;
        if (typeof dims === 'object' && dims !== null) {
          const d = dims as Record<string, unknown>;
          if (d.tone) configData.worldTone = d.tone;
          const sc = d.startingConditions as Record<string, unknown> | undefined;
          if (sc?.openingScenario) configData.worldOpeningScenario = sc.openingScenario;
        }
      }
    }
    if (worldRecord?.lore) configData.worldLore = worldRecord.lore;
  } catch (err) {
    // Mirror loadSessionConfig's broad try/catch + warn.
    console.warn('[buildSessionContextSnapshot] Failed to pre-load config:', err);
  }

  return configData;
}
