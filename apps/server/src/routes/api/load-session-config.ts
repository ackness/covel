/**
 * Pre-load plugin config data for context injection.
 *
 * Bridges async store reads to sync `getConfig` interface by loading
 * all relevant plugin_data + world info at the start of each turn.
 *
 * NOTE: The framework MUST NOT hardcode any plugin ID. The world data provider
 * plugin ID is discovered via the `world-data-provider` capability tag declared
 * in the plugin's RuntimeManifest.
 *
 * ## `{{ config.worldEntries }}` resolution order (FU-8)
 *
 * 1. **Session lorebook** (canonical) — aggregate all `constant` entries from
 *    `listSessionLorebookEntries`, sorted by `insertionOrder`, joined on blank
 *    lines. This is the post-FU-8 destination for world dimensions.
 * 2. **Plugin data** (fallback) — read the world-data-provider plugin's
 *    `entries` namespace. Covers sessions created before the lorebook
 *    migration and thin mock stores that don't implement the lorebook table.
 *
 * `{{ config.worldSchema }}` keeps its plugin_data source — world schemas are
 * structured JSON, not a natural fit for the free-form lorebook content field.
 *
 * ## Sprint 1-D
 *
 * When `COVEL_SESSION_CONTEXT=1`, this function delegates to
 * `buildSessionContextSnapshot` and returns its `legacyConfigView`. The
 * snapshot's legacy view is engineered to be byte-identical to this
 * function's original output (same keys, same insertion order, same
 * "absent when empty" rule). When the flag is off, the original scattered
 * loads below run unchanged.
 */

import { buildSessionContextSnapshot } from '@covel/context';
import type { DataStore, LorebookEntryRecord } from '@covel/store';

export async function loadSessionConfig(
  store: DataStore,
  sessionId: string,
  worldId?: string,
  worldDataPluginId?: string,
): Promise<Readonly<Record<string, unknown>>> {
  // Sprint 1-D: prefer the unified snapshot loader when the flag is on.
  // `legacyConfigView` is byte-compatible with the legacy implementation, so
  // callers see no observable change beyond fewer round-trips.
  if (process.env.COVEL_SESSION_CONTEXT === '1') {
    try {
      const snapshot = await buildSessionContextSnapshot(store, sessionId, {
        // `legacyConfigView` does not consult locale / turnNumber; pass
        // stable placeholders so other snapshot fields stay well-formed.
        locale: 'zh-CN',
        turnNumber: 0,
        worldId,
        worldDataPluginId,
      });
      return snapshot.legacyConfigView;
    } catch (err) {
      // Non-critical: fall back to the legacy path if snapshot build fails.
      console.warn(
        '[loadSessionConfig] Snapshot delegation failed, falling back to legacy path:',
        err instanceof Error ? err.message : String(err),
      );
      // Fall through to legacy branch below.
    }
  }

  // Legacy path (flag-off or snapshot fallback). Preserved verbatim.
  const configData: Record<string, unknown> = {};

  try {
    // Load world schema/entries from the plugin that declares `world-data-provider` capability.
    // If no such plugin is found, skip gracefully.
    if (worldDataPluginId) {
      const schemaRecords = await store.listPluginData(sessionId, worldDataPluginId, 'schema');

      if (schemaRecords.length > 0) {
        const schemaMap: Record<string, unknown> = {};
        for (const r of schemaRecords) schemaMap[r.key] = r.value;
        configData.worldSchema = schemaMap;
      }

      // worldEntries: prefer lorebook (canonical, FU-8), fall back to plugin_data.
      const lorebookEntries = await readLorebookWorldEntries(store, sessionId, worldDataPluginId);
      if (lorebookEntries !== undefined) {
        configData.worldEntries = lorebookEntries;
      } else {
        const entryRecords = await store.listPluginData(sessionId, worldDataPluginId, 'entries');
        if (entryRecords.length > 0) {
          const entryMap: Record<string, unknown> = {};
          for (const r of entryRecords) entryMap[r.key] = r.value;
          configData.worldEntries = entryMap;
        }
      }
    }

    if (worldId) {
      const world = await store.getWorld(worldId);
      if (world?.metadata) {
        const meta = world.metadata as Record<string, unknown>;
        const dims = meta.dimensions;
        if (dims) {
          configData.worldDimensions = dims;
          // Extract nested fields for template convenience
          if (typeof dims === 'object' && dims !== null) {
            const d = dims as Record<string, unknown>;
            if (d.tone) configData.worldTone = d.tone;
            const sc = d.startingConditions as Record<string, unknown> | undefined;
            if (sc?.openingScenario) configData.worldOpeningScenario = sc.openingScenario;
          }
        }
      }
      if (world?.lore) configData.worldLore = world.lore;
    }
  } catch (err) {
    console.warn('[loadSessionConfig] Failed to pre-load config:', err);
  }

  return configData;
}

/**
 * Read session-scoped lorebook entries and compose them into the legacy
 * `worldEntries` map shape expected by plugin templates.
 *
 * Returns:
 * - `undefined` if the store has no session lorebook entries for this
 *   world-data-provider plugin (caller should fall back to plugin_data).
 * - A `Record<string, unknown>` keyed by the first lorebook `keys[]`
 *   entry (or the row id when no keys are declared). Values are the
 *   lorebook content string so templates rendering `{{ config.worldEntries }}`
 *   can still iterate entries by key.
 *
 * Entries are filtered to `strategy === 'constant'` so selective entries
 * (which are activated by scanning, not bulk-injected) don't leak into
 * the always-on config surface.
 */
async function readLorebookWorldEntries(
  store: DataStore,
  sessionId: string,
  worldDataPluginId: string,
): Promise<Record<string, unknown> | undefined> {
  if (typeof store.listSessionLorebookEntries !== 'function') {
    return undefined;
  }
  let entries: readonly LorebookEntryRecord[];
  try {
    entries = await store.listSessionLorebookEntries(sessionId);
  } catch (err) {
    console.warn('[loadSessionConfig] listSessionLorebookEntries failed:', err);
    return undefined;
  }
  const relevant = entries
    .filter(e => e.pluginId === worldDataPluginId && e.strategy === 'constant' && e.enabled)
    .slice()
    .sort((a, b) => a.insertionOrder - b.insertionOrder);
  if (relevant.length === 0) {
    return undefined;
  }
  const map: Record<string, unknown> = {};
  for (const entry of relevant) {
    const key = (entry.keys && entry.keys.length > 0) ? entry.keys[0] : entry.id;
    map[key] = entry.content;
  }
  return map;
}
