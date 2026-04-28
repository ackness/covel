/**
 * Unit tests for `loadSessionConfig` — `{{ config.worldEntries }}` resolution
 * (FU-8 follow-up to S3-T2 lorebook migration).
 *
 * The loader resolves `worldEntries` in this order:
 *   1. Session lorebook (`listSessionLorebookEntries`) — canonical, constant
 *      entries for the world-data-provider plugin, sorted by insertionOrder.
 *   2. Plugin data (`listPluginData namespace=entries`) — legacy fallback
 *      for sessions that predate the lorebook migration.
 *
 * These tests drive both branches against a fresh MemoryStore so we prove
 * the backward-compat fallback still works and the lorebook-first path
 * wins when data is present.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMemoryStore, type DataStore } from '@covel/store';
import { loadSessionConfig } from '../../src/routes/api/load-session-config.js';

const SESSION_ID = 'load-cfg-sess';
const PLUGIN_ID = 'world-init';

async function seedSession(store: DataStore): Promise<void> {
  await store.createSession({
    id: SESSION_ID,
    worldId: undefined,
    status: 'active',
    turnCount: 1,
    preGameCompleted: [],
    locale: 'en',
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('loadSessionConfig worldEntries resolution', () => {
  let store: DataStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await seedSession(store);
  });

  it('falls back to plugin_data when the session has no lorebook entries', async () => {
    const now = new Date().toISOString();
    await store.setPluginDataBatch([
      {
        id: 'pd-1',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        namespace: 'entries',
        key: 'geography',
        value: { regions: ['north'] },
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'pd-2',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        namespace: 'entries',
        key: 'factions',
        value: { groups: ['alpha'] },
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const cfg = await loadSessionConfig(store, SESSION_ID, undefined, PLUGIN_ID);

    expect(cfg.worldEntries).toBeDefined();
    expect(Object.keys(cfg.worldEntries as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['geography', 'factions']),
    );
  });

  it('prefers lorebook constant entries when both sources exist', async () => {
    const now = new Date().toISOString();
    // Seed plugin_data with a stale value — this MUST be ignored.
    await store.setPluginDataBatch([
      {
        id: 'pd-stale',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        namespace: 'entries',
        key: 'geography',
        value: { regions: ['stale'] },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    // Seed lorebook with the canonical value.
    await store.upsertLorebookEntries!([
      {
        id: 'world-entry:geography',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['geography'],
        content: '[geography]\nThe canonical continent layout.',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'world-entry:factions',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['factions'],
        content: '[factions]\nSkyguard, Tradewind Syndicate.',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 200,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const cfg = await loadSessionConfig(store, SESSION_ID, undefined, PLUGIN_ID);

    const worldEntries = cfg.worldEntries as Record<string, unknown>;
    expect(worldEntries).toBeDefined();
    expect(worldEntries.geography).toBe('[geography]\nThe canonical continent layout.');
    expect(worldEntries.factions).toBe('[factions]\nSkyguard, Tradewind Syndicate.');
  });

  it('skips disabled and non-constant lorebook entries', async () => {
    const now = new Date().toISOString();
    await store.upsertLorebookEntries!([
      {
        id: 'world-entry:geography',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['geography'],
        content: 'on',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'world-entry:disabled',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['disabled'],
        content: 'off',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 110,
        enabled: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'world-entry:selective',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['selective'],
        content: 'scan-only',
        strategy: 'selective',
        position: 'after_char_defs',
        insertionOrder: 120,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const cfg = await loadSessionConfig(store, SESSION_ID, undefined, PLUGIN_ID);

    const worldEntries = cfg.worldEntries as Record<string, unknown>;
    expect(Object.keys(worldEntries)).toEqual(['geography']);
  });

  it('returns empty config when no plugin id and no world id are supplied', async () => {
    const cfg = await loadSessionConfig(store, SESSION_ID);
    expect(cfg).toEqual({});
  });

  it('filters lorebook entries by the provided world-data-provider plugin id', async () => {
    const now = new Date().toISOString();
    await store.upsertLorebookEntries!([
      {
        id: 'world-entry:mine',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['mine'],
        content: 'mine',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'world-entry:other',
        sessionId: SESSION_ID,
        pluginId: 'some-other-plugin',
        keys: ['other'],
        content: 'other',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const cfg = await loadSessionConfig(store, SESSION_ID, undefined, PLUGIN_ID);
    const worldEntries = cfg.worldEntries as Record<string, unknown>;
    expect(Object.keys(worldEntries)).toEqual(['mine']);
  });
});

// ── Sprint 1-D parity tests ─────────────────────────────────────────
//
// Verify that toggling COVEL_SESSION_CONTEXT=1 (which swaps the
// implementation to `buildSessionContextSnapshot(...).legacyConfigView`)
// produces byte-identical output for every fixture shape covered above.

describe('loadSessionConfig — Sprint 1-D snapshot delegation parity', () => {
  let originalEnv: string | undefined;
  let store: DataStore;

  beforeEach(async () => {
    originalEnv = process.env.COVEL_SESSION_CONTEXT;
    store = createMemoryStore();
    await seedSession(store);
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COVEL_SESSION_CONTEXT;
    } else {
      process.env.COVEL_SESSION_CONTEXT = originalEnv;
    }
  });

  async function computeBoth(
    worldId: string | undefined,
    pluginId: string | undefined,
  ): Promise<{ legacy: Readonly<Record<string, unknown>>; snapshot: Readonly<Record<string, unknown>> }> {
    delete process.env.COVEL_SESSION_CONTEXT;
    const legacy = await loadSessionConfig(store, SESSION_ID, worldId, pluginId);
    process.env.COVEL_SESSION_CONTEXT = '1';
    const snapshot = await loadSessionConfig(store, SESSION_ID, worldId, pluginId);
    return { legacy, snapshot };
  }

  it('lorebook-first path: snapshot === legacy (keys + values + order)', async () => {
    const now = new Date().toISOString();
    await store.upsertLorebookEntries!([
      {
        id: 'world-entry:geography',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['geography'],
        content: '[geography]\nCanonical layout.',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 100,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'world-entry:factions',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        keys: ['factions'],
        content: '[factions]\nSkyguard, Tradewind Syndicate.',
        strategy: 'constant',
        position: 'after_char_defs',
        insertionOrder: 200,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const { legacy, snapshot } = await computeBoth(undefined, PLUGIN_ID);
    expect(snapshot).toEqual(legacy);
    expect(Object.keys(snapshot)).toEqual(Object.keys(legacy));
  });

  it('plugin_data fallback path: snapshot === legacy', async () => {
    const now = new Date().toISOString();
    await store.setPluginDataBatch([
      {
        id: 'pd-1',
        sessionId: SESSION_ID,
        pluginId: PLUGIN_ID,
        namespace: 'entries',
        key: 'geography',
        value: { regions: ['north'] },
        createdAt: now,
        updatedAt: now,
      },
    ]);
    const { legacy, snapshot } = await computeBoth(undefined, PLUGIN_ID);
    expect(snapshot).toEqual(legacy);
  });

  it('world-only path (no plugin id): snapshot === legacy', async () => {
    await store.upsertWorld({
      id: 'w-parity',
      name: 'Parity',
      description: 'd',
      lore: 'Lore text',
      metadata: {
        dimensions: {
          tone: 'solemn',
          startingConditions: { openingScenario: 'Night' },
        },
      },
      createdAt: new Date().toISOString(),
    });

    const { legacy, snapshot } = await computeBoth('w-parity', undefined);
    expect(snapshot).toEqual(legacy);
    expect(snapshot.worldLore).toBe('Lore text');
    expect(snapshot.worldTone).toBe('solemn');
    expect(snapshot.worldOpeningScenario).toBe('Night');
  });

  it('empty inputs path: both return {}', async () => {
    const { legacy, snapshot } = await computeBoth(undefined, undefined);
    expect(legacy).toEqual({});
    expect(snapshot).toEqual({});
  });
});
