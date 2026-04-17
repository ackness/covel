/**
 * Snapshot / Fork routes (S4-T2, §A6).
 *
 * Materialized state snapshots power save / load / fork. The snapshots_v1
 * feature flag gates all endpoints: when off, every route returns 503 to
 * match the established suspend/resume flag behaviour.
 *
 *   POST   /api/sessions/:id/snapshot    — create manual snapshot
 *   GET    /api/sessions/:id/snapshots   — list snapshots
 *   POST   /api/sessions/:id/fork        — create new session from snapshot
 *
 * Auto snapshots (kind='auto') are written by the turn-executor at turn
 * commit time; this route module only exposes the manual/fork surfaces.
 *
 * Fork strategy: COPY. We rebuild the child session by persisting the
 * snapshot's characters / state entries / plugin data / working memory
 * into the new sessionId. Messages are copied from the parent up to
 * `payload.messagesCursor` — past that cursor the child starts fresh.
 * Copying (rather than referencing) keeps cross-session semantics clean
 * and lets either branch be deleted independently.
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type {
  DataStore,
  SnapshotRecord,
  CharacterRecord,
  StateEntryRecord,
  PluginDataRecord,
  WorkingMemoryRecord,
  TurnMessageRecord,
} from '@covel/store';
import { buildSnapshotPayload } from '@covel/runtime';
import type { EventBus } from '@covel/events';

type Env = {
  Variables: {
    store: DataStore;
    eventBus?: EventBus;
  };
};

export const snapshotRoutes = new Hono<Env>();

const SAFE_SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/i;

const FLAG_OFF_BODY = {
  error: 'Snapshot / fork feature is not enabled (COVEL_SNAPSHOTS_V1)',
  code: 'feature_disabled',
} as const;

function flagOn(): boolean {
  return process.env['COVEL_SNAPSHOTS_V1'] === '1';
}

// ── POST /api/sessions/:id/snapshot — manual snapshot ─────────────

snapshotRoutes.post('/:id/snapshot', async (c) => {
  if (!flagOn()) return c.json(FLAG_OFF_BODY, 503);

  const sessionId = c.req.param('id');
  const store = c.get('store');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found', code: 'not_found' }, 404);
  }

  // Derive a turnId for the snapshot — use the latest turn_result we can
  // find, or fall back to the session's turnCount so fresh sessions still
  // produce a usable label.
  const turnResults = await store.listTurnResults(sessionId);
  const latestTurnId = turnResults.length > 0
    ? turnResults[turnResults.length - 1]!.turnId
    : `turn-${session.turnCount}`;

  let payload;
  try {
    payload = await buildSnapshotPayload(store, sessionId, latestTurnId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Failed to build snapshot payload: ${message}`, code: 'build_failed' }, 500);
  }

  const now = new Date().toISOString();
  const snapshot: SnapshotRecord = {
    id: randomUUID(),
    sessionId,
    turnId: latestTurnId,
    kind: 'manual',
    payload,
    createdAt: now,
  };

  await store.saveSnapshot(snapshot);

  // S4-T5: Emit state.snapshot.created so reactive UI can refresh snapshot lists.
  // EventBus is optional in tests; only emit when bound.
  const eventBus = c.get('eventBus');
  if (eventBus) {
    eventBus.emit({
      id: randomUUID(),
      type: 'event',
      topic: 'session',
      sessionId,
      timestamp: now,
      payload: {
        _subTopic: 'session',
        _subType: 'state.snapshot.created',
        turnId: latestTurnId,
        snapshotId: snapshot.id,
        kind: 'manual',
      },
    });
  }

  return c.json({ snapshot }, 201);
});

// ── GET /api/sessions/:id/snapshots — list snapshots ──────────────

snapshotRoutes.get('/:id/snapshots', async (c) => {
  if (!flagOn()) return c.json(FLAG_OFF_BODY, 503);

  const sessionId = c.req.param('id');
  const store = c.get('store');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found', code: 'not_found' }, 404);
  }

  const snapshots = await store.listSnapshots(sessionId);
  return c.json({ snapshots });
});

// ── POST /api/sessions/:id/fork — fork from snapshot ──────────────

snapshotRoutes.post('/:id/fork', async (c) => {
  if (!flagOn()) return c.json(FLAG_OFF_BODY, 503);

  const parentSessionId = c.req.param('id');
  const store = c.get('store');

  let body: { fromSnapshotId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body', code: 'invalid_body' }, 400);
  }

  const fromSnapshotId = typeof body.fromSnapshotId === 'string' ? body.fromSnapshotId : undefined;
  if (!fromSnapshotId) {
    return c.json({ error: 'fromSnapshotId is required', code: 'invalid_body' }, 400);
  }

  const parentSession = await store.getSession(parentSessionId);
  if (!parentSession) {
    return c.json({ error: 'Parent session not found', code: 'not_found' }, 404);
  }

  const snapshot = await store.getSnapshot(fromSnapshotId);
  if (!snapshot || snapshot.sessionId !== parentSessionId) {
    return c.json({ error: 'Snapshot not found', code: 'not_found' }, 404);
  }

  // Mint the child session id. Format `{worldId}-{uuid8}` matches
  // POST /api/sessions (session.ts). worldId falls back to 'fork' for
  // sessions without one — SAFE_SESSION_ID_RE still accepts it.
  const prefix = parentSession.worldId ?? 'fork';
  const childSessionId = `${prefix}-${randomUUID().slice(0, 8)}`;
  if (!SAFE_SESSION_ID_RE.test(childSessionId)) {
    // Defensive — worldId already validated on parent creation, but fail
    // loudly rather than persist an id that would trip other routes.
    return c.json({ error: 'Failed to mint valid child session id', code: 'fork_failed' }, 500);
  }

  const now = new Date().toISOString();

  await store.beginTx?.();
  try {
    // Create the child session. Reuse parent's locale + activePlugins so
    // the forked run lands on the same plugin scope.
    await store.createSession({
      id: childSessionId,
      worldId: parentSession.worldId,
      status: parentSession.status,
      turnCount: parentSession.turnCount,
      preGameCompleted: parentSession.preGameCompleted,
      locale: parentSession.locale,
      activePlugins: parentSession.activePlugins,
      createdAt: now,
      updatedAt: now,
    });

    // Copy characters. Mint fresh ids because several store backends key
    // characters by `id` alone — reusing the parent's id would overwrite
    // the parent's row in those backends.
    for (const ch of snapshot.payload.characters) {
      const record: CharacterRecord = {
        ...ch,
        id: randomUUID(),
        sessionId: childSessionId,
      };
      await store.upsertCharacter(record);
    }

    // Copy state schemas (needed so stateEntries can be listed by the child)
    const parentSchemas = await store.listStateSchemas(parentSessionId);
    for (const s of parentSchemas) {
      await store.saveStateSchema({
        ...s,
        id: randomUUID(),
        sessionId: childSessionId,
        createdAt: now,
      });
    }

    // Copy state entries
    for (const se of snapshot.payload.stateEntries) {
      const record: StateEntryRecord = {
        ...se,
        id: randomUUID(),
        sessionId: childSessionId,
      };
      await store.upsertStateEntry(record);
    }

    // Copy plugin data
    const pluginDataBatch: PluginDataRecord[] = snapshot.payload.pluginData.map((pd) => ({
      ...pd,
      id: randomUUID(),
      sessionId: childSessionId,
    }));
    if (pluginDataBatch.length > 0) {
      await store.setPluginDataBatch(pluginDataBatch);
    }

    // Copy working memory
    for (const wm of snapshot.payload.workingMemory) {
      const record: WorkingMemoryRecord = {
        ...wm,
        id: randomUUID(),
        sessionId: childSessionId,
      };
      await store.upsertWorkingMemory(record);
    }

    // Copy turn messages up to and including the snapshot's cursor.
    // Strategy: read all parent messages in order, copy each with a fresh
    // id to the child, stop after the cursor. Empty cursor = no messages.
    if (snapshot.payload.messagesCursor !== '') {
      const parentMessages = await store.listTurnMessages(parentSessionId);
      for (const m of parentMessages) {
        const copy: TurnMessageRecord = {
          ...m,
          id: randomUUID(),
          sessionId: childSessionId,
        };
        await store.appendTurnMessage(copy);
        if (m.id === snapshot.payload.messagesCursor) break;
      }
    }

    // Record a 'fork' snapshot on the child so the provenance graph is
    // traversable from either direction.
    const forkSnapshot: SnapshotRecord = {
      id: randomUUID(),
      sessionId: childSessionId,
      turnId: snapshot.turnId,
      kind: 'fork',
      parentId: snapshot.id,
      payload: snapshot.payload,
      createdAt: now,
    };
    await store.saveSnapshot(forkSnapshot);

    await store.commitTx?.();

    // Emit session.forked on the event bus (out-of-band SSE listeners
    // pick it up and update any session lists they show). Kernel-only
    // when eventBus is absent in tests.
    const eventBus = c.get('eventBus');
    if (eventBus) {
      // S4-T5: also publish state.snapshot.created (kind='fork') so a
      // forked session's snapshot list reacts immediately.
      eventBus.emit({
        id: randomUUID(),
        type: 'event',
        topic: 'session',
        sessionId: childSessionId,
        timestamp: now,
        payload: {
          _subTopic: 'session',
          _subType: 'state.snapshot.created',
          turnId: snapshot.turnId,
          snapshotId: forkSnapshot.id,
          kind: 'fork',
          parentSnapshotId: snapshot.id,
        },
      });

      eventBus.emit({
        id: randomUUID(),
        type: 'event',
        topic: 'session',
        sessionId: childSessionId,
        timestamp: now,
        payload: {
          _subTopic: 'session',
          _subType: 'session.forked',
          parentSessionId,
          childSessionId,
          fromSnapshotId: snapshot.id,
          forkSnapshotId: forkSnapshot.id,
        },
      });
    }

    return c.json(
      {
        sessionId: childSessionId,
        parentSessionId,
        fromSnapshotId: snapshot.id,
        forkSnapshotId: forkSnapshot.id,
      },
      201,
    );
  } catch (err) {
    try {
      await store.rollbackTx?.();
    } catch {
      // Ignore rollback errors — surface the original failure.
    }
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Fork failed: ${message}`, code: 'fork_failed' }, 500);
  }
});
