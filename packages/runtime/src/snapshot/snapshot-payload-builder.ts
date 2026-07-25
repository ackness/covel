/**
 * Snapshot payload builder.
 *
 * Aggregates all session-scoped state needed to rebuild a session on fork
 * or restore. Produces a `SnapshotPayload` from live store reads at the
 * moment of capture.
 *
 * Automatic snapshots are captured by the server after proposal commit —
 * throttled to checkpoint cadence by `saveAutoSnapshot` (audit 2026-07-11
 * R-04), which is what keeps the full store reads below (message history in
 * particular is O(T)) off the per-turn hot path. Manual and fork snapshots
 * are captured by the server routes as well.
 *
 * Session lorebook entries: included once the store
 * exposes `listSessionLorebookEntries`. World- and
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
import { deriveLegacyClockForSession } from "@covel/shared";

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
  // One query returns every plugin_data row for the session, which is exactly
  // what the payload needs: a plugin with no rows contributes nothing here,
  // and a plugin that never produced a runtime result still travels.
  const pluginData: readonly PluginDataRecord[] =
    await store.listPluginDataSessionScope(sessionId);

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
    // V3 captures the scheduling-redesign lifecycle fields
    // (`phase` / `completedPlayerTurns` / `setupRuntimes`) alongside the V2
    // state so a fork resumes in the correct band with its setup mirror intact.
    // All three are optional — a session written before the kernel populated
    // them simply omits them, and fork upgrades legacy payloads on read.
    schemaVersion: 3,
    turnId,
    session: {
      status: session.status,
      // Legacy clock fields derived from the phase/setup mirror (the kernel no
      // longer writes the columns) so a fork restores consistent values.
      ...deriveLegacyClockForSession(session),
      locale: session.locale,
      activePlugins: session.activePlugins,
      presetId: session.presetId,
      runtimeModelOverrides: session.runtimeModelOverrides,
      ...(session.phase !== undefined ? { phase: session.phase } : {}),
      ...(session.completedPlayerTurns !== undefined
        ? { completedPlayerTurns: session.completedPlayerTurns }
        : {}),
      ...(session.setupRuntimes !== undefined
        ? { setupRuntimes: session.setupRuntimes }
        : {}),
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
