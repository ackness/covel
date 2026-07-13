/**
 * Snapshot payload builder (S4-T2, §A6).
 *
 * Aggregates all session-scoped state needed to rebuild a session on fork
 * or restore. Produces a `SnapshotPayload` from live store reads at the
 * moment of capture.
 *
 * Automatic snapshots are captured by the server after proposal commit;
 * manual and fork snapshots are captured by the server routes as well.
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
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found while building snapshot: ${sessionId}`);
  }

  // Characters
  const characters: readonly CharacterRecord[] =
    await store.listCharacters(sessionId);

  // State entries — query all known tables in parallel (audit 2026-06-04
  // finding M2; previously a serial await-in-loop adding one RTT per table).
  const stateSchemas = await store.listStateSchemas(sessionId);
  const stateEntries: StateEntryRecord[] = (
    await Promise.all(
      stateSchemas.map((s) => store.listStateEntries(sessionId, s.tableName)),
    )
  ).flat();

  // Plugin data — union two sources:
  //  1. pluginIds appearing in any runtime_result for the session.
  //  2. pluginIds that actually wrote plugin_data (via the session-scope
  //     list — audit 2026-04-20 finding 7.2). Source #1 alone misses
  //     plugins that wrote during install hooks, data-only providers, and
  //     plugins that suspended before producing any runtime result.
  //
  // The session-scope list already returns every plugin_data row for the
  // session in one query (audit 2026-06-04 finding M1), so we filter that
  // result by the discovered plugin-id set rather than re-querying per
  // pluginId. Source #1 only ever *adds* ids that have no plugin_data rows,
  // so filtering by the union still yields exactly the source-#2 rows.
  const { pluginIds, pluginDataRows } = await discoverPluginIds(
    store,
    sessionId,
  );
  const pluginData: PluginDataRecord[] = pluginDataRows.filter((row) =>
    pluginIds.has(row.pluginId),
  );

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
    schemaVersion: 2,
    turnId,
    session: {
      status: session.status,
      turnCount: session.turnCount,
      preGameCompleted: session.preGameCompleted,
      locale: session.locale,
      activePlugins: session.activePlugins,
      presetId: session.presetId,
      runtimeModelOverrides: session.runtimeModelOverrides,
    },
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
): Promise<{
  pluginIds: ReadonlySet<string>;
  pluginDataRows: readonly PluginDataRecord[];
}> {
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
  return { pluginIds: seen, pluginDataRows };
}
