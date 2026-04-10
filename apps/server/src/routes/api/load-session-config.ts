/**
 * Pre-load plugin config data for context injection.
 *
 * Bridges async store reads to sync `getConfig` interface by loading
 * all relevant plugin_data + world info at the start of each turn.
 *
 * NOTE: The framework MUST NOT hardcode any plugin ID. The world data provider
 * plugin ID is discovered via the `world-data-provider` capability tag declared
 * in the plugin's RuntimeManifest.
 */

import type { DataStore } from '@covel/store';

export async function loadSessionConfig(
  store: DataStore,
  sessionId: string,
  worldId?: string,
  worldDataPluginId?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const configData: Record<string, unknown> = {};

  try {
    // Load world schema/entries from the plugin that declares `world-data-provider` capability.
    // If no such plugin is found, skip gracefully.
    if (worldDataPluginId) {
      const schemaRecords = await store.listPluginData(sessionId, worldDataPluginId, 'schema');
      const entryRecords = await store.listPluginData(sessionId, worldDataPluginId, 'entries');

      if (schemaRecords.length > 0) {
        const schemaMap: Record<string, unknown> = {};
        for (const r of schemaRecords) schemaMap[r.key] = r.value;
        configData.worldSchema = schemaMap;
      }

      if (entryRecords.length > 0) {
        const entryMap: Record<string, unknown> = {};
        for (const r of entryRecords) entryMap[r.key] = r.value;
        configData.worldEntries = entryMap;
      }
    }

    if (worldId) {
      const world = await store.getWorld(worldId);
      if (world?.metadata) {
        const dims = (world.metadata as Record<string, unknown>).dimensions;
        if (dims) configData.worldDimensions = dims;
      }
      if (world?.lore) configData.worldLore = world.lore;
    }
  } catch (err) {
    console.warn('[loadSessionConfig] Failed to pre-load config:', err);
  }

  return configData;
}
