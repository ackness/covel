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
  SuspensionRecord,
} from "@covel/store";

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
  const characters: readonly CharacterRecord[] =
    await store.listCharacters(sessionId);

  // State entries — iterate known tables from state schemas.
  const stateSchemas = await store.listStateSchemas(sessionId);
  const stateEntries: StateEntryRecord[] = [];
  for (const s of stateSchemas) {
    const rows = await store.listStateEntries(sessionId, s.tableName);
    stateEntries.push(...rows);
  }

  // Plugin data — union two sources:
  //  1. pluginIds appearing in any runtime_result for the session.
  //  2. pluginIds that actually wrote plugin_data (via the session-scope
  //     list — audit 2026-04-20 finding 7.2). Source #1 alone misses
  //     plugins that wrote during install hooks, data-only providers, and
  //     plugins that suspended before producing any runtime result.
  const pluginIds = await discoverPluginIds(store, sessionId);
  const pluginData: PluginDataRecord[] = [];
  for (const pid of pluginIds) {
    const rows = await store.listPluginData(sessionId, pid);
    pluginData.push(...rows);
  }

  // Working memory
  const workingMemory: readonly WorkingMemoryRecord[] =
    await store.listWorkingMemory(sessionId);

  // Messages cursor — last turn_message.id for this session.
  const turnMessages = await store.listTurnMessages(sessionId);
  const messagesCursor =
    turnMessages.length > 0 ? turnMessages[turnMessages.length - 1]!.id : "";

  // Session lorebook entries — FU-4 close-out. Only session-scoped entries
  // travel with the snapshot; world/plugin-level entries are re-resolved
  // from the package registry on the forked session.
  const lorebookEntries: readonly LorebookEntryRecord[] =
    typeof store.listSessionLorebookEntries === "function"
      ? await store.listSessionLorebookEntries(sessionId)
      : [];

  // Suspensions — capture only unresolved records (audit 2026-04-20
  // finding 7.3). Resolved / claimed (`resolvedAt` set) suspensions are
  // either already finished or in-flight; the child session has no way to
  // take over a mid-flight resume, so they are excluded. Each record's
  // `pendingContinuation` travels with the snapshot so a forked session can
  // POST /resume with the copy.
  const allSuspensions: readonly SuspensionRecord[] =
    await store.listSuspensions(sessionId);
  const suspensions: readonly SuspensionRecord[] = allSuspensions.filter(
    (s) => s.resolvedAt === undefined,
  );

  return {
    schemaVersion: 1,
    turnId,
    characters,
    stateEntries,
    pluginData,
    workingMemory,
    lorebookEntries,
    suspensions,
    messagesCursor,
  };
}

/**
 * Discover plugin ids that have any data for the given session.
 *
 * Union of two sources (audit 2026-04-20 finding 7.2):
 *  - Runtime results — any plugin that ever ran in the session.
 *  - Plugin data — any plugin that ever wrote to `plugin_data`, even if it
 *    never produced a runtime result (install hooks, data-only providers,
 *    plugins that suspended before completing their first turn).
 *
 * Previously only the runtime-result source was walked, which silently
 * dropped plugins of the second shape from the snapshot payload.
 */
async function discoverPluginIds(
  store: DataStore,
  sessionId: string,
): Promise<string[]> {
  const [turnResults, pluginDataRows] = await Promise.all([
    store.listTurnResults(sessionId),
    store.listPluginDataSessionScope(sessionId),
  ]);
  const seen = new Set<string>();
  for (const tr of turnResults) {
    const runtimeResults = Array.isArray(tr.runtimeResults)
      ? (tr.runtimeResults as Array<Record<string, unknown>>)
      : [];
    for (const rr of runtimeResults) {
      const pid =
        typeof rr["pluginId"] === "string"
          ? (rr["pluginId"] as string)
          : undefined;
      if (pid) seen.add(pid);
    }
  }
  for (const row of pluginDataRows) {
    if (row.pluginId) seen.add(row.pluginId);
  }
  return [...seen];
}
