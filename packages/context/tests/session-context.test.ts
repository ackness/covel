import { describe, it, expect } from 'vitest';
import { createMemoryStore } from '@covel/store';
import type {
  DataStore,
  CharacterRecord,
  LorebookEntryRecord,
  PlayerInputRecord,
  PluginDataRecord,
  SessionRecord,
  WorkingMemoryRecord,
  WorldRecord,
} from '@covel/store';
import { buildSessionContextSnapshot } from '@covel/context';
import { loadSessionConfig } from '../../../apps/server/src/routes/api/load-session-config.js';

// ── Helpers ─────────────────────────────────────────────────────

function ts(offsetMs = 0): string {
  return new Date(Date.parse('2026-01-01T00:00:00.000Z') + offsetMs).toISOString();
}

function makeSession(overrides?: Partial<SessionRecord>): SessionRecord {
  return {
    id: 'sess-1',
    worldId: 'w1',
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

function makeWorld(overrides?: Partial<WorldRecord>): WorldRecord {
  return {
    id: 'w1',
    name: 'W',
    description: 'd',
    lore: 'The land of Ash',
    metadata: {
      dimensions: {
        tone: 'noir',
        startingConditions: { openingScenario: 'You wake in a cell' },
      },
    },
    createdAt: ts(),
    ...overrides,
  };
}

function makeCharacter(overrides?: Partial<CharacterRecord>): CharacterRecord {
  return {
    id: 'char-1',
    sessionId: 'sess-1',
    name: 'Hero',
    type: 'player',
    version: 1,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makePluginData(overrides: Partial<PluginDataRecord> & { key: string }): PluginDataRecord {
  return {
    id: `pd-${overrides.namespace ?? 'ns'}-${overrides.key}`,
    sessionId: 'sess-1',
    pluginId: 'world-data',
    namespace: 'schema',
    value: {},
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeLorebookEntry(overrides: Partial<LorebookEntryRecord> & { id: string }): LorebookEntryRecord {
  return {
    sessionId: 'sess-1',
    pluginId: 'world-data',
    keys: [],
    content: 'lorebook content',
    strategy: 'constant',
    position: 'after_char_defs',
    insertionOrder: 100,
    enabled: true,
    createdAt: ts(),
    updatedAt: ts(),
    ...overrides,
  };
}

function makeWorkingMemory(overrides: Partial<WorkingMemoryRecord> & { id: string }): WorkingMemoryRecord {
  return {
    sessionId: 'sess-1',
    key: 'foo',
    scope: 'shared',
    value: 'bar',
    updatedAt: ts(),
    ...overrides,
  };
}

function makePlayerInput(overrides: Partial<PlayerInputRecord> & { id: string }): PlayerInputRecord {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    formId: 'f1',
    values: { name: 'test' },
    createdAt: ts(),
    ...overrides,
  };
}

// ── Test A: Basic shape ─────────────────────────────────────────

describe('buildSessionContextSnapshot — basic shape', () => {
  it('returns a fully-shaped snapshot with empty defaults for an empty store', async () => {
    const store = createMemoryStore();
    const snapshot = await buildSessionContextSnapshot(store, 'sess-1', {
      locale: 'en-US',
      turnNumber: 0,
    });

    // Top-level shape
    expect(snapshot.sessionId).toBe('sess-1');
    expect(snapshot.turnNumber).toBe(0);
    expect(snapshot.locale).toBe('en-US');
    expect(snapshot.sessionMeta).toBeDefined();
    expect(snapshot.sessionMeta.turnNumber).toBe(0);
    expect(snapshot.sessionMeta.lastFormValues).toBeUndefined();

    expect(snapshot.world).toBeDefined();
    expect(snapshot.world.id).toBe('');

    expect(snapshot.characters).toEqual([]);
    expect(snapshot.workingMemory).toEqual([]);
    expect(snapshot.coreMemoryBlocks).toEqual([]);
    expect(snapshot.loreEntries).toEqual([]);
    expect(snapshot.summaries).toEqual([]);
    expect(snapshot.contributions).toEqual([]);
    expect(snapshot.activePersona).toBeUndefined();

    // legacyConfigView must be a plain object with no keys when no sources exist.
    expect(snapshot.legacyConfigView).toEqual({});
    expect(Object.keys(snapshot.legacyConfigView)).toHaveLength(0);
  });
});

// ── Test B: Parity with loadSessionConfig ───────────────────────

describe('buildSessionContextSnapshot — legacyConfigView parity', () => {
  it('produces legacyConfigView byte-for-byte equal to loadSessionConfig', async () => {
    const store = createMemoryStore();
    const world = makeWorld();
    await store.upsertWorld(world);

    const session = makeSession();
    await store.createSession(session);

    // Plugin data — schema namespace (always used)
    await store.setPluginData(
      makePluginData({
        namespace: 'schema',
        key: 'dimensions',
        value: { tone: 'noir' },
      }),
    );
    await store.setPluginData(
      makePluginData({
        namespace: 'schema',
        key: 'startingConditions',
        value: { openingScenario: 'X' },
      }),
    );

    // Lorebook entries — the canonical source for worldEntries (FU-8).
    // Two constant, enabled entries for the world-data plugin.
    await store.upsertLorebookEntries([
      makeLorebookEntry({
        id: 'lore-a',
        insertionOrder: 50,
        keys: ['alpha'],
        content: 'Alpha content',
      }),
      makeLorebookEntry({
        id: 'lore-b',
        insertionOrder: 100,
        keys: ['beta'],
        content: 'Beta content',
      }),
    ]);

    const legacy = await loadSessionConfig(store, 'sess-1', 'w1', 'world-data');
    const snapshot = await buildSessionContextSnapshot(store, 'sess-1', {
      locale: 'zh-CN',
      turnNumber: 0,
      worldId: 'w1',
      worldDataPluginId: 'world-data',
    });

    // Byte-for-byte: deep-equal + identical key order.
    expect(snapshot.legacyConfigView).toEqual(legacy);
    expect(Object.keys(snapshot.legacyConfigView)).toEqual(Object.keys(legacy));

    // WorldContextView spot-checks
    expect(snapshot.world.id).toBe('w1');
    expect(snapshot.world.lore).toBe('The land of Ash');
    expect(snapshot.world.tone).toBe('noir');
    expect(snapshot.world.openingScenario).toBe('You wake in a cell');
    expect(snapshot.world.dimensions).toEqual({
      tone: 'noir',
      startingConditions: { openingScenario: 'You wake in a cell' },
    });

    // WorldContextView.entries is the array form; legacy.worldEntries is the map form.
    expect(Array.isArray(snapshot.world.entries)).toBe(true);
    expect(snapshot.world.entries).toHaveLength(2);
    expect(snapshot.world.entries?.[0]).toEqual({ key: 'alpha', content: 'Alpha content' });
    expect(snapshot.world.entries?.[1]).toEqual({ key: 'beta', content: 'Beta content' });

    // legacy.worldEntries preserves the map-of-key-to-content shape verbatim.
    expect(legacy.worldEntries).toEqual({
      alpha: 'Alpha content',
      beta: 'Beta content',
    });
  });

  it('falls back to plugin_data when no lorebook entries exist', async () => {
    const store = createMemoryStore();
    await store.upsertWorld(makeWorld({ id: 'w2', lore: undefined, metadata: undefined }));
    await store.createSession(makeSession({ id: 'sess-fallback', worldId: 'w2' }));
    await store.setPluginData(
      makePluginData({
        sessionId: 'sess-fallback',
        namespace: 'entries',
        key: 'gamma',
        value: 'Gamma content',
      }),
    );

    const legacy = await loadSessionConfig(store, 'sess-fallback', 'w2', 'world-data');
    const snapshot = await buildSessionContextSnapshot(store, 'sess-fallback', {
      locale: 'zh-CN',
      turnNumber: 0,
      worldId: 'w2',
      worldDataPluginId: 'world-data',
    });

    expect(snapshot.legacyConfigView).toEqual(legacy);
    expect(legacy.worldEntries).toEqual({ gamma: 'Gamma content' });
    expect(snapshot.world.entries).toEqual([{ key: 'gamma', content: 'Gamma content' }]);
  });
});

// ── Test C: Working memory + core memory + summaries ────────────

describe('buildSessionContextSnapshot — memory + summaries wiring', () => {
  it('threads workingMemory, coreMemoryBlocks and summaries through correctly', async () => {
    const store = createMemoryStore();
    await store.createSession(makeSession());
    await store.upsertCharacter(makeCharacter());
    await store.upsertWorkingMemory(
      makeWorkingMemory({ id: 'wm-1', key: 'foo', scope: 'shared', value: 'bar' }),
    );
    await store.savePlayerInput(
      makePlayerInput({ id: 'pi-1', values: { choice: 'left' } }),
    );

    const coreMemoryBlocks = [
      { label: 'persona', content: 'X', updatedAt: '2026-01-01' },
    ] as const;
    const summaries = [
      { id: 's1', content: 'summary text', focusSections: ['scene'] },
    ] as const;

    const snapshot = await buildSessionContextSnapshot(store, 'sess-1', {
      locale: 'zh-CN',
      turnNumber: 3,
      coreMemoryBlocks,
      summaries,
    });

    expect(snapshot.workingMemory).toEqual([
      { scope: 'shared', key: 'foo', value: 'bar' },
    ]);
    expect(snapshot.coreMemoryBlocks).toEqual(coreMemoryBlocks);
    expect(snapshot.summaries).toEqual(summaries);

    // Character + player input wiring
    expect(snapshot.characters).toEqual([
      { name: 'Hero', type: 'player', description: undefined, fields: undefined },
    ]);
    expect(snapshot.sessionMeta.lastFormValues).toEqual({ choice: 'left' });
    expect(snapshot.sessionMeta.turnNumber).toBe(3);
  });
});

// ── Test D: Graceful degradation ────────────────────────────────

describe('buildSessionContextSnapshot — graceful degradation', () => {
  it('swallows store failures and returns a valid empty snapshot', async () => {
    const failingStore: Partial<DataStore> = {
      getSession: async () => {
        throw new Error('boom');
      },
      listCharacters: async () => {
        throw new Error('boom');
      },
      listPlayerInputs: async () => {
        throw new Error('boom');
      },
      listWorkingMemory: async () => {
        throw new Error('boom');
      },
      listSessionLorebookEntries: async () => {
        throw new Error('boom');
      },
      getWorld: async () => {
        throw new Error('boom');
      },
      listPluginData: async () => {
        throw new Error('boom');
      },
    };

    const snapshot = await buildSessionContextSnapshot(
      failingStore as DataStore,
      'sess-broken',
      {
        locale: 'zh-CN',
        turnNumber: 0,
        worldId: 'w-broken',
        worldDataPluginId: 'world-data',
      },
    );

    expect(snapshot.characters).toEqual([]);
    expect(snapshot.workingMemory).toEqual([]);
    expect(snapshot.loreEntries).toEqual([]);
    expect(snapshot.legacyConfigView).toEqual({});
    expect(snapshot.sessionMeta.lastFormValues).toBeUndefined();
  });
});
