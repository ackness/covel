/**
 * Tests for the snapshot / fork API routes (S4-T2).
 *
 * POST   /api/sessions/:id/snapshot   — create manual snapshot
 * GET    /api/sessions/:id/snapshots  — list snapshots
 * POST   /api/sessions/:id/fork       — create new session from snapshot
 *
 * Feature flag: COVEL_SNAPSHOTS_V1=1. When off every route returns 503.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createMemoryStore, type DataStore } from '@covel/store';
import { createEventBus, type EventBus } from '@covel/events';
import type { CovelMessage } from '@covel/shared';
import { snapshotRoutes } from '../../src/routes/api/snapshots.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTestApp(store: DataStore, eventBus?: EventBus) {
  const app = new Hono<{ Variables: { store: DataStore; eventBus?: EventBus } }>();
  app.use('*', async (c, next) => {
    c.set('store', store);
    if (eventBus) c.set('eventBus', eventBus);
    await next();
  });
  app.route('/api/sessions', snapshotRoutes);
  return app;
}

/** Capture every event emitted on the bus during the test. */
function collectEvents(eventBus: EventBus): CovelMessage[] {
  const captured: CovelMessage[] = [];
  eventBus.on('*', (msg) => {
    captured.push(msg);
  });
  return captured;
}

async function createSession(store: DataStore, id = 'sess-1', worldId = 'test-world') {
  await store.createSession({
    id,
    worldId,
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    locale: 'zh-CN',
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function seedSessionData(store: DataStore, sessionId: string) {
  // Add a character, a plugin-data entry, a working-memory entry, a turn message,
  // and a turn result so the snapshot payload has something to serialize.
  const now = new Date().toISOString();
  await store.upsertCharacter({
    id: `${sessionId}-hero`,
    sessionId,
    name: 'Hero',
    type: 'player',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  await store.setPluginData({
    id: `${sessionId}-pd-1`,
    sessionId,
    pluginId: 'test-plugin',
    namespace: 'ns',
    key: 'k',
    value: { a: 1 },
    createdAt: now,
    updatedAt: now,
  });

  await store.upsertWorkingMemory({
    id: `${sessionId}-wm-1`,
    sessionId,
    key: 'mood',
    scope: 'player',
    value: 'curious',
    updatedAt: now,
  });

  await store.appendTurnMessage({
    id: `${sessionId}-tm-1`,
    sessionId,
    turnId: 'turn-1',
    sourceType: 'runtime',
    role: 'assistant',
    content: 'The story begins.',
    order: 0,
    createdAt: now,
  });

  await store.saveTurnResult({
    id: `${sessionId}-tr-1`,
    sessionId,
    turnId: 'turn-1',
    runtimeResults: [{ pluginId: 'test-plugin', runtimeId: 'test-plugin' }],
    durationMs: 50,
    createdAt: now,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

const originalEnv = process.env['COVEL_SNAPSHOTS_V1'];

describe('Snapshot routes — flag off', () => {
  let store: DataStore;

  beforeEach(async () => {
    process.env['COVEL_SNAPSHOTS_V1'] = '0';
    store = createMemoryStore();
    await createSession(store);
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['COVEL_SNAPSHOTS_V1'];
    else process.env['COVEL_SNAPSHOTS_V1'] = originalEnv;
  });

  it('POST /snapshot returns 503', async () => {
    const app = createTestApp(store);
    const res = await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('feature_disabled');
  });

  it('GET /snapshots returns 503', async () => {
    const app = createTestApp(store);
    const res = await app.request('/api/sessions/sess-1/snapshots');
    expect(res.status).toBe(503);
  });

  it('POST /fork returns 503', async () => {
    const app = createTestApp(store);
    const res = await app.request('/api/sessions/sess-1/fork', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromSnapshotId: 'snap-x' }),
    });
    expect(res.status).toBe(503);
  });
});

describe('Snapshot routes — flag on', () => {
  let store: DataStore;

  beforeEach(async () => {
    process.env['COVEL_SNAPSHOTS_V1'] = '1';
    store = createMemoryStore();
    await createSession(store);
    await seedSessionData(store, 'sess-1');
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['COVEL_SNAPSHOTS_V1'];
    else process.env['COVEL_SNAPSHOTS_V1'] = originalEnv;
  });

  // ── POST /snapshot ──────────────────────────────────────────

  describe('POST /api/sessions/:id/snapshot', () => {
    it('returns 404 when session does not exist', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/nonexistent/snapshot', { method: 'POST' });
      expect(res.status).toBe(404);
    });

    it('returns 201 with a manual snapshot', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;
      expect(snapshot.kind).toBe('manual');
      expect(snapshot.sessionId).toBe('sess-1');
      expect(snapshot.id).toMatch(/./); // non-empty string

      const payload = snapshot.payload as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(1);
      // Characters / plugin data / working memory were seeded — must appear in payload.
      expect((payload.characters as unknown[]).length).toBe(1);
      expect((payload.pluginData as unknown[]).length).toBeGreaterThanOrEqual(1);
      expect((payload.workingMemory as unknown[]).length).toBe(1);
      expect(payload.messagesCursor).toBe('sess-1-tm-1');
    });

    it('persists manual snapshot in store after creation', async () => {
      const app = createTestApp(store);
      await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      const list = await store.listSnapshots('sess-1');
      expect(list).toHaveLength(1);
      expect(list[0].kind).toBe('manual');
    });

    it('emits state.snapshot.created on the event bus (S4-T5)', async () => {
      const eventBus = createEventBus();
      const captured = collectEvents(eventBus);
      const app = createTestApp(store, eventBus);

      const res = await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;

      const snapshotEvents = captured.filter(
        (m) => (m.payload as { _subType?: string })._subType === 'state.snapshot.created',
      );
      expect(snapshotEvents).toHaveLength(1);
      const evt = snapshotEvents[0]!;
      expect(evt.topic).toBe('session');
      expect(evt.sessionId).toBe('sess-1');
      const payload = evt.payload as Record<string, unknown>;
      expect(payload['kind']).toBe('manual');
      expect(payload['snapshotId']).toBe(snapshot.id);
      expect(typeof payload['turnId']).toBe('string');
    });
  });

  // ── GET /snapshots ──────────────────────────────────────────

  describe('GET /api/sessions/:id/snapshots', () => {
    it('returns 404 when session does not exist', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/nonexistent/snapshots');
      expect(res.status).toBe(404);
    });

    it('returns empty list for a session with no snapshots', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/sess-1/snapshots');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.snapshots).toEqual([]);
    });

    it('returns all snapshots for a session', async () => {
      const app = createTestApp(store);
      // Create two manual snapshots
      await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });

      const res = await app.request('/api/sessions/sess-1/snapshots');
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.snapshots as unknown[]).length).toBe(2);
    });

    it('does not include snapshots from other sessions', async () => {
      await createSession(store, 'sess-other');
      await seedSessionData(store, 'sess-other');
      const app = createTestApp(store);
      await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      await app.request('/api/sessions/sess-other/snapshot', { method: 'POST' });

      const res = await app.request('/api/sessions/sess-1/snapshots');
      const body = (await res.json()) as Record<string, unknown>;
      const snapshots = body.snapshots as Array<Record<string, unknown>>;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.sessionId).toBe('sess-1');
    });
  });

  // ── POST /fork ──────────────────────────────────────────────

  describe('POST /api/sessions/:id/fork', () => {
    async function createParentSnapshot(store: DataStore, app: ReturnType<typeof createTestApp>) {
      const res = await app.request('/api/sessions/sess-1/snapshot', { method: 'POST' });
      const body = (await res.json()) as Record<string, unknown>;
      return (body.snapshot as Record<string, unknown>).id as string;
    }

    it('returns 400 when fromSnapshotId is missing', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 on invalid JSON body', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 when parent session does not exist', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/nonexistent/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: 'snap-x' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when snapshot does not exist', async () => {
      const app = createTestApp(store);
      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: 'nonexistent' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when snapshot belongs to a different session', async () => {
      await createSession(store, 'sess-other', 'test-world');
      await seedSessionData(store, 'sess-other');
      const app = createTestApp(store);
      const otherSnapId = await createParentSnapshot(store, app).then(async () => {
        const r = await app.request('/api/sessions/sess-other/snapshot', { method: 'POST' });
        const b = (await r.json()) as Record<string, unknown>;
        return (b.snapshot as Record<string, unknown>).id as string;
      });

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: otherSnapId }),
      });
      expect(res.status).toBe(404);
    });

    it('creates a new session with copied characters', async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      expect(childId).toMatch(/^test-world-/);
      expect(body.parentSessionId).toBe('sess-1');
      expect(body.fromSnapshotId).toBe(snapId);

      // Child session exists
      const child = await store.getSession(childId);
      expect(child).not.toBeNull();
      expect(child!.worldId).toBe('test-world');

      // Characters were copied with count preserved
      const parentChars = await store.listCharacters('sess-1');
      const childChars = await store.listCharacters(childId);
      expect(childChars).toHaveLength(parentChars.length);
      expect(childChars[0]!.name).toBe('Hero');
      expect(childChars[0]!.sessionId).toBe(childId);
    });

    it('copies plugin data and working memory to the child session', async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      const childPluginData = await store.listPluginData(childId, 'test-plugin');
      expect(childPluginData.length).toBeGreaterThanOrEqual(1);
      expect(childPluginData[0]!.value).toEqual({ a: 1 });

      const childWm = await store.listWorkingMemory(childId);
      expect(childWm).toHaveLength(1);
      expect(childWm[0]!.key).toBe('mood');
    });

    it('copies turn messages up to the snapshot cursor', async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      // Append an extra message AFTER the snapshot so we can verify the
      // cursor bound actually trims extra parent messages.
      await store.appendTurnMessage({
        id: 'sess-1-tm-2',
        sessionId: 'sess-1',
        turnId: 'turn-2',
        sourceType: 'runtime',
        role: 'assistant',
        content: 'Post-snapshot content.',
        order: 1,
        createdAt: new Date().toISOString(),
      });

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      const childMessages = await store.listTurnMessages(childId);
      expect(childMessages).toHaveLength(1);
      expect(childMessages[0]!.content).toBe('The story begins.');
    });

    it('emits state.snapshot.created (kind=fork) and session.forked on fork (S4-T5)', async () => {
      const eventBus = createEventBus();
      const captured = collectEvents(eventBus);
      const app = createTestApp(store, eventBus);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      const forkSnapshotId = body.forkSnapshotId as string;

      // Two events should be visible against the child session: the
      // snapshot.created (kind=fork) and session.forked.
      const childEvents = captured.filter((m) => m.sessionId === childId);
      const snapshotEvent = childEvents.find(
        (m) => (m.payload as { _subType?: string })._subType === 'state.snapshot.created',
      );
      const forkedEvent = childEvents.find(
        (m) => (m.payload as { _subType?: string })._subType === 'session.forked',
      );
      expect(snapshotEvent).toBeDefined();
      expect(forkedEvent).toBeDefined();

      const snapshotPayload = snapshotEvent!.payload as Record<string, unknown>;
      expect(snapshotPayload['kind']).toBe('fork');
      expect(snapshotPayload['snapshotId']).toBe(forkSnapshotId);
      expect(snapshotPayload['parentSnapshotId']).toBe(snapId);
    });

    it('records a fork snapshot on the child', async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      expect(body.forkSnapshotId).toMatch(/./);

      const childSnapshots = await store.listSnapshots(childId);
      expect(childSnapshots).toHaveLength(1);
      expect(childSnapshots[0]!.kind).toBe('fork');
      expect(childSnapshots[0]!.parentId).toBe(snapId);
    });

    // Audit 2026-04-20 finding 7.1 — cursor-miss must surface as 409.
    it('returns 409 cursor_missing when payload.messagesCursor no longer exists in parent', async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      // Corrupt the stored snapshot: rewrite its cursor to a phantom id that
      // is not present in the parent's turn_messages. Simulates compactor /
      // GC removing the cursor row after the snapshot was taken.
      const stored = await store.getSnapshot(snapId);
      expect(stored).not.toBeNull();
      await store.saveSnapshot({
        ...stored!,
        payload: {
          ...stored!.payload,
          messagesCursor: 'phantom-tm-id-not-in-parent',
        },
      });

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe('cursor_missing');

      // Transaction must have rolled back — no child session created.
      const sessions = await store.listSessions();
      const childSessions = sessions.filter((s) => s.id !== 'sess-1');
      expect(childSessions).toHaveLength(0);
    });

    // Audit 2026-04-20 finding 7.3 — unresolved suspensions must travel with fork.
    it('copies unresolved suspensions to the child session with a fresh id', async () => {
      const now = new Date().toISOString();
      await store.saveSuspension({
        id: 'susp-orig',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        runtimeId: 'test-plugin',
        pluginId: 'test-plugin',
        reason: 'Need more info',
        resumeSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
        pendingContinuation: {
          messages: [{ role: 'system', content: 'sys' }],
          toolCallsSoFar: [],
          pendingProposals: [],
          suspendToolCallId: 'tc-1',
        },
        createdAt: now,
      });

      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      // Parent suspension is unchanged.
      const parentSuspensions = await store.listSuspensions('sess-1');
      expect(parentSuspensions).toHaveLength(1);
      expect(parentSuspensions[0]!.id).toBe('susp-orig');

      // Child has a copy with a new id and the rebound sessionId.
      const childSuspensions = await store.listSuspensions(childId);
      expect(childSuspensions).toHaveLength(1);
      expect(childSuspensions[0]!.id).not.toBe('susp-orig');
      expect(childSuspensions[0]!.sessionId).toBe(childId);
      expect(childSuspensions[0]!.reason).toBe('Need more info');
      expect(childSuspensions[0]!.resolvedAt).toBeUndefined();
    });

    // Audit 2026-04-20 finding 7.3 — resolved suspensions must NOT travel.
    it('excludes already-resolved suspensions from the fork', async () => {
      const now = new Date().toISOString();
      await store.saveSuspension({
        id: 'susp-resolved',
        sessionId: 'sess-1',
        turnId: 'turn-1',
        runtimeId: 'test-plugin',
        pluginId: 'test-plugin',
        reason: 'Already handled',
        resumeSchema: {},
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
        },
        createdAt: now,
      });
      await store.markSuspensionResolved('susp-resolved');

      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request('/api/sessions/sess-1/fork', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      // Snapshot's payload.suspensions excluded the resolved one, so the
      // child session starts with zero.
      const childSuspensions = await store.listSuspensions(childId);
      expect(childSuspensions).toHaveLength(0);
    });
  });
});

// ── Auto snapshot from turn executor ────────────────────────────

describe('Auto snapshot (COVEL_SNAPSHOTS_V1=1)', () => {
  let store: DataStore;

  beforeEach(async () => {
    process.env['COVEL_SNAPSHOTS_V1'] = '1';
    store = createMemoryStore();
    await createSession(store, 'sess-auto');
    await seedSessionData(store, 'sess-auto');
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['COVEL_SNAPSHOTS_V1'];
    else process.env['COVEL_SNAPSHOTS_V1'] = originalEnv;
  });

  it('produces a kind=auto snapshot when the turn executor runs', async () => {
    const { executeTurn } = await import('@covel/runtime');

    await executeTurn(
      { sessionId: 'sess-auto', turnId: 'turn-auto-1', playerMessage: 'hi' },
      [],
      {
        loadRuntime: async () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: { generate: async () => ({ content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
        getConfig: () => ({}),
        store,
      },
    );

    const snapshots = await store.listSnapshots('sess-auto');
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const auto = snapshots.find((s) => s.kind === 'auto');
    expect(auto).toBeDefined();
    expect(auto!.turnId).toBe('turn-auto-1');
  });

  it('emits state.snapshot.created (kind=auto) on the event bus (S4-T5)', async () => {
    const { executeTurn } = await import('@covel/runtime');
    const eventBus = createEventBus();
    const captured = collectEvents(eventBus);

    await executeTurn(
      { sessionId: 'sess-auto', turnId: 'turn-auto-2', playerMessage: 'hi' },
      [],
      {
        loadRuntime: async () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: { generate: async () => ({ content: '', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 0, outputTokens: 0 } }) } as any,
        getConfig: () => ({}),
        store,
        eventBus,
      },
    );

    const snapshotEvents = captured.filter(
      (m) => (m.payload as { _subType?: string })._subType === 'state.snapshot.created',
    );
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);
    const evt = snapshotEvents[0]!;
    expect(evt.topic).toBe('session');
    expect(evt.sessionId).toBe('sess-auto');
    const payload = evt.payload as Record<string, unknown>;
    expect(payload['kind']).toBe('auto');
    expect(payload['turnId']).toBe('turn-auto-2');
    expect(typeof payload['snapshotId']).toBe('string');
  });
});
