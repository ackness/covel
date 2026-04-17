/**
 * Reusable contract tests for any DataStore implementation.
 * Each backend (Memory, SQLite, PG) runs this same suite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  DataStore,
  SessionRecord,
  TurnResultRecord,
  RuntimeResultRecord,
  ToolCallRecordRow,
  StateSchemaRecord,
  StateEntryRecord,
  StateChangeRecord,
  EventRecord,
  ApprovalRecord,
  MessageRecord,
  CharacterRecord,
  PluginConfigRecord,
  WorldRecord,
  TraceEventRecord,
  RuntimeOutputRecord,
  InteractionRecordRow,
  TurnMessageRecord,
  PlayerInputRecord,
  WorkingMemoryRecord,
  LorebookEntryRecord,
  SessionSummaryRecord,
  SuspensionRecord,
  SnapshotRecord,
  SnapshotPayload,
} from '../types.js';

// ── Record factories ────────────────────────────────────────────

let seq = 0;
function id(): string {
  return `test-${++seq}`;
}

function ts(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: id(),
    worldId: 'world-1',
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    locale: 'zh-CN',
    activePlugins: [],
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeTurnResult(overrides?: Partial<TurnResultRecord>): TurnResultRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: id(),
    runtimeResults: [],
    durationMs: 100,
    createdAt: ts(),
    ...overrides,
  };
}

function makeRuntimeResult(overrides?: Partial<RuntimeResultRecord>): RuntimeResultRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    pluginId: 'plugin-1',
    runtimeId: 'runtime-1',
    status: 'success',
    output: { text: 'hello' },
    toolCalls: [],
    durationMs: 50,
    createdAt: ts(),
    ...overrides,
  };
}

function makeToolCall(overrides?: Partial<ToolCallRecordRow>): ToolCallRecordRow {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    toolName: 'test-tool',
    pluginId: 'plugin-1',
    runtimeId: 'runtime-1',
    input: { foo: 1 },
    output: { bar: 2 },
    durationMs: 10,
    approvalStatus: 'approved',
    createdAt: ts(),
    ...overrides,
  };
}

function makeStateSchema(overrides?: Partial<StateSchemaRecord>): StateSchemaRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    tableName: 'stats',
    schema: { fields: ['hp', 'mp'] },
    createdAt: ts(),
    ...overrides,
  };
}

function makeStateEntry(overrides?: Partial<StateEntryRecord>): StateEntryRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    tableName: 'stats',
    fieldName: 'hp',
    value: 100,
    updatedAt: ts(),
    ...overrides,
  };
}

function makeStateChange(overrides?: Partial<StateChangeRecord>): StateChangeRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    tableName: 'stats',
    fieldName: 'hp',
    value: 80,
    changedBy: 'core-combat',
    turnId: 'turn-1',
    createdAt: ts(),
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<EventRecord>): EventRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    type: 'domain',
    topic: 'combat',
    payload: { damage: 20 },
    createdAt: ts(),
    ...overrides,
  };
}

function makeApproval(overrides?: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    toolName: 'dangerous-tool',
    pluginId: 'test-plugin',
    decision: 'approved',
    turnId: 'turn-1',
    createdAt: ts(),
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<MessageRecord>): MessageRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    role: 'assistant',
    content: 'Hello, adventurer!',
    createdAt: ts(),
    ...overrides,
  };
}

function makeCharacter(overrides?: Partial<CharacterRecord>): CharacterRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    name: 'Hero',
    type: 'player',
    version: 1,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makePluginConfig(overrides?: Partial<PluginConfigRecord>): PluginConfigRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    pluginId: 'core-narrator',
    config: { tone: 'dramatic' },
    updatedAt: ts(),
    ...overrides,
  };
}

function makeWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: id(),
    name: 'Test World',
    description: 'A world for testing',
    createdAt: ts(),
    ...overrides,
  };
}

function makeTraceEvent(overrides?: Partial<TraceEventRecord>): TraceEventRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    type: 'llm_call',
    traceId: 'trace-1',
    turnId: 'turn-1',
    payload: { model: 'gpt-4' },
    createdAt: ts(),
    ...overrides,
  };
}

function makeRuntimeOutput(overrides?: Partial<RuntimeOutputRecord>): RuntimeOutputRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    runtimeResultId: id(),
    pluginId: 'core-narrator',
    runtimeId: 'core-narrator',
    timestamp: ts(),
    results: [{ text: 'hello world', structured: { narrative: 'hello world' } }],
    metaData: {
      turn: 0,
      phase: 'playing',
      toolCallList: [],
    },
    createdAt: ts(),
    ...overrides,
  };
}

function makeInteractionRecord(
  overrides?: Partial<InteractionRecordRow>,
): InteractionRecordRow {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    timestamp: ts(),
    source: 'player',
    channel: 'web',
    type: 'message',
    payload: { content: 'test' },
    createdAt: ts(),
    ...overrides,
  };
}

function makeTurnMessage(overrides?: Partial<TurnMessageRecord>): TurnMessageRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    sourceType: 'runtime',
    role: 'assistant',
    content: 'test message',
    order: 500,
    createdAt: ts(),
    ...overrides,
  };
}

function makePlayerInput(overrides?: Partial<PlayerInputRecord>): PlayerInputRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    formId: 'test-form',
    values: { name: 'test' },
    createdAt: ts(),
    ...overrides,
  };
}

function makeWorkingMemory(overrides?: Partial<WorkingMemoryRecord>): WorkingMemoryRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    key: 'testKey',
    scope: 'player',
    value: { data: 'test' },
    updatedAt: ts(),
    ...overrides,
  };
}

function makeSessionSummary(overrides?: Partial<SessionSummaryRecord>): SessionSummaryRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnRangeStart: 'turn-1',
    turnRangeEnd: 'turn-5',
    content: 'The hero entered the dungeon and defeated a goblin.',
    focusSections: ['narrative', 'character-state'],
    createdAt: ts(),
    ...overrides,
  };
}

function makeSuspension(overrides?: Partial<SuspensionRecord>): SuspensionRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    runtimeId: 'test-runtime',
    pluginId: 'test-plugin',
    reason: 'Need player input',
    resumeSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    pendingContinuation: {
      messages: [{ role: 'system', content: 'You are a test assistant.' }],
      partialContent: undefined,
      toolCallsSoFar: [],
      pendingProposals: [],
      suspendToolCallId: 'tc-suspend-1',
    },
    createdAt: ts(),
    resolvedAt: undefined,
    ...overrides,
  };
}

function makeLorebookEntry(overrides?: Partial<LorebookEntryRecord>): LorebookEntryRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    pluginId: 'plugin-1',
    keys: [],
    content: 'Some lore content',
    strategy: 'constant',
    position: 'after_char_defs',
    insertionOrder: 100,
    enabled: true,
    extra: undefined,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeSnapshotPayload(overrides?: Partial<SnapshotPayload>): SnapshotPayload {
  return {
    schemaVersion: 1,
    turnId: 'turn-1',
    characters: [],
    stateEntries: [],
    pluginData: [],
    workingMemory: [],
    lorebookEntries: [],
    messagesCursor: '',
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<SnapshotRecord>): SnapshotRecord {
  return {
    id: id(),
    sessionId: 'sess-1',
    turnId: 'turn-1',
    kind: 'manual',
    parentId: undefined,
    payload: makeSnapshotPayload(),
    createdAt: ts(),
    ...overrides,
  };
}

// ── Contract test suite ─────────────────────────────────────────

export function runStoreContractTests(
  name: string,
  createStore: () => DataStore | Promise<DataStore>,
): void {
  describe(`DataStore Contract: ${name}`, () => {
    let store: DataStore;

    beforeEach(async () => {
      seq = 0;
      store = await createStore();
    });

    // Close the store after each test so backends that hold connection
    // pools (PG) don't pile up sockets across the contract run. Memory /
    // IDB / SQLite stores either ignore close() or release in-process
    // resources — all safe no-ops.
    afterEach(async () => {
      try {
        await store.close?.();
      } catch {
        // Swallow — close errors must not mask the actual test failure.
      }
    });

    // ── Session ──────────────────────────────────────────────

    describe('Session', () => {
      it('should create and retrieve a session', async () => {
        const session = makeSession();
        await store.createSession(session);
        const result = await store.getSession(session.id);
        expect(result).toEqual(session);
      });

      it('should list all sessions', async () => {
        const s1 = makeSession();
        const s2 = makeSession();
        await store.createSession(s1);
        await store.createSession(s2);
        const list = await store.listSessions();
        expect(list).toHaveLength(2);
        expect(list.map((s) => s.id)).toContain(s1.id);
        expect(list.map((s) => s.id)).toContain(s2.id);
      });

      it('should update session status and turnCount', async () => {
        const session = makeSession({ status: 'active', turnCount: 0, preGameCompleted: [] });
        await store.createSession(session);
        const now = ts();
        await store.updateSession(session.id, {
          status: 'ended',
          turnCount: 5,
          updatedAt: now,
        });
        const result = await store.getSession(session.id);
        expect(result?.status).toBe('ended');
        expect(result?.turnCount).toBe(5);
        expect(result?.updatedAt).toBe(now);
      });

      it('should delete a session', async () => {
        const session = makeSession();
        await store.createSession(session);
        await store.deleteSession(session.id);
        const result = await store.getSession(session.id);
        expect(result).toBeNull();
      });

      it('should return null for unknown session', async () => {
        const result = await store.getSession('nonexistent');
        expect(result).toBeNull();
      });

      it('PR-6: persists runtimeModelOverrides on create and update', async () => {
        const session = makeSession();
        await store.createSession({
          ...session,
          runtimeModelOverrides: {
            'core-narrator': 'balance',
            'core-codex/unlocker': 'fast',
          },
        });

        const created = await store.getSession(session.id);
        expect(created?.runtimeModelOverrides).toEqual({
          'core-narrator': 'balance',
          'core-codex/unlocker': 'fast',
        });

        await store.updateSession(session.id, {
          runtimeModelOverrides: { 'core-narrator': 'fast' },
          updatedAt: ts(),
        });
        const updated = await store.getSession(session.id);
        expect(updated?.runtimeModelOverrides).toEqual({
          'core-narrator': 'fast',
        });
      });

      it('PR-6: clearing runtimeModelOverrides with empty object removes it', async () => {
        const session = makeSession();
        await store.createSession({
          ...session,
          runtimeModelOverrides: { 'core-narrator': 'fast' },
        });
        await store.updateSession(session.id, {
          runtimeModelOverrides: {},
          updatedAt: ts(),
        });
        const cleared = await store.getSession(session.id);
        expect(
          cleared?.runtimeModelOverrides === undefined
            || Object.keys(cleared?.runtimeModelOverrides ?? {}).length === 0,
        ).toBe(true);
      });
    });

    // ── Turn Results ─────────────────────────────────────────

    describe('TurnResults', () => {
      it('should save and retrieve a turn result', async () => {
        const tr = makeTurnResult({ sessionId: 'sess-1' });
        await store.saveTurnResult(tr);
        const result = await store.getTurnResult('sess-1', tr.turnId);
        expect(result).toEqual(tr);
      });

      it('should list turn results for a session ordered by createdAt', async () => {
        const tr1 = makeTurnResult({ sessionId: 'sess-1', createdAt: ts(0) });
        const tr2 = makeTurnResult({ sessionId: 'sess-1', createdAt: ts(100) });
        const tr3 = makeTurnResult({ sessionId: 'other', createdAt: ts(50) });
        await store.saveTurnResult(tr1);
        await store.saveTurnResult(tr2);
        await store.saveTurnResult(tr3);
        const list = await store.listTurnResults('sess-1');
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(tr1.id);
        expect(list[1].id).toBe(tr2.id);
      });

      it('should respect limit parameter', async () => {
        const tr1 = makeTurnResult({ sessionId: 'sess-1', createdAt: ts(0) });
        const tr2 = makeTurnResult({ sessionId: 'sess-1', createdAt: ts(100) });
        await store.saveTurnResult(tr1);
        await store.saveTurnResult(tr2);
        const list = await store.listTurnResults('sess-1', 1);
        expect(list).toHaveLength(1);
      });
    });

    // ── Runtime Results ──────────────────────────────────────

    describe('RuntimeResults', () => {
      it('should save and list runtime results by sessionId+turnId', async () => {
        const rr = makeRuntimeResult({ sessionId: 'sess-1', turnId: 'turn-1' });
        await store.saveRuntimeResult(rr);
        const list = await store.listRuntimeResults('sess-1', 'turn-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(rr);
      });

      it('should return empty array for unknown turnId', async () => {
        const list = await store.listRuntimeResults('sess-1', 'unknown');
        expect(list).toEqual([]);
      });
    });

    // ── Tool Calls ───────────────────────────────────────────

    describe('ToolCalls', () => {
      it('should save and list tool calls by sessionId', async () => {
        const tc = makeToolCall({ sessionId: 'sess-1' });
        await store.saveToolCall(tc);
        const list = await store.listToolCalls('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(tc);
      });

      it('should filter by turnId when provided', async () => {
        const tc1 = makeToolCall({ sessionId: 'sess-1', turnId: 'turn-1' });
        const tc2 = makeToolCall({ sessionId: 'sess-1', turnId: 'turn-2' });
        await store.saveToolCall(tc1);
        await store.saveToolCall(tc2);
        const list = await store.listToolCalls('sess-1', 'turn-1');
        expect(list).toHaveLength(1);
        expect(list[0].turnId).toBe('turn-1');
      });
    });

    // ── State Schemas ────────────────────────────────────────

    describe('StateSchemas', () => {
      it('should save and list state schemas by sessionId', async () => {
        const schema = makeStateSchema({ sessionId: 'sess-1' });
        await store.saveStateSchema(schema);
        const list = await store.listStateSchemas('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(schema);
      });

      it('should delete a state schema', async () => {
        const schema = makeStateSchema({ sessionId: 'sess-1', tableName: 'stats' });
        await store.saveStateSchema(schema);
        await store.deleteStateSchema('sess-1', 'stats');
        const list = await store.listStateSchemas('sess-1');
        expect(list).toHaveLength(0);
      });

      it('should return empty array for unknown session', async () => {
        const list = await store.listStateSchemas('unknown');
        expect(list).toEqual([]);
      });
    });

    // ── State Entries ────────────────────────────────────────

    describe('StateEntries', () => {
      it('should upsert and get a state entry', async () => {
        const entry = makeStateEntry({ sessionId: 'sess-1', tableName: 'stats', fieldName: 'hp' });
        await store.upsertStateEntry(entry);
        const result = await store.getStateEntry('sess-1', 'stats', 'hp');
        expect(result).toEqual(entry);
      });

      it('should overwrite on second upsert', async () => {
        const entry1 = makeStateEntry({
          sessionId: 'sess-1',
          tableName: 'stats',
          fieldName: 'hp',
          value: 100,
        });
        await store.upsertStateEntry(entry1);

        const entry2: StateEntryRecord = {
          ...entry1,
          value: 50,
          updatedAt: ts(100),
        };
        await store.upsertStateEntry(entry2);

        const result = await store.getStateEntry('sess-1', 'stats', 'hp');
        expect(result?.value).toBe(50);
      });

      it('should list all entries for a session+table', async () => {
        const e1 = makeStateEntry({ sessionId: 'sess-1', tableName: 'stats', fieldName: 'hp' });
        const e2 = makeStateEntry({ sessionId: 'sess-1', tableName: 'stats', fieldName: 'mp' });
        const e3 = makeStateEntry({ sessionId: 'sess-1', tableName: 'other', fieldName: 'x' });
        await store.upsertStateEntry(e1);
        await store.upsertStateEntry(e2);
        await store.upsertStateEntry(e3);
        const list = await store.listStateEntries('sess-1', 'stats');
        expect(list).toHaveLength(2);
      });
    });

    // ── State Changes ────────────────────────────────────────

    describe('StateChanges', () => {
      it('should add and list state changes', async () => {
        const change = makeStateChange({
          sessionId: 'sess-1',
          tableName: 'stats',
          fieldName: 'hp',
        });
        await store.addStateChange(change);
        const list = await store.listStateChanges('sess-1', 'stats', 'hp');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(change);
      });

      it('should return changes ordered by createdAt', async () => {
        const c1 = makeStateChange({
          sessionId: 'sess-1',
          tableName: 'stats',
          fieldName: 'hp',
          createdAt: ts(0),
        });
        const c2 = makeStateChange({
          sessionId: 'sess-1',
          tableName: 'stats',
          fieldName: 'hp',
          createdAt: ts(100),
        });
        await store.addStateChange(c1);
        await store.addStateChange(c2);
        const list = await store.listStateChanges('sess-1', 'stats', 'hp');
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(c1.id);
        expect(list[1].id).toBe(c2.id);
      });
    });

    // ── Events ───────────────────────────────────────────────

    describe('Events', () => {
      it('should save and list events by sessionId', async () => {
        const event = makeEvent({ sessionId: 'sess-1' });
        await store.saveEvent(event);
        const list = await store.listEvents('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(event);
      });

      it('should filter by topic when provided', async () => {
        const e1 = makeEvent({ sessionId: 'sess-1', topic: 'combat' });
        const e2 = makeEvent({ sessionId: 'sess-1', topic: 'quest' });
        await store.saveEvent(e1);
        await store.saveEvent(e2);
        const list = await store.listEvents('sess-1', { topic: 'combat' });
        expect(list).toHaveLength(1);
        expect(list[0].topic).toBe('combat');
      });
    });

    // ── Approvals ────────────────────────────────────────────

    describe('Approvals', () => {
      it('should save and list approvals', async () => {
        const approval = makeApproval({ sessionId: 'sess-1' });
        await store.saveApproval(approval);
        const list = await store.listApprovals('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(approval);
      });
    });

    // ── Messages ─────────────────────────────────────────────

    describe('Messages', () => {
      it('should add and list messages', async () => {
        const msg = makeMessage({ sessionId: 'sess-1' });
        await store.addMessage(msg);
        const list = await store.listMessages('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(msg);
      });

      it('should return messages ordered by createdAt', async () => {
        const m1 = makeMessage({ sessionId: 'sess-1', createdAt: ts(0) });
        const m2 = makeMessage({ sessionId: 'sess-1', createdAt: ts(100) });
        await store.addMessage(m1);
        await store.addMessage(m2);
        const list = await store.listMessages('sess-1');
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(m1.id);
        expect(list[1].id).toBe(m2.id);
      });
    });

    // ── Characters ───────────────────────────────────────────

    describe('Characters', () => {
      it('should upsert and list characters', async () => {
        const char = makeCharacter({ sessionId: 'sess-1' });
        await store.upsertCharacter(char);
        const list = await store.listCharacters('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(char);
      });

      it('should overwrite character with same id', async () => {
        const charId = id();
        const char1 = makeCharacter({ id: charId, sessionId: 'sess-1', name: 'Hero' });
        await store.upsertCharacter(char1);

        const char2: CharacterRecord = { ...char1, name: 'Dark Hero', version: 2 };
        await store.upsertCharacter(char2);

        const list = await store.listCharacters('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe('Dark Hero');
        expect(list[0].version).toBe(2);
      });
    });

    // ── Plugin Configs ───────────────────────────────────────

    describe('PluginConfigs', () => {
      it('should save and retrieve plugin config', async () => {
        const config = makePluginConfig({ sessionId: 'sess-1', pluginId: 'core-narrator' });
        await store.savePluginConfig(config);
        const result = await store.getPluginConfig('sess-1', 'core-narrator');
        expect(result).toEqual(config);
      });

      it('should return null for unknown plugin config', async () => {
        const result = await store.getPluginConfig('sess-1', 'unknown');
        expect(result).toBeNull();
      });
    });

    // ── Plugin Data ─────────────────────────────────────────

    describe('PluginData', () => {
      it('should set and get plugin data', async () => {
        const record = {
          id: 'pd-1',
          sessionId: 'sess-1',
          pluginId: 'core-world-init',
          namespace: 'schema',
          key: 'dimensions',
          value: { hp: { type: 'number', max: 100 }, name: { type: 'string' } },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await store.setPluginData(record);
        const result = await store.getPluginData('sess-1', 'core-world-init', 'schema', 'dimensions');
        expect(result).not.toBeNull();
        expect(result!.key).toBe('dimensions');
        expect(result!.value).toEqual(record.value);
      });

      it('should upsert on conflict (same session+plugin+namespace+key)', async () => {
        const record1 = {
          id: 'pd-2',
          sessionId: 'sess-1',
          pluginId: 'test-plugin',
          namespace: 'config',
          key: 'setting-a',
          value: { enabled: true },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await store.setPluginData(record1);

        const record2 = {
          ...record1,
          id: 'pd-2-updated',
          value: { enabled: false, extra: 42 },
          updatedAt: new Date().toISOString(),
        };
        await store.setPluginData(record2);

        const result = await store.getPluginData('sess-1', 'test-plugin', 'config', 'setting-a');
        expect(result).not.toBeNull();
        expect(result!.value).toEqual({ enabled: false, extra: 42 });
      });

      it('should list plugin data by namespace', async () => {
        await store.setPluginData({
          id: 'pd-3a', sessionId: 'sess-2', pluginId: 'p1', namespace: 'entries',
          key: 'a', value: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        await store.setPluginData({
          id: 'pd-3b', sessionId: 'sess-2', pluginId: 'p1', namespace: 'entries',
          key: 'b', value: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        await store.setPluginData({
          id: 'pd-3c', sessionId: 'sess-2', pluginId: 'p1', namespace: 'other',
          key: 'c', value: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });

        const withNs = await store.listPluginData('sess-2', 'p1', 'entries');
        expect(withNs).toHaveLength(2);

        const allNs = await store.listPluginData('sess-2', 'p1');
        expect(allNs).toHaveLength(3);
      });

      it('should delete plugin data', async () => {
        await store.setPluginData({
          id: 'pd-4', sessionId: 'sess-3', pluginId: 'p2', namespace: 'temp',
          key: 'x', value: 'delete-me', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        await store.deletePluginData('sess-3', 'p2', 'temp', 'x');
        const result = await store.getPluginData('sess-3', 'p2', 'temp', 'x');
        expect(result).toBeNull();
      });

      it('should return null for unknown plugin data', async () => {
        const result = await store.getPluginData('sess-x', 'unknown', 'ns', 'key');
        expect(result).toBeNull();
      });

      it('should batch set plugin data', async () => {
        const now = new Date().toISOString();
        await store.setPluginDataBatch([
          { id: 'pd-b1', sessionId: 'sess-batch', pluginId: 'p1', namespace: 'entries', key: 'a', value: { x: 1 }, createdAt: now, updatedAt: now },
          { id: 'pd-b2', sessionId: 'sess-batch', pluginId: 'p1', namespace: 'entries', key: 'b', value: { x: 2 }, createdAt: now, updatedAt: now },
          { id: 'pd-b3', sessionId: 'sess-batch', pluginId: 'p1', namespace: 'schema', key: 'c', value: { x: 3 }, createdAt: now, updatedAt: now },
        ]);

        const entries = await store.listPluginData('sess-batch', 'p1', 'entries');
        expect(entries).toHaveLength(2);

        const all = await store.listPluginData('sess-batch', 'p1');
        expect(all).toHaveLength(3);

        const single = await store.getPluginData('sess-batch', 'p1', 'entries', 'a');
        expect(single).not.toBeNull();
        expect(single!.value).toEqual({ x: 1 });
      });

      it('should batch upsert on conflict', async () => {
        const now = new Date().toISOString();
        await store.setPluginDataBatch([
          { id: 'pd-u1', sessionId: 'sess-upsert', pluginId: 'p1', namespace: 'ns', key: 'k1', value: 'old', createdAt: now, updatedAt: now },
        ]);
        const later = new Date(Date.now() + 1000).toISOString();
        await store.setPluginDataBatch([
          { id: 'pd-u2', sessionId: 'sess-upsert', pluginId: 'p1', namespace: 'ns', key: 'k1', value: 'new', createdAt: later, updatedAt: later },
        ]);
        const result = await store.getPluginData('sess-upsert', 'p1', 'ns', 'k1');
        expect(result!.value).toBe('new');
      });

      it('should handle empty batch', async () => {
        await store.setPluginDataBatch([]);
        // No error thrown
      });

      it('should isolate data between sessions', async () => {
        await store.setPluginData({
          id: 'pd-5a', sessionId: 'sess-A', pluginId: 'p1', namespace: 'ns',
          key: 'k', value: 'session-A', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        await store.setPluginData({
          id: 'pd-5b', sessionId: 'sess-B', pluginId: 'p1', namespace: 'ns',
          key: 'k', value: 'session-B', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });

        const a = await store.getPluginData('sess-A', 'p1', 'ns', 'k');
        const b = await store.getPluginData('sess-B', 'p1', 'ns', 'k');
        expect(a!.value).toBe('session-A');
        expect(b!.value).toBe('session-B');
      });

      it('should isolate data between plugins in the same session', async () => {
        const now = new Date().toISOString();
        await store.setPluginData({
          id: 'pd-iso-a', sessionId: 'sess-X', pluginId: 'plugin-a',
          namespace: 'ns', key: 'k', value: 'from-a', createdAt: now, updatedAt: now,
        });
        await store.setPluginData({
          id: 'pd-iso-b', sessionId: 'sess-X', pluginId: 'plugin-b',
          namespace: 'ns', key: 'k', value: 'from-b', createdAt: now, updatedAt: now,
        });
        const a = await store.getPluginData('sess-X', 'plugin-a', 'ns', 'k');
        const b = await store.getPluginData('sess-X', 'plugin-b', 'ns', 'k');
        expect(a!.value).toBe('from-a');
        expect(b!.value).toBe('from-b');
      });
    });

    // ── Worlds ───────────────────────────────────────────────

    describe('Worlds', () => {
      it('should upsert and retrieve a world', async () => {
        const world = makeWorld();
        await store.upsertWorld(world);
        const result = await store.getWorld(world.id);
        expect(result).toEqual(world);
      });

      it('should list all worlds', async () => {
        const w1 = makeWorld();
        const w2 = makeWorld();
        await store.upsertWorld(w1);
        await store.upsertWorld(w2);
        const list = await store.listWorlds();
        expect(list).toHaveLength(2);
      });

      it('should return null for unknown world', async () => {
        const result = await store.getWorld('nonexistent');
        expect(result).toBeNull();
      });
    });

    // ── Trace Events ─────────────────────────────────────────

    describe('TraceEvents', () => {
      it('should add and list trace events', async () => {
        const te = makeTraceEvent({ sessionId: 'sess-1' });
        await store.addTraceEvent(te);
        const list = await store.listTraceEvents('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(te);
      });
    });

    // ── Runtime Outputs (PR-1 translation layer) ─────────────

    describe('RuntimeOutputs', () => {
      it('should save and get a runtime output by id', async () => {
        const ro = makeRuntimeOutput({ sessionId: 'sess-1' });
        await store.saveRuntimeOutput(ro);
        const fetched = await store.getRuntimeOutput('sess-1', ro.id);
        expect(fetched).toBeTruthy();
        expect(fetched?.id).toBe(ro.id);
        expect(fetched?.runtimeId).toBe('core-narrator');
      });

      it('should return null for unknown runtime output', async () => {
        const missing = await store.getRuntimeOutput('sess-1', 'nonexistent');
        expect(missing).toBeNull();
      });

      it('should filter by sessionId', async () => {
        await store.saveRuntimeOutput(makeRuntimeOutput({ sessionId: 'sess-1' }));
        await store.saveRuntimeOutput(makeRuntimeOutput({ sessionId: 'sess-2' }));
        const list = await store.listRuntimeOutputs('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0]!.sessionId).toBe('sess-1');
      });

      it('should filter by runtimeId', async () => {
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-1', runtimeId: 'core-narrator' }),
        );
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-1', runtimeId: 'core-guide' }),
        );
        const list = await store.listRuntimeOutputs('sess-1', { runtimeId: 'core-guide' });
        expect(list).toHaveLength(1);
        expect(list[0]!.runtimeId).toBe('core-guide');
      });

      it('should filter by pluginId', async () => {
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-1', pluginId: 'core-narrator' }),
        );
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-1', pluginId: 'core-guide' }),
        );
        const list = await store.listRuntimeOutputs('sess-1', { pluginId: 'core-guide' });
        expect(list).toHaveLength(1);
        expect(list[0]!.pluginId).toBe('core-guide');
      });

      it('should return results in newest-first order', async () => {
        const t1 = ts(100);
        const t2 = ts(300);
        const t3 = ts(200);
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-ord', timestamp: t1 }),
        );
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-ord', timestamp: t2 }),
        );
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-ord', timestamp: t3 }),
        );
        const list = await store.listRuntimeOutputs('sess-ord');
        expect(list).toHaveLength(3);
        expect(list[0]!.timestamp).toBe(t2);
        expect(list[1]!.timestamp).toBe(t3);
        expect(list[2]!.timestamp).toBe(t1);
      });

      it('should respect limit', async () => {
        for (let i = 0; i < 5; i++) {
          await store.saveRuntimeOutput(
            makeRuntimeOutput({ sessionId: 'sess-lim', timestamp: ts(i * 10) }),
          );
        }
        const list = await store.listRuntimeOutputs('sess-lim', { limit: 2 });
        expect(list).toHaveLength(2);
      });

      it('should filter by sinceTimestamp', async () => {
        const tEarly = ts(100);
        const tLate = ts(500);
        const tMid = ts(200);
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-since', timestamp: tEarly }),
        );
        await store.saveRuntimeOutput(
          makeRuntimeOutput({ sessionId: 'sess-since', timestamp: tLate }),
        );
        const list = await store.listRuntimeOutputs('sess-since', {
          sinceTimestamp: tMid,
        });
        expect(list).toHaveLength(1);
        expect(list[0]!.timestamp).toBe(tLate);
      });
    });

    // ── Interaction Records (PR-1 translation layer) ─────────

    describe('InteractionRecords', () => {
      it('should save and list interaction records', async () => {
        const ir = makeInteractionRecord({ sessionId: 'sess-ir' });
        await store.saveInteractionRecord(ir);
        const list = await store.listInteractionRecords('sess-ir');
        expect(list).toHaveLength(1);
        expect(list[0]!.id).toBe(ir.id);
        expect(list[0]!.type).toBe('message');
      });

      it('should filter by sessionId', async () => {
        await store.saveInteractionRecord(makeInteractionRecord({ sessionId: 'sess-1' }));
        await store.saveInteractionRecord(makeInteractionRecord({ sessionId: 'sess-2' }));
        const list = await store.listInteractionRecords('sess-1');
        expect(list).toHaveLength(1);
      });

      it('should filter by type', async () => {
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-t', type: 'message' }),
        );
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-t', type: 'form-submit' }),
        );
        const list = await store.listInteractionRecords('sess-t', { type: 'form-submit' });
        expect(list).toHaveLength(1);
        expect(list[0]!.type).toBe('form-submit');
      });

      it('should filter by source', async () => {
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-s', source: 'player' }),
        );
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-s', source: 'plugin-ui' }),
        );
        const list = await store.listInteractionRecords('sess-s', { source: 'plugin-ui' });
        expect(list).toHaveLength(1);
        expect(list[0]!.source).toBe('plugin-ui');
      });

      it('should return records in newest-first order', async () => {
        const tEarly = ts(100);
        const tLate = ts(300);
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-ord-ir', timestamp: tEarly }),
        );
        await store.saveInteractionRecord(
          makeInteractionRecord({ sessionId: 'sess-ord-ir', timestamp: tLate }),
        );
        const list = await store.listInteractionRecords('sess-ord-ir');
        expect(list[0]!.timestamp).toBe(tLate);
      });

      it('should respect limit', async () => {
        for (let i = 0; i < 4; i++) {
          await store.saveInteractionRecord(
            makeInteractionRecord({ sessionId: 'sess-lim-ir', timestamp: ts(i * 10) }),
          );
        }
        const list = await store.listInteractionRecords('sess-lim-ir', { limit: 2 });
        expect(list).toHaveLength(2);
      });
    });

    // ── Turn Messages ────────────────────────────────────────

    describe('TurnMessages', () => {
      it('should appendTurnMessage and listTurnMessages', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-1', createdAt: ts(0) });
        const m2 = makeTurnMessage({ sessionId: 'sess-1', createdAt: ts(100) });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);
        const list = await store.listTurnMessages('sess-1');
        expect(list).toHaveLength(2);
        expect(list[0].id).toBe(m1.id);
        expect(list[1].id).toBe(m2.id);
      });

      it('should filter by sessionId', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-1' });
        const m2 = makeTurnMessage({ sessionId: 'sess-2' });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);
        const list = await store.listTurnMessages('sess-1');
        expect(list).toHaveLength(1);
        expect(list[0].id).toBe(m1.id);
      });

      it('should return messages sorted by createdAt', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-1', order: 100, createdAt: ts(200) });
        const m2 = makeTurnMessage({ sessionId: 'sess-1', order: 900, createdAt: ts(0) });
        const m3 = makeTurnMessage({ sessionId: 'sess-1', order: 500, createdAt: ts(100) });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);
        await store.appendTurnMessage(m3);
        const list = await store.listTurnMessages('sess-1');
        expect(list).toHaveLength(3);
        expect(list[0].id).toBe(m2.id);
        expect(list[1].id).toBe(m3.id);
        expect(list[2].id).toBe(m1.id);
      });

      it('should support pagination with limit and offset', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-pg', createdAt: ts(10) });
        const m2 = makeTurnMessage({ sessionId: 'sess-pg', createdAt: ts(20) });
        const m3 = makeTurnMessage({ sessionId: 'sess-pg', createdAt: ts(30) });
        const m4 = makeTurnMessage({ sessionId: 'sess-pg', createdAt: ts(40) });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);
        await store.appendTurnMessage(m3);
        await store.appendTurnMessage(m4);

        // limit only
        const first2 = await store.listTurnMessages('sess-pg', { limit: 2 });
        expect(first2).toHaveLength(2);
        expect(first2[0].id).toBe(m1.id);
        expect(first2[1].id).toBe(m2.id);

        // limit + offset
        const page2 = await store.listTurnMessages('sess-pg', { limit: 2, offset: 2 });
        expect(page2).toHaveLength(2);
        expect(page2[0].id).toBe(m3.id);
        expect(page2[1].id).toBe(m4.id);

        // offset beyond end
        const empty = await store.listTurnMessages('sess-pg', { limit: 10, offset: 100 });
        expect(empty).toHaveLength(0);
      });
    });

    // ── Player Inputs ────────────────────────────────────────

    describe('PlayerInputs', () => {
      it('should savePlayerInput and getPlayerInput', async () => {
        const input = makePlayerInput({ sessionId: 'sess-1', formId: 'form-a' });
        await store.savePlayerInput(input);
        const result = await store.getPlayerInput('sess-1', 'form-a');
        expect(result).toEqual(input);
      });

      it('should return null for unknown playerInput', async () => {
        const result = await store.getPlayerInput('sess-1', 'nonexistent');
        expect(result).toBeNull();
      });

      it('should listPlayerInputs for a session', async () => {
        const i1 = makePlayerInput({ sessionId: 'sess-1', formId: 'form-a' });
        const i2 = makePlayerInput({ sessionId: 'sess-1', formId: 'form-b' });
        const i3 = makePlayerInput({ sessionId: 'sess-2', formId: 'form-c' });
        await store.savePlayerInput(i1);
        await store.savePlayerInput(i2);
        await store.savePlayerInput(i3);
        const list = await store.listPlayerInputs('sess-1');
        expect(list).toHaveLength(2);
        expect(list.map((r) => r.id)).toContain(i1.id);
        expect(list.map((r) => r.id)).toContain(i2.id);
      });
    });

    // ── Working Memory (S3-T3) ────────────────────────────────

    describe('WorkingMemory', () => {
      it('upsert + get roundtrip', async () => {
        const wm = makeWorkingMemory({ sessionId: 'wm-sess', scope: 'player', key: 'prefs' });
        await store.upsertWorkingMemory(wm);
        const result = await store.getWorkingMemory('wm-sess', 'player', 'prefs');
        expect(result).not.toBeNull();
        expect(result!.key).toBe('prefs');
        expect(result!.scope).toBe('player');
        expect(result!.sessionId).toBe('wm-sess');
        expect(result!.value).toEqual(wm.value);
      });

      it('list returns all entries for a session', async () => {
        const w1 = makeWorkingMemory({ sessionId: 'wm-list', scope: 'player', key: 'a' });
        const w2 = makeWorkingMemory({ sessionId: 'wm-list', scope: 'story', key: 'b' });
        const w3 = makeWorkingMemory({ sessionId: 'wm-list', scope: 'shared', key: 'c' });
        await store.upsertWorkingMemory(w1);
        await store.upsertWorkingMemory(w2);
        await store.upsertWorkingMemory(w3);
        const list = await store.listWorkingMemory('wm-list');
        expect(list).toHaveLength(3);
        const keys = list.map((r) => r.key);
        expect(keys).toContain('a');
        expect(keys).toContain('b');
        expect(keys).toContain('c');
      });

      it('upsert-on-conflict replaces the record (same sessionId+scope+key)', async () => {
        const wm = makeWorkingMemory({ sessionId: 'wm-upsert', scope: 'player', key: 'pref', value: 'v1' });
        await store.upsertWorkingMemory(wm);

        const wmUpdated = makeWorkingMemory({ sessionId: 'wm-upsert', scope: 'player', key: 'pref', value: 'v2' });
        await store.upsertWorkingMemory(wmUpdated);

        const list = await store.listWorkingMemory('wm-upsert');
        expect(list).toHaveLength(1);
        expect(list[0].value).toBe('v2');
      });

      it('delete removes only the targeted entry', async () => {
        const w1 = makeWorkingMemory({ sessionId: 'wm-del', scope: 'player', key: 'keep' });
        const w2 = makeWorkingMemory({ sessionId: 'wm-del', scope: 'player', key: 'remove' });
        await store.upsertWorkingMemory(w1);
        await store.upsertWorkingMemory(w2);

        await store.deleteWorkingMemory('wm-del', 'player', 'remove');

        const list = await store.listWorkingMemory('wm-del');
        expect(list).toHaveLength(1);
        expect(list[0].key).toBe('keep');

        const removed = await store.getWorkingMemory('wm-del', 'player', 'remove');
        expect(removed).toBeNull();
      });

      it('different sessions do not leak', async () => {
        await store.upsertWorkingMemory(
          makeWorkingMemory({ sessionId: 'wm-sess-A', scope: 'player', key: 'k', value: 'A' }),
        );
        await store.upsertWorkingMemory(
          makeWorkingMemory({ sessionId: 'wm-sess-B', scope: 'player', key: 'k', value: 'B' }),
        );

        const listA = await store.listWorkingMemory('wm-sess-A');
        const listB = await store.listWorkingMemory('wm-sess-B');
        expect(listA).toHaveLength(1);
        expect(listA[0].value).toBe('A');
        expect(listB).toHaveLength(1);
        expect(listB[0].value).toBe('B');
      });

      it('same key under different scopes are distinct records', async () => {
        const sessId = 'wm-scopes';
        await store.upsertWorkingMemory(
          makeWorkingMemory({ sessionId: sessId, scope: 'player', key: 'sameKey', value: 'player-val' }),
        );
        await store.upsertWorkingMemory(
          makeWorkingMemory({ sessionId: sessId, scope: 'story', key: 'sameKey', value: 'story-val' }),
        );

        const playerEntry = await store.getWorkingMemory(sessId, 'player', 'sameKey');
        const storyEntry = await store.getWorkingMemory(sessId, 'story', 'sameKey');
        expect(playerEntry).not.toBeNull();
        expect(storyEntry).not.toBeNull();
        expect(playerEntry!.value).toBe('player-val');
        expect(storyEntry!.value).toBe('story-val');

        const list = await store.listWorkingMemory(sessId);
        expect(list).toHaveLength(2);
      });

      it('rollback inside a transaction undoes working memory writes', async () => {
        const wm = makeWorkingMemory({ sessionId: 'wm-rollback', scope: 'player', key: 'rolled' });
        await store.beginTx();
        await store.upsertWorkingMemory(wm);
        await store.rollbackTx();

        const result = await store.getWorkingMemory('wm-rollback', 'player', 'rolled');
        expect(result).toBeNull();
      });
    });

    // ── Session Summaries (S2-T2) ────────────────────────────

    describe('SessionSummaries', () => {
      it('should saveSessionSummary and listSessionSummaries', async () => {
        const s = makeSessionSummary({ sessionId: 'sess-sum-1' });
        await store.saveSessionSummary(s);
        const list = await store.listSessionSummaries('sess-sum-1');
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({
          id: s.id,
          sessionId: s.sessionId,
          content: s.content,
          focusSections: s.focusSections,
        });
      });

      it('should return empty list for unknown session', async () => {
        const list = await store.listSessionSummaries('nonexistent-session');
        expect(list).toHaveLength(0);
      });

      it('should filter summaries by sessionId', async () => {
        const s1 = makeSessionSummary({ sessionId: 'sess-sum-filter-1' });
        const s2 = makeSessionSummary({ sessionId: 'sess-sum-filter-2' });
        await store.saveSessionSummary(s1);
        await store.saveSessionSummary(s2);
        const list1 = await store.listSessionSummaries('sess-sum-filter-1');
        expect(list1).toHaveLength(1);
        expect(list1[0].id).toBe(s1.id);
      });

      it('should deleteSessionSummaries by sessionId', async () => {
        const s1 = makeSessionSummary({ sessionId: 'sess-sum-del' });
        const s2 = makeSessionSummary({ sessionId: 'sess-sum-del' });
        await store.saveSessionSummary(s1);
        await store.saveSessionSummary(s2);
        await store.deleteSessionSummaries('sess-sum-del');
        const list = await store.listSessionSummaries('sess-sum-del');
        expect(list).toHaveLength(0);
      });

      it('should not delete summaries for other sessions', async () => {
        const keep = makeSessionSummary({ sessionId: 'sess-sum-keep' });
        const del = makeSessionSummary({ sessionId: 'sess-sum-nodel' });
        await store.saveSessionSummary(keep);
        await store.saveSessionSummary(del);
        await store.deleteSessionSummaries('sess-sum-nodel');
        const list = await store.listSessionSummaries('sess-sum-keep');
        expect(list).toHaveLength(1);
      });

      it('should tagTurnMessagesCompacted — set compactedAtTurnId', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-tag-1', id: id() });
        const m2 = makeTurnMessage({ sessionId: 'sess-tag-1', id: id() });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);

        const summaryId = 'summary-abc';
        await store.tagTurnMessagesCompacted('sess-tag-1', [m1.id, m2.id], summaryId);

        const messages = await store.listTurnMessages('sess-tag-1');
        for (const msg of messages) {
          expect(msg.compactedAtTurnId).toBe(summaryId);
        }
      });

      it('should not tag messages from other sessions', async () => {
        const m1 = makeTurnMessage({ sessionId: 'sess-tag-a', id: id() });
        const m2 = makeTurnMessage({ sessionId: 'sess-tag-b', id: id() });
        await store.appendTurnMessage(m1);
        await store.appendTurnMessage(m2);

        await store.tagTurnMessagesCompacted('sess-tag-a', [m1.id, m2.id], 'summary-xyz');

        const bMessages = await store.listTurnMessages('sess-tag-b');
        expect(bMessages[0].compactedAtTurnId).toBeUndefined();
      });

      it('should rollback saveSessionSummary in a transaction', async () => {
        const s = makeSessionSummary({ sessionId: 'sess-sum-tx' });
        await store.beginTx();
        await store.saveSessionSummary(s);
        await store.rollbackTx();
        const list = await store.listSessionSummaries('sess-sum-tx');
        expect(list).toHaveLength(0);
      });

      it('should rollback tagTurnMessagesCompacted in a transaction', async () => {
        const m = makeTurnMessage({ sessionId: 'sess-tag-tx', id: id() });
        await store.appendTurnMessage(m);

        await store.beginTx();
        await store.tagTurnMessagesCompacted('sess-tag-tx', [m.id], 'summary-rollback');
        await store.rollbackTx();

        const messages = await store.listTurnMessages('sess-tag-tx');
        expect(messages[0].compactedAtTurnId).toBeUndefined();
      });
    });

    // ── Suspensions (S4-T4) ──────────────────────────────────

    describe('Suspensions (S4-T4)', () => {
      it('should save and retrieve a suspension (roundtrip)', async () => {
        const suspension = makeSuspension({ sessionId: 'sess-susp-1' });
        await store.saveSuspension(suspension);
        const result = await store.getSuspension(suspension.id);
        expect(result).not.toBeNull();
        expect(result!.id).toBe(suspension.id);
        expect(result!.sessionId).toBe('sess-susp-1');
        expect(result!.reason).toBe(suspension.reason);
        expect(result!.resolvedAt).toBeUndefined();
      });

      it('should filter listSuspensions by sessionId', async () => {
        const s1 = makeSuspension({ sessionId: 'sess-susp-A' });
        const s2 = makeSuspension({ sessionId: 'sess-susp-A' });
        const s3 = makeSuspension({ sessionId: 'sess-susp-B' });
        await store.saveSuspension(s1);
        await store.saveSuspension(s2);
        await store.saveSuspension(s3);

        const listA = await store.listSuspensions('sess-susp-A');
        expect(listA).toHaveLength(2);
        expect(listA.map((s) => s.id)).toContain(s1.id);
        expect(listA.map((s) => s.id)).toContain(s2.id);

        const listB = await store.listSuspensions('sess-susp-B');
        expect(listB).toHaveLength(1);
        expect(listB[0].id).toBe(s3.id);
      });

      it('should markSuspensionResolved — sets resolvedAt, leaves other fields intact', async () => {
        const suspension = makeSuspension({ sessionId: 'sess-susp-res' });
        await store.saveSuspension(suspension);
        await store.markSuspensionResolved(suspension.id);

        const result = await store.getSuspension(suspension.id);
        expect(result).not.toBeNull();
        expect(result!.resolvedAt).not.toBeUndefined();
        // Other fields unchanged
        expect(result!.reason).toBe(suspension.reason);
        expect(result!.runtimeId).toBe(suspension.runtimeId);
      });

      it('should deleteSuspension — removes only the targeted record', async () => {
        const s1 = makeSuspension({ sessionId: 'sess-susp-del' });
        const s2 = makeSuspension({ sessionId: 'sess-susp-del' });
        await store.saveSuspension(s1);
        await store.saveSuspension(s2);

        await store.deleteSuspension(s1.id);

        const r1 = await store.getSuspension(s1.id);
        const r2 = await store.getSuspension(s2.id);
        expect(r1).toBeNull();
        expect(r2).not.toBeNull();
      });

      it('should return null for non-existent suspension ID', async () => {
        const result = await store.getSuspension('nonexistent-id');
        expect(result).toBeNull();
      });

      it('should roll back saveSuspension on rollbackTx', async () => {
        const suspension = makeSuspension({ sessionId: 'sess-susp-tx' });

        await store.beginTx();
        await store.saveSuspension(suspension);
        await store.rollbackTx();

        const result = await store.getSuspension(suspension.id);
        expect(result).toBeNull();
      });

      it('should persist complex resumeSchema JSON', async () => {
        const complexSchema = {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name'],
        };
        const suspension = makeSuspension({ sessionId: 'sess-susp-schema', resumeSchema: complexSchema });
        await store.saveSuspension(suspension);

        const result = await store.getSuspension(suspension.id);
        expect(result!.resumeSchema).toEqual(complexSchema);
      });
    });

    // ── Lorebook Entries (S3-T2) ─────────────────────────────

    describe('LorebookEntries (S3-T2)', () => {
      it('returns an empty list when the session has no entries', async () => {
        const result = await store.listSessionLorebookEntries('sess-lore-empty');
        expect(result).toEqual([]);
      });

      it('upserts a batch and lists them sorted by insertionOrder then id', async () => {
        const a = makeLorebookEntry({
          id: 'lore-a',
          sessionId: 'sess-lore-1',
          insertionOrder: 200,
          content: 'second',
        });
        const b = makeLorebookEntry({
          id: 'lore-b',
          sessionId: 'sess-lore-1',
          insertionOrder: 100,
          content: 'first',
          keys: ['ancient', 'temple'],
          strategy: 'selective',
          enabled: true,
        });
        const c = makeLorebookEntry({
          id: 'lore-c',
          sessionId: 'sess-lore-1',
          insertionOrder: 200,
          content: 'third',
          enabled: false,
          extra: { atDepth: 4, note: 'kept disabled for now' },
        });

        await store.upsertLorebookEntries([a, b, c]);

        const list = await store.listSessionLorebookEntries('sess-lore-1');
        expect(list.map((r) => r.id)).toEqual(['lore-b', 'lore-a', 'lore-c']);
        expect(list[0].keys).toEqual(['ancient', 'temple']);
        expect(list[0].strategy).toBe('selective');
        expect(list[2].enabled).toBe(false);
        expect(list[2].extra).toEqual({ atDepth: 4, note: 'kept disabled for now' });
      });

      it('replaces existing entries on re-upsert with the same id', async () => {
        const original = makeLorebookEntry({
          id: 'lore-update',
          sessionId: 'sess-lore-2',
          content: 'original',
          insertionOrder: 300,
        });
        await store.upsertLorebookEntries([original]);

        const updated = {
          ...original,
          content: 'updated',
          insertionOrder: 50,
          updatedAt: ts(1),
        };
        await store.upsertLorebookEntries([updated]);

        const list = await store.listSessionLorebookEntries('sess-lore-2');
        expect(list).toHaveLength(1);
        expect(list[0].content).toBe('updated');
        expect(list[0].insertionOrder).toBe(50);
      });

      it('isolates entries by sessionId', async () => {
        await store.upsertLorebookEntries([
          makeLorebookEntry({ id: 'lore-x', sessionId: 'sess-lore-A' }),
          makeLorebookEntry({ id: 'lore-y', sessionId: 'sess-lore-B' }),
        ]);

        const a = await store.listSessionLorebookEntries('sess-lore-A');
        const b = await store.listSessionLorebookEntries('sess-lore-B');
        expect(a.map((r) => r.id)).toEqual(['lore-x']);
        expect(b.map((r) => r.id)).toEqual(['lore-y']);
      });

      it('deleteLorebookEntry removes a single entry by sessionId+id', async () => {
        await store.upsertLorebookEntries([
          makeLorebookEntry({ id: 'lore-keep', sessionId: 'sess-lore-del' }),
          makeLorebookEntry({ id: 'lore-drop', sessionId: 'sess-lore-del' }),
        ]);

        await store.deleteLorebookEntry('sess-lore-del', 'lore-drop');
        const list = await store.listSessionLorebookEntries('sess-lore-del');
        expect(list.map((r) => r.id)).toEqual(['lore-keep']);
      });
    });

    // ── Snapshots (S4-T2) ────────────────────────────────────

    describe('Snapshots (S4-T2)', () => {
      it('should save and retrieve a snapshot (roundtrip)', async () => {
        const snap = makeSnapshot({ sessionId: 'sess-snap-1', kind: 'manual' });
        await store.saveSnapshot(snap);
        const result = await store.getSnapshot(snap.id);
        expect(result).not.toBeNull();
        expect(result!.id).toBe(snap.id);
        expect(result!.sessionId).toBe('sess-snap-1');
        expect(result!.kind).toBe('manual');
        expect(result!.turnId).toBe(snap.turnId);
      });

      it('should return null for non-existent snapshot ID', async () => {
        const result = await store.getSnapshot('nonexistent-snapshot');
        expect(result).toBeNull();
      });

      it('should filter listSnapshots by sessionId and sort by createdAt', async () => {
        const s1 = makeSnapshot({ sessionId: 'sess-snap-A', createdAt: ts(0) });
        const s2 = makeSnapshot({ sessionId: 'sess-snap-A', createdAt: ts(1000) });
        const s3 = makeSnapshot({ sessionId: 'sess-snap-B' });
        await store.saveSnapshot(s1);
        await store.saveSnapshot(s2);
        await store.saveSnapshot(s3);

        const listA = await store.listSnapshots('sess-snap-A');
        expect(listA).toHaveLength(2);
        expect(listA[0].id).toBe(s1.id);
        expect(listA[1].id).toBe(s2.id);

        const listB = await store.listSnapshots('sess-snap-B');
        expect(listB).toHaveLength(1);
        expect(listB[0].id).toBe(s3.id);
      });

      it('should deleteSnapshot — removes only the targeted record', async () => {
        const s1 = makeSnapshot({ sessionId: 'sess-snap-del' });
        const s2 = makeSnapshot({ sessionId: 'sess-snap-del' });
        await store.saveSnapshot(s1);
        await store.saveSnapshot(s2);

        await store.deleteSnapshot(s1.id);

        expect(await store.getSnapshot(s1.id)).toBeNull();
        expect(await store.getSnapshot(s2.id)).not.toBeNull();
      });

      it('should persist all payload slices verbatim', async () => {
        const payload = makeSnapshotPayload({
          characters: [
            {
              id: 'char-1',
              sessionId: 'sess-snap-pay',
              name: 'Hero',
              type: 'player',
              version: 1,
              createdAt: ts(),
              updatedAt: ts(),
            },
          ],
          stateEntries: [
            {
              id: 'se-1',
              sessionId: 'sess-snap-pay',
              tableName: 'stats',
              fieldName: 'hp',
              value: 100,
              updatedAt: ts(),
            },
          ],
          pluginData: [
            {
              id: 'pd-1',
              sessionId: 'sess-snap-pay',
              pluginId: 'test-plugin',
              namespace: 'ns',
              key: 'k',
              value: { a: 1 },
              createdAt: ts(),
              updatedAt: ts(),
            },
          ],
          workingMemory: [
            {
              id: 'wm-1',
              sessionId: 'sess-snap-pay',
              key: 'mood',
              scope: 'player',
              value: 'curious',
              updatedAt: ts(),
            },
          ],
          messagesCursor: 'tm-last-abc',
        });
        const snap = makeSnapshot({ sessionId: 'sess-snap-pay', payload });
        await store.saveSnapshot(snap);

        const result = await store.getSnapshot(snap.id);
        expect(result).not.toBeNull();
        expect(result!.payload.characters).toHaveLength(1);
        expect(result!.payload.characters[0].name).toBe('Hero');
        expect(result!.payload.stateEntries[0].value).toBe(100);
        expect(result!.payload.pluginData[0].value).toEqual({ a: 1 });
        expect(result!.payload.workingMemory[0].scope).toBe('player');
        expect(result!.payload.messagesCursor).toBe('tm-last-abc');
      });

      it('should record parentId for kind="fork" snapshots', async () => {
        const origin = makeSnapshot({ sessionId: 'sess-snap-origin', kind: 'auto' });
        await store.saveSnapshot(origin);

        const forkChild = makeSnapshot({
          sessionId: 'sess-snap-fork-child',
          kind: 'fork',
          parentId: origin.id,
        });
        await store.saveSnapshot(forkChild);

        const result = await store.getSnapshot(forkChild.id);
        expect(result!.kind).toBe('fork');
        expect(result!.parentId).toBe(origin.id);
      });

      it('should roll back saveSnapshot on rollbackTx', async () => {
        const snap = makeSnapshot({ sessionId: 'sess-snap-tx' });

        await store.beginTx();
        await store.saveSnapshot(snap);
        await store.rollbackTx();

        expect(await store.getSnapshot(snap.id)).toBeNull();
      });

      it('should commit saveSnapshot on commitTx', async () => {
        const snap = makeSnapshot({ sessionId: 'sess-snap-tx-commit' });

        await store.beginTx();
        await store.saveSnapshot(snap);
        await store.commitTx();

        const result = await store.getSnapshot(snap.id);
        expect(result).not.toBeNull();
        expect(result!.id).toBe(snap.id);
      });
    });

    // ── Transactions (S4-T1) ─────────────────────────────────

    describe('transactions (S4-T1)', () => {
      it('rolls back all writes on rollbackTx', async () => {
        // Baseline — no sessions yet
        const before = await store.listSessions();
        const baselineIds = new Set(before.map((s) => s.id));

        const s1 = makeSession();
        const s2 = makeSession();

        await store.beginTx();
        await store.createSession(s1);
        await store.createSession(s2);
        await store.rollbackTx();

        const after = await store.listSessions();
        const afterIds = after.map((s) => s.id);
        expect(afterIds).not.toContain(s1.id);
        expect(afterIds).not.toContain(s2.id);
        // Rollback must not delete pre-existing rows either
        for (const id of baselineIds) {
          expect(afterIds).toContain(id);
        }
      });

      it('commits all writes on commitTx', async () => {
        const s1 = makeSession();
        const s2 = makeSession();

        await store.beginTx();
        await store.createSession(s1);
        await store.createSession(s2);
        await store.commitTx();

        const r1 = await store.getSession(s1.id);
        const r2 = await store.getSession(s2.id);
        expect(r1).not.toBeNull();
        expect(r2).not.toBeNull();
      });

      it('throws on nested beginTx', async () => {
        await store.beginTx();
        try {
          await expect(store.beginTx()).rejects.toThrow();
        } finally {
          await store.rollbackTx();
        }
      });

      it('throws on commitTx without an active transaction', async () => {
        await expect(store.commitTx()).rejects.toThrow();
      });

      it('throws on rollbackTx without an active transaction', async () => {
        await expect(store.rollbackTx()).rejects.toThrow();
      });
    });

    // ── Lifecycle ────────────────────────────────────────────

    describe('Lifecycle', () => {
      it('should close without throwing', async () => {
        await expect(store.close()).resolves.not.toThrow();
      });
    });
  });
}
