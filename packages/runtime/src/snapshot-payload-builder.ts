/**
 * Snapshot payload builder (S4-T2, §A6).
 *
 * Aggregates all session-scoped state needed to rebuild a session on fork
 * or restore. Produces a `SnapshotPayload` from live store reads at the
 * moment of capture.
 *
 * Feature flag: `COVEL_SNAPSHOTS_V1=1`. Auto-snapshots are driven by the
 * turn-executor; manual and fork snapshots by the server routes.
 *
 * Session lorebook entries (FU-4 close-out): included once the store
 * exposes `listSessionLorebookEntries` (added in S3-T2). World- and
 * plugin-level lorebook data remain file-backed and are re-resolved by
 * the registry on the forked session — only session-scoped entries need
 * to travel with the snapshot.
 */

import type {
  DataStore,
  SnapshotPayload,
  CharacterRecord,
  StateEntryRecord,
  PluginDataRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
} from '@covel/store';

/**
 * Build a full snapshot payload for a session at a given turn.
 *
 * Reads characters, state entries (via state schemas to discover table names),
 * plugin data (walks sessions' rows via the `plugin_data` SQL LIKE fallback in
 * stores that support it, otherwise via plugin-id enumeration), working
 * memory, and the messages cursor.
 */
export async function buildSnapshotPayload(
  store: DataStore,
  sessionId: string,
  turnId: string,
): Promise<SnapshotPayload> {
  // Characters
  const characters: readonly CharacterRecord[] = await store.listCharacters(sessionId);

  // State entries — iterate known tables from state schemas.
  const stateSchemas = await store.listStateSchemas(sessionId);
  const stateEntries: StateEntryRecord[] = [];
  for (const s of stateSchemas) {
    const rows = await store.listStateEntries(sessionId, s.tableName);
    stateEntries.push(...rows);
  }

  // Plugin data — there is no "list all plugin data for a session" method;
  // the store API is intentionally plugin-scoped. We collect distinct
  // pluginIds that appeared in state changes / runtime results (via the
  // session's own derivatives) and walk each. For snapshots this is best
  // effort: if a plugin has no records yet it's correctly omitted.
  //
  // For the v1 payload, we walk all known plugin namespaces by asking the
  // store's listPluginData with every distinct pluginId we've seen. Stores
  // that don't want to implement a session-wide list stay clean.
  const pluginIds = await discoverPluginIds(store, sessionId);
  const pluginData: PluginDataRecord[] = [];
  for (const pid of pluginIds) {
    const rows = await store.listPluginData(sessionId, pid);
    pluginData.push(...rows);
  }

  // Working memory
  const workingMemory: readonly WorkingMemoryRecord[] = await store.listWorkingMemory(sessionId);

  // Messages cursor — last turn_message.id for this session.
  const turnMessages = await store.listTurnMessages(sessionId);
  const messagesCursor = turnMessages.length > 0 ? turnMessages[turnMessages.length - 1]!.id : '';

  // Session lorebook entries — FU-4 close-out. Only session-scoped entries
  // travel with the snapshot; world/plugin-level entries are re-resolved
  // from the package registry on the forked session.
  const lorebookEntries: readonly LorebookEntryRecord[] =
    typeof store.listSessionLorebookEntries === 'function'
      ? await store.listSessionLorebookEntries(sessionId)
      : [];

  return {
    schemaVersion: 1,
    turnId,
    characters,
    stateEntries,
    pluginData,
    workingMemory,
    lorebookEntries,
    messagesCursor,
  };
}

/**
 * Discover plugin ids that have any data for the given session.
 *
 * Uses runtime results as the source of truth: any plugin that has ever run
 * in the session has at least one runtime_result row. This is sufficient
 * because plugin data is always produced by a plugin runtime.
 */
async function discoverPluginIds(store: DataStore, sessionId: string): Promise<string[]> {
  // listRuntimeResults requires a turnId; we need everything. Walk turn
  // results (which already aggregate runtime results) instead.
  const turnResults = await store.listTurnResults(sessionId);
  const seen = new Set<string>();
  for (const tr of turnResults) {
    const runtimeResults = Array.isArray(tr.runtimeResults)
      ? (tr.runtimeResults as Array<Record<string, unknown>>)
      : [];
    for (const rr of runtimeResults) {
      const pid = typeof rr['pluginId'] === 'string' ? (rr['pluginId'] as string) : undefined;
      if (pid) seen.add(pid);
    }
  }
  return [...seen];
}
