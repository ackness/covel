/**
 * Session Snapshot Builder — aggregates all session data for client restore.
 *
 * Single entry point: buildSessionSnapshot(store, sessionId) → SessionSnapshot | null
 *
 * Queries in parallel: session, messages, characters, state entries, trace events.
 * Flattens message metadata and aggregates state entries by table.
 */

import type {
  SessionSnapshot,
  SnapshotMessage,
  SnapshotCharacter,
  SnapshotTraceEvent,
  TimeCursor,
} from "@covel/shared";
import { deriveLegacyClockForSession } from "@covel/shared";

/**
 * Restore windows: the snapshot ships the most-recent slice, not the whole
 * history, so a long session doesn't stream its entire message log and (the
 * fastest-growing) trace_events table into memory on every reconnect. Older
 * messages load on demand via the messages cursor endpoint; execution steps
 * for turns beyond the window degrade gracefully (timeline just doesn't render
 * for very old, scrolled-in turns).
 */
const SNAPSHOT_MESSAGE_LIMIT = 80;
const SNAPSHOT_TRACE_EVENT_LIMIT = 600;

/**
 * Minimal store interface for snapshot building.
 * Uses only the read methods it needs.
 *
 * Shape mirrors SessionRecord: `status` + `turnCount` + `preGameCompleted`
 * describe the session lifecycle and scheduling state.
 */
export interface SnapshotStore {
  getSession(id: string): Promise<{
    id: string;
    worldId?: string;
    status: string;
    turnCount: number;
    preGameCompleted?: readonly string[];
    locale?: string;
  } | null>;
  listMessagesPage(
    sessionId: string,
    opts: { limit: number; before?: TimeCursor },
  ): Promise<
    readonly {
      id: string;
      role: string;
      content: string;
      metadata?: unknown;
      createdAt: string;
    }[]
  >;
  listCharacters(sessionId: string): Promise<
    readonly {
      id: string;
      name: string;
      type: string;
      description?: string;
      fields?: unknown;
    }[]
  >;
  listStateSchemas(
    sessionId: string,
  ): Promise<readonly { tableName: string }[]>;
  listStateEntries(
    sessionId: string,
    tableName: string,
  ): Promise<
    readonly { tableName: string; fieldName: string; value: unknown }[]
  >;
  listTraceEventsPage(
    sessionId: string,
    opts: { limit: number; before?: TimeCursor },
  ): Promise<
    readonly {
      type: string;
      turnId: string;
      payload: unknown;
      createdAt: string;
    }[]
  >;
}

/**
 * Build a complete session snapshot for client restore/reconnection.
 * Returns null if the session doesn't exist.
 */
export async function buildSessionSnapshot(
  store: SnapshotStore,
  sessionId: string,
): Promise<SessionSnapshot | null> {
  const session = await store.getSession(sessionId);
  if (!session) return null;

  // Parallel queries for all session data. Messages + trace events are
  // windowed to the most-recent slice (see the *_LIMIT constants); older
  // messages load on demand via the cursor endpoint.
  const [rawMessages, characters, stateSchemas, traceEvents] =
    await Promise.all([
      store.listMessagesPage(sessionId, { limit: SNAPSHOT_MESSAGE_LIMIT }),
      store.listCharacters(sessionId),
      store.listStateSchemas(sessionId),
      store.listTraceEventsPage(sessionId, {
        limit: SNAPSHOT_TRACE_EVENT_LIMIT,
      }),
    ]);

  // A full window (=== limit) means older messages exist; hand back the oldest
  // returned position as the cursor to fetch them. A short window reaches the
  // start of history, so there is nothing older → null.
  const oldest = rawMessages[0];
  const messagesCursor: TimeCursor | null =
    rawMessages.length === SNAPSHOT_MESSAGE_LIMIT && oldest
      ? { createdAt: oldest.createdAt, id: oldest.id }
      : null;

  // Query state entries per table (schemas → entries)
  const stateEntries = (
    await Promise.all(
      stateSchemas.map((s) => store.listStateEntries(sessionId, s.tableName)),
    )
  ).flat();

  // Flatten message metadata
  const messages: SnapshotMessage[] = rawMessages.map((m) => {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      id: m.id,
      role: m.role,
      content: m.content,
      turnId: meta.turnId as string | undefined,
      runtimeId: meta.runtimeId as string | undefined,
      kind: meta.kind as string | undefined,
      block: meta.block as Record<string, unknown> | undefined,
      createdAt: m.createdAt,
    };
  });

  // Map characters
  const snapshotCharacters: SnapshotCharacter[] = characters.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    description: c.description,
    fields: c.fields as Record<string, unknown> | undefined,
  }));

  // Aggregate state entries by table → { table: { field: value } }
  const gameState: Record<string, Record<string, unknown>> = {};
  for (const entry of stateEntries) {
    if (!gameState[entry.tableName]) {
      gameState[entry.tableName] = {};
    }
    gameState[entry.tableName][entry.fieldName] = entry.value;
  }

  // Map trace events
  const executionSteps: SnapshotTraceEvent[] = traceEvents.map((t) => ({
    type: t.type,
    turnId: t.turnId,
    payload: (t.payload ?? {}) as Record<string, unknown>,
    timestamp: t.createdAt,
  }));

  return {
    session: {
      id: session.id,
      worldId: session.worldId,
      turnCount: deriveLegacyClockForSession(session).turnCount,
      locale: session.locale,
    },
    messages,
    messagesCursor,
    characters: snapshotCharacters,
    gameState,
    executionSteps,
    plugins: [], // Populated by the route handler from PluginRegistry
  };
}
