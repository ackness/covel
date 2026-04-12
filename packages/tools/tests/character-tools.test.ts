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

    it('returns a human-readable _text summary (text-first convention)', async () => {
      const t = findByName(tools, 'create-character');
      const result = await t.execute(
        { name: '柳无痕', type: 'player', description: '外门弟子' },
        ctx(),
      ) as { _text: string; characterId: string };
      expect(typeof result._text).toBe('string');
      expect(result._text).toContain('柳无痕');
      expect(result._text).toContain('player');
      expect(result._text).toContain(result.characterId);
    });

    it('_text reflects existed=true path when duplicate', async () => {
      const t = findByName(tools, 'create-character');
      await t.execute({ name: '孙师叔', type: 'npc' }, ctx());
      const r2 = await t.execute({ name: '孙师叔', type: 'npc' }, ctx()) as { _text: string };
      expect(r2._text).toMatch(/already exists|已存在|existed/i);
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
      await create.execute({ name: '柳无痕', type: 'player', description: '外门弟子' }, ctx());
      await create.execute({ name: '苏婉', type: 'npc', description: '师姐' }, ctx());
      await create.execute({ name: '柳娘', type: 'npc', description: '药王谷谷主' }, ctx());
    });

    it('returns a text summary listing all session characters', async () => {
      const t = findByName(tools, 'list-characters');
      const result = await t.execute({}, ctx()) as { _text: string; count: number };
      expect(typeof result._text).toBe('string');
      expect(result.count).toBe(3);
      // All three names should appear
      expect(result._text).toContain('柳无痕');
      expect(result._text).toContain('苏婉');
      expect(result._text).toContain('柳娘');
      // Description appears for context
      expect(result._text).toContain('外门弟子');
      // Type labels appear
      expect(result._text).toContain('player');
      expect(result._text).toContain('npc');
    });

    it('filters by type when provided', async () => {
      const t = findByName(tools, 'list-characters');
      const result = await t.execute({ type: 'npc' }, ctx()) as { _text: string; count: number };
      expect(result.count).toBe(2);
      expect(result._text).toContain('苏婉');
      expect(result._text).toContain('柳娘');
      expect(result._text).not.toContain('柳无痕');
    });

    it('handles empty session with a clear empty message', async () => {
      const emptyStore = createMockStore();
      const emptyTools = createCharacterTools(emptyStore);
      const t = findByName(emptyTools, 'list-characters');
      const result = await t.execute({}, ctx()) as { _text: string; count: number };
      expect(result.count).toBe(0);
      expect(result._text.toLowerCase()).toMatch(/no character|empty|没有|暂无/);
    });

    it('sorts by frequency (version) desc, then updatedAt desc', async () => {
      // Update 苏婉 twice (version=3), update 柳娘 once (version=2).
      // 柳无痕 stays at version=1.
      // Expected order: 苏婉 (v3) → 柳娘 (v2) → 柳无痕 (v1)
      const update = findByName(tools, 'update-character');
      const get = findByName(tools, 'get-character');

      const suwan = (await get.execute({ name: '苏婉' }, ctx())) as { _text: string };
      const suwanId = /char-[a-f0-9-]+/.exec(suwan._text)?.[0];
      const liuniang = (await get.execute({ name: '柳娘' }, ctx())) as { _text: string };
      const liuniangId = /char-[a-f0-9-]+/.exec(liuniang._text)?.[0];

      expect(suwanId).toBeDefined();
      expect(liuniangId).toBeDefined();

      await update.execute({ id: suwanId!, fields: { hp: 90 } }, ctx());
      await update.execute({ id: suwanId!, fields: { hp: 80 } }, ctx());
      await update.execute({ id: liuniangId!, fields: { hp: 60 } }, ctx());

      const t = findByName(tools, 'list-characters');
      const list = (await t.execute({}, ctx())) as { _text: string };
      const suwanPos = list._text.indexOf('苏婉');
      const liuniangPos = list._text.indexOf('柳娘');
      const liuwuhenPos = list._text.indexOf('柳无痕');
      expect(suwanPos).toBeLessThan(liuniangPos);
      expect(liuniangPos).toBeLessThan(liuwuhenPos);
    });

    it('recency breaks frequency ties (same version → newer updatedAt first)', async () => {
      // Need explicit time separation so updatedAt actually differs.
      // The beforeEach creates all 3 in the same millisecond tick, so we
      // rebuild state here with delays between creates.
      const freshStore = createMockStore();
      const freshTools = createCharacterTools(freshStore);
      const create = findByName(freshTools, 'create-character');
      await create.execute({ name: '柳无痕', type: 'player' }, ctx());
      await new Promise((r) => setTimeout(r, 5));
      await create.execute({ name: '苏婉', type: 'npc' }, ctx());
      await new Promise((r) => setTimeout(r, 5));
      await create.execute({ name: '柳娘', type: 'npc' }, ctx());

      // All three are at version=1, so ordering falls to updatedAt desc.
      // Expected order: 柳娘 (newest) → 苏婉 → 柳无痕 (oldest)
      const t = findByName(freshTools, 'list-characters');
      const list = (await t.execute({}, ctx())) as { _text: string };
      const liuniangPos = list._text.indexOf('柳娘');
      const suwanPos = list._text.indexOf('苏婉');
      const liuwuhenPos = list._text.indexOf('柳无痕');
      expect(liuniangPos).toBeLessThan(suwanPos);
      expect(suwanPos).toBeLessThan(liuwuhenPos);
    });

    it('includes cross-plugin characters (session-scoped)', async () => {
      const create = findByName(tools, 'create-character');
      await create.execute(
        { name: 'NarratorGhost', type: 'npc' },
        ctx('core-narrator'),
      );

      const t = findByName(tools, 'list-characters');
      const result = await t.execute({}, ctx('core-char-creator')) as { _text: string; count: number };
      expect(result.count).toBe(4);
      expect(result._text).toContain('NarratorGhost');
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

    it('returns full character detail as text when found by id', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ id: charId }, ctx()) as {
        _text: string;
        found: boolean;
      };
      expect(result.found).toBe(true);
      expect(typeof result._text).toBe('string');
      expect(result._text).toContain('柳无痕');
      expect(result._text).toContain('player');
      expect(result._text).toContain(charId);
      // Fields appear as key: value in the text
      expect(result._text).toContain('hp');
      expect(result._text).toContain('100');
    });

    it('looks up by name and returns full detail', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ name: '柳无痕' }, ctx()) as {
        _text: string;
        found: boolean;
      };
      expect(result.found).toBe(true);
      expect(result._text).toContain('柳无痕');
      expect(result._text).toContain('player');
    });

    it('returns text saying not found when id is missing', async () => {
      const t = findByName(tools, 'get-character');
      const result = await t.execute({ id: 'nope' }, ctx()) as { _text: string; found: boolean };
      expect(result.found).toBe(false);
      expect(result._text.toLowerCase()).toMatch(/not found|未找到|不存在/);
    });

    it('requires either id or name', async () => {
      const t = findByName(tools, 'get-character');
      await expect(t.execute({}, ctx())).rejects.toThrow();
    });
  });

  describe('update-character _text output', () => {
    it('summarizes what changed in the returned _text', async () => {
      const create = findByName(tools, 'create-character');
      const created = await create.execute(
        { name: '赵铁山', type: 'npc', fields: { hp: 100, status: 'alive' } },
        ctx(),
      );
      const charId = (created as { characterId: string }).characterId;

      const update = findByName(tools, 'update-character');
      const result = await update.execute(
        { id: charId, fields: { hp: 50, status: 'wounded' }, description: 'updated desc' },
        ctx(),
      ) as { _text: string; version: number };

      expect(result.version).toBe(2);
      expect(typeof result._text).toBe('string');
      expect(result._text).toContain('赵铁山');
      // Shows the change summary
      expect(result._text).toMatch(/hp/);
      expect(result._text).toMatch(/status/);
    });

    it('returns a not-found text when id does not exist', async () => {
      const update = findByName(tools, 'update-character');
      const result = await update.execute(
        { id: 'missing', fields: { hp: 1 } },
        ctx(),
      ) as { _text: string; success: boolean; notFound?: boolean };
      expect(result.success).toBe(false);
      expect(result.notFound).toBe(true);
      expect(result._text.toLowerCase()).toMatch(/not found|未找到|不存在/);
    });
  });
});
