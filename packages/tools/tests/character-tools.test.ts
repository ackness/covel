/**
 * Tests for builtin character management tools.
 *
 * Verifies that create-character / update-character / list-characters / get-character
 * correctly read and write CharacterRecord via the injected store, and that writes
 * are mirrored to plugin_data[pluginId][characters][charId] for panel reactivity.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCharacterTools } from '../src/builtin/character-tools.js';
import type { ToolModule, ToolExecutionContext } from '../src/types.js';

interface CharacterLike {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  description?: string;
  fields?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface PluginDataLike {
  id: string;
  sessionId: string;
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Minimal in-memory store that satisfies the character + plugin-data subset used by the tools. */
function createMockStore() {
  const characters: CharacterLike[] = [];
  const pluginData: PluginDataLike[] = [];
  const sessionPatches: Array<{ id: string; patch: Record<string, unknown> }> = [];

  return {
    characters,
    pluginData,
    sessionPatches,
    upsertCharacter: vi.fn(async (record: CharacterLike) => {
      const idx = characters.findIndex((c) => c.id === record.id);
      if (idx >= 0) characters[idx] = record;
      else characters.push(record);
    }),
    listCharacters: vi.fn(async (sessionId: string) =>
      characters.filter((c) => c.sessionId === sessionId),
    ),
    setPluginData: vi.fn(async (record: PluginDataLike) => {
      const idx = pluginData.findIndex(
        (r) =>
          r.sessionId === record.sessionId &&
          r.pluginId === record.pluginId &&
          r.namespace === record.namespace &&
          r.key === record.key,
      );
      if (idx >= 0) pluginData[idx] = record;
      else pluginData.push(record);
    }),
    deletePluginData: vi.fn(async (
      sessionId: string,
      pluginId: string,
      namespace: string,
      key: string,
    ) => {
      const idx = pluginData.findIndex(
        (r) =>
          r.sessionId === sessionId &&
          r.pluginId === pluginId &&
          r.namespace === namespace &&
          r.key === key,
      );
      if (idx >= 0) pluginData.splice(idx, 1);
    }),
    updateSession: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      sessionPatches.push({ id, patch });
    }),
  };
}

function ctx(pluginId = 'core-char-creator', sessionId = 'sess-1'): ToolExecutionContext {
  return {
    sessionId,
    turnId: 'turn-1',
    pluginId,
    runtimeId: `${pluginId}/runtime`,
  };
}

function findByName(tools: readonly ToolModule[], name: string): ToolModule {
  const t = tools.find((m) => m.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

describe('builtin character tools', () => {
  let store: ReturnType<typeof createMockStore>;
  let tools: readonly ToolModule[];

  beforeEach(() => {
    store = createMockStore();
    tools = createCharacterTools(store);
  });

  it('factory returns four named tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create-character',
      'get-character',
      'list-characters',
      'update-character',
    ]);
  });

  describe('create-character', () => {
    it('writes to characters table with provided fields', async () => {
      const t = findByName(tools, 'create-character');
      const result = await t.execute(
        {
          name: '柳无痕',
          type: 'player',
          description: '外门弟子，灵识敏锐',
          fields: { hp: 100, level: 1, lingGen: '水灵根' },
        },
        ctx(),
      );

      expect(result).toMatchObject({
        success: true,
        characterId: expect.any(String),
        name: '柳无痕',
        type: 'player',
      });

      expect(store.characters).toHaveLength(1);
      const char = store.characters[0];
      expect(char.sessionId).toBe('sess-1');
      expect(char.name).toBe('柳无痕');
      expect(char.type).toBe('player');
      expect(char.description).toBe('外门弟子，灵识敏锐');
      expect(char.fields).toEqual({ hp: 100, level: 1, lingGen: '水灵根' });
      expect(char.version).toBe(1);
      expect(char.createdAt).toBeDefined();
      expect(char.updatedAt).toBeDefined();
    });

    it('mirrors character to plugin-data for panel reactivity', async () => {
      const t = findByName(tools, 'create-character');
      const result = await t.execute(
        { name: 'Alice', type: 'npc' },
        ctx('core-char-creator', 'sess-1'),
      );
      const charId = (result as { characterId: string }).characterId;

      expect(store.pluginData).toHaveLength(1);
      const mirror = store.pluginData[0];
      expect(mirror.pluginId).toBe('core-char-creator');
      expect(mirror.namespace).toBe('characters');
      expect(mirror.key).toBe(charId);
      expect((mirror.value as { name: string }).name).toBe('Alice');
      expect((mirror.value as { type: string }).type).toBe('npc');
    });

    it('validates type field and rejects invalid values', async () => {
      const t = findByName(tools, 'create-character');
      await expect(
        t.execute({ name: 'X', type: 'invalid' as never }, ctx()),
      ).rejects.toThrow();
    });

    it('requires a non-empty name', async () => {
      const t = findByName(tools, 'create-character');
      await expect(
        t.execute({ name: '', type: 'player' }, ctx()),
      ).rejects.toThrow();
    });

    it('generates a unique id per call', async () => {
      const t = findByName(tools, 'create-character');
      const r1 = await t.execute({ name: 'A', type: 'npc' }, ctx());
      const r2 = await t.execute({ name: 'B', type: 'npc' }, ctx());
      expect((r1 as { characterId: string }).characterId).not.toBe(
        (r2 as { characterId: string }).characterId,
      );
      expect(store.characters).toHaveLength(2);
    });

    it('transitions session phase when transitionPhase is provided for player type', async () => {
      const t = findByName(tools, 'create-character');
      await t.execute(
        { name: '柳无痕', type: 'player', transitionPhase: 'playing' },
        ctx(),
      );
      expect(store.sessionPatches).toEqual([
        { id: 'sess-1', patch: expect.objectContaining({ phase: 'playing' }) },
      ]);
    });

    it('does not transition phase when transitionPhase is omitted', async () => {
      const t = findByName(tools, 'create-character');
      await t.execute({ name: 'X', type: 'player' }, ctx());
      expect(store.sessionPatches).toEqual([]);
    });

    it('does not transition phase for non-player characters even if transitionPhase set', async () => {
      const t = findByName(tools, 'create-character');
      await t.execute(
        { name: 'Ghost', type: 'npc', transitionPhase: 'playing' },
        ctx(),
      );
      expect(store.sessionPatches).toEqual([]);
    });

    it('is idempotent for same (name, type) — returns existing id instead of creating duplicate', async () => {
      const t = findByName(tools, 'create-character');
      const r1 = await t.execute(
        { name: '赵铁山', type: 'npc', description: '师叔', fields: { hp: 40 } },
        ctx(),
      );
      const r2 = await t.execute(
        { name: '赵铁山', type: 'npc', description: '师叔 v2', fields: { hp: 45 } },
        ctx(),
      );
      const id1 = (r1 as { characterId: string }).characterId;
      const id2 = (r2 as { characterId: string }).characterId;
      expect(id2).toBe(id1);
      expect((r2 as { existed: boolean }).existed).toBe(true);
      // Only one character row in the store
      expect(store.characters.filter((c) => c.name === '赵铁山')).toHaveLength(1);
    });

    it('allows different types with same name (player 与 npc 可以同名)', async () => {
      const t = findByName(tools, 'create-character');
      const r1 = await t.execute({ name: 'Echo', type: 'player' }, ctx());
      const r2 = await t.execute({ name: 'Echo', type: 'npc' }, ctx());
      expect((r1 as { characterId: string }).characterId).not.toBe(
        (r2 as { characterId: string }).characterId,
      );
      expect(store.characters).toHaveLength(2);
    });
  });

  describe('update-character', () => {
    it('merges fields into existing character and bumps version', async () => {
      // Seed a character first
      const create = findByName(tools, 'create-character');
      const created = await create.execute(
        { name: '苏婉', type: 'npc', fields: { hp: 100, status: 'alive' } },
        ctx(),
      );
      const charId = (created as { characterId: string }).characterId;

      const update = findByName(tools, 'update-character');
      const result = await update.execute(
        { id: charId, fields: { hp: 50, status: 'wounded', injuries: ['arm'] } },
        ctx(),
      );

      expect(result).toMatchObject({ success: true, characterId: charId, version: 2 });

      const char = store.characters.find((c) => c.id === charId)!;
      expect(char.fields).toEqual({
        hp: 50,
        status: 'wounded',
        injuries: ['arm'],
      });
      expect(char.version).toBe(2);
    });

    it('updates description when provided', async () => {
      const create = findByName(tools, 'create-character');
      const created = await create.execute(
        { name: '柳娘', type: 'npc', description: '药王谷谷主' },
        ctx(),
      );
      const charId = (created as { characterId: string }).characterId;

      const update = findByName(tools, 'update-character');
      await update.execute(
        { id: charId, description: '药王谷谷主，已故' },
        ctx(),
      );

      const char = store.characters.find((c) => c.id === charId)!;
      expect(char.description).toBe('药王谷谷主，已故');
    });

    it('re-mirrors updated character to plugin-data', async () => {
      const create = findByName(tools, 'create-character');
      const created = await create.execute({ name: 'X', type: 'npc' }, ctx());
      const charId = (created as { characterId: string }).characterId;

      const update = findByName(tools, 'update-character');
      await update.execute(
        { id: charId, fields: { hp: 20 } },
        ctx(),
      );

      // Latest mirror should reflect update
      const mirror = store.pluginData.find(
        (r) => r.namespace === 'characters' && r.key === charId,
      );
      expect(mirror).toBeDefined();
      expect((mirror!.value as { fields: { hp: number } }).fields.hp).toBe(20);
    });

    it('returns notFound when id does not exist', async () => {
      const update = findByName(tools, 'update-character');
      const result = await update.execute(
        { id: 'nonexistent', fields: { hp: 1 } },
        ctx(),
      );
      expect(result).toMatchObject({ success: false, notFound: true });
    });
  });

  describe('list-characters', () => {
    beforeEach(async () => {
      const create = findByName(tools, 'create-character');
      await create.execute({ name: '柳无痕', type: 'player' }, ctx());
      await create.execute({ name: '苏婉', type: 'npc' }, ctx());
      await create.execute({ name: '柳娘', type: 'npc' }, ctx());
    });

    it('lists all characters in the session regardless of type', async () => {
      const t = findByName(tools, 'list-characters');
      const result = await t.execute({}, ctx()) as { count: number; characters: unknown[] };
      expect(result.count).toBe(3);
      expect(result.characters).toHaveLength(3);
    });

    it('filters by type when provided', async () => {
      const t = findByName(tools, 'list-characters');
      const result = await t.execute(
        { type: 'npc' },
        ctx(),
      ) as { count: number; characters: Array<{ type: string }> };
      expect(result.count).toBe(2);
      expect(result.characters.every((c) => c.type === 'npc')).toBe(true);
    });

    it('returns characters created by other plugins (session-scoped)', async () => {
      // Another plugin writes a character under its own pluginId
      const create = findByName(tools, 'create-character');
      await create.execute(
        { name: 'Narrator Ghost', type: 'npc' },
        ctx('core-narrator'),
      );

      const t = findByName(tools, 'list-characters');
      const result = await t.execute({}, ctx('core-char-creator')) as {
        count: number;
      };
      expect(result.count).toBe(4);
    });
  });

  describe('get-character', () => {
    let charId: string;

    beforeEach(async () => {
      const create = findByName(tools, 'create-character');
      const created = await create.execute(
        { name: '柳无痕', type: 'player', fields: { hp: 100 } },
        ctx(),
      );
      charId = (created as { characterId: string }).characterId;
    });

    it('looks up by id', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ id: charId }, ctx()) as {
        found: boolean;
        character: { name: string };
      };
      expect(result.found).toBe(true);
      expect(result.character.name).toBe('柳无痕');
    });

    it('looks up by name', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ name: '柳无痕' }, ctx()) as {
        found: boolean;
        character: { type: string };
      };
      expect(result.found).toBe(true);
      expect(result.character.type).toBe('player');
    });

    it('returns found=false for missing character', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ id: 'nope' }, ctx()) as { found: boolean };
      expect(result.found).toBe(false);
    });

    it('requires either id or name', async () => {
      const t = findByName(tools, 'get-character');
      await expect(t.execute({}, ctx())).rejects.toThrow();
    });
  });
});
