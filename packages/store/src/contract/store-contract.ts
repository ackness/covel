/**
 * Reusable contract tests for any DataStore implementation.
 * Each backend (Memory, SQLite, PG) runs this same suite.
 */

import { describe, it, expect, beforeEach } from 'vitest';
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
  TurnMessageRecord,
  PlayerInputRecord,
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
    phase: 'playing',
    turnCount: 0,
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

      it('should update session phase and turnCount', async () => {
        const session = makeSession({ phase: 'init', turnCount: 0 });
        await store.createSession(session);
        const now = ts();
        await store.updateSession(session.id, {
          phase: 'playing',
          turnCount: 5,
          updatedAt: now,
        });
        const result = await store.getSession(session.id);
        expect(result?.phase).toBe('playing');
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

    // ── Lifecycle ────────────────────────────────────────────

    describe('Lifecycle', () => {
      it('should close without throwing', async () => {
        await expect(store.close()).resolves.not.toThrow();
      });
    });
  });
}
