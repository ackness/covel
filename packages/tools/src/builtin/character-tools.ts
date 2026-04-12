/**
 * Built-in character management tools.
 *
 * These tools are the canonical way for plugin LLM agents to create and update
 * characters (players, NPCs, companions) in the current session. They write
 * directly to the `characters` table via the injected DataStore and mirror each
 * write to `plugin_data[pluginId][namespace="characters"][key=charId]` so that
 * right-panel specs subscribing to plugin data receive live updates through the
 * existing SSE `plugin-data.changed` channel.
 *
 * Scoping rules:
 *   - writes are attributed to the caller plugin via `context.pluginId`
 *   - reads (list / get) are **session-scoped**, not plugin-scoped, because
 *     characters are shared kernel data — a narrator plugin must be able to
 *     see NPCs created by a character tracker plugin.
 */

import { z } from 'zod';
import { tool } from '../tool.js';
import type { ToolModule } from '../types.js';

// ── Store contract ───────────────────────────────────────────────

/**
 * Minimal store interface needed by the character tools. Kept local to avoid
 * a runtime dependency on `@covel/store` from this package.
 */
export interface CharacterStore {
  upsertCharacter(record: {
    id: string;
    sessionId: string;
    name: string;
    type: string;
    description?: string;
    fields?: unknown;
    version: number;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  listCharacters(sessionId: string): Promise<ReadonlyArray<{
    id: string;
    sessionId: string;
    name: string;
    type: string;
    description?: string;
    fields?: unknown;
    version: number;
    createdAt: string;
    updatedAt: string;
  }>>;
  setPluginData(record: {
    id: string;
    sessionId: string;
    pluginId: string;
    namespace: string;
    key: string;
    value: unknown;
    createdAt: string;
    updatedAt: string;
  }): Promise<void>;
  /** Optional — used by create-character to transition session phase (e.g. character_creation → playing). */
  updateSession?(
    id: string,
    patch: { phase?: string; turnCount?: number; activePlugins?: readonly string[]; updatedAt?: string },
  ): Promise<void>;
}

const CHARACTER_NAMESPACE = 'characters';

const characterTypeSchema = z
  .enum(['player', 'npc', 'companion'])
  .describe('角色类型：player=玩家，npc=NPC，companion=同伴');

// ── Helpers ──────────────────────────────────────────────────────

interface CharacterSnapshot {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly fields?: unknown;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function toSnapshot(record: {
  id: string;
  name: string;
  type: string;
  description?: string;
  fields?: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}): CharacterSnapshot {
  return {
    id: record.id,
    name: record.name,
    type: record.type,
    description: record.description,
    fields: record.fields,
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function mirrorToPluginData(
  store: CharacterStore,
  sessionId: string,
  pluginId: string,
  character: CharacterSnapshot,
): Promise<void> {
  const now = new Date().toISOString();
  await store.setPluginData({
    id: `char-mirror-${character.id}`,
    sessionId,
    pluginId,
    namespace: CHARACTER_NAMESPACE,
    key: character.id,
    value: character,
    createdAt: now,
    updatedAt: now,
  });
}

// ── create-character ─────────────────────────────────────────────

function createCreateCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: 'create-character',
    description:
      '创建一个新的角色记录（玩家、NPC 或同伴）。角色写入 characters 表并镜像到插件的 plugin-data 供侧边栏面板订阅。fields 应按世界 schema 中定义的角色属性填充（如 hp, level, lingGen 等）。',
    parameters: z.object({
      name: z.string().min(1).describe('角色名称（必须非空）'),
      type: characterTypeSchema,
      description: z.string().optional().describe('角色简短描述'),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('角色属性键值对，应符合世界 schema 中的 character-attributes 定义'),
      transitionPhase: z
        .string()
        .optional()
        .describe(
          '仅对 type=player 有效：创建玩家角色后将 session 转入此 phase（通常 "playing"）。玩家创建专用，NPC 忽略。',
        ),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // Idempotent: if a character with the same (name, type) already exists in
      // this session, return it instead of creating a duplicate. This guards
      // against LLMs re-calling create-character for the same NPC across turns
      // when they forget to check list-characters first.
      const existing = await store.listCharacters(context.sessionId);
      const match = existing.find(
        (c) => c.name === params.name && c.type === params.type,
      );
      if (match) {
        return {
          success: true,
          existed: true,
          characterId: match.id,
          name: match.name,
          type: match.type,
          phaseTransitioned: false,
        };
      }

      const id = `char-${crypto.randomUUID()}`;
      await store.upsertCharacter({
        id,
        sessionId: context.sessionId,
        name: params.name,
        type: params.type,
        description: params.description,
        fields: params.fields,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });

      const snapshot: CharacterSnapshot = {
        id,
        name: params.name,
        type: params.type,
        description: params.description,
        fields: params.fields,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      await mirrorToPluginData(store, context.sessionId, context.pluginId, snapshot);

      // Phase transition is only valid when creating a player character.
      // This lets the player-init runtime atomically finish character creation
      // and move the session to the playing phase in one tool call.
      let phaseTransitioned = false;
      if (params.type === 'player' && params.transitionPhase && store.updateSession) {
        await store.updateSession(context.sessionId, {
          phase: params.transitionPhase,
          updatedAt: now,
        });
        phaseTransitioned = true;
      }

      return {
        success: true,
        existed: false,
        characterId: id,
        name: params.name,
        type: params.type,
        phaseTransitioned,
      };
    },
  });
}

// ── update-character ─────────────────────────────────────────────

function createUpdateCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: 'update-character',
    description:
      '更新已有角色的描述和/或属性字段。字段按 shallow merge 合并进现有 fields（新键覆盖旧键），version 自动 +1。适用于状态变化、装备变更、受伤、死亡标记等。',
    parameters: z.object({
      id: z.string().min(1).describe('要更新的角色 id（由 create-character 返回）'),
      description: z.string().optional().describe('新的描述（可选，未传则保留原值）'),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('要合并的字段键值对（shallow merge）'),
    }),
    execute: async (params, context) => {
      const all = await store.listCharacters(context.sessionId);
      const existing = all.find((c) => c.id === params.id);
      if (!existing) {
        return { success: false, notFound: true, characterId: params.id };
      }

      const now = new Date().toISOString();
      const mergedFields =
        params.fields !== undefined
          ? { ...(existing.fields as Record<string, unknown> | undefined), ...params.fields }
          : existing.fields;
      const newVersion = existing.version + 1;

      await store.upsertCharacter({
        id: existing.id,
        sessionId: existing.sessionId,
        name: existing.name,
        type: existing.type,
        description: params.description ?? existing.description,
        fields: mergedFields,
        version: newVersion,
        createdAt: existing.createdAt,
        updatedAt: now,
      });

      const snapshot: CharacterSnapshot = {
        id: existing.id,
        name: existing.name,
        type: existing.type,
        description: params.description ?? existing.description,
        fields: mergedFields,
        version: newVersion,
        createdAt: existing.createdAt,
        updatedAt: now,
      };
      await mirrorToPluginData(store, context.sessionId, context.pluginId, snapshot);

      return {
        success: true,
        characterId: existing.id,
        version: newVersion,
      };
    },
  });
}

// ── list-characters ──────────────────────────────────────────────

function createListCharactersTool(store: CharacterStore): ToolModule {
  return tool({
    name: 'list-characters',
    description:
      '列出本 session 中的所有角色（session 作用域，跨插件可见）。可按 type 过滤：player / npc / companion。',
    parameters: z.object({
      type: characterTypeSchema.optional().describe('按类型过滤（可选）'),
    }),
    execute: async (params, context) => {
      const all = await store.listCharacters(context.sessionId);
      const filtered = params.type
        ? all.filter((c) => c.type === params.type)
        : all;
      return {
        count: filtered.length,
        characters: filtered.map(toSnapshot),
      };
    },
  });
}

// ── get-character ────────────────────────────────────────────────

function createGetCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: 'get-character',
    description: '按 id 或 name 查找单个角色。必须传入 id 或 name 其中之一。',
    parameters: z
      .object({
        id: z.string().optional().describe('角色 id'),
        name: z.string().optional().describe('角色名称（精确匹配）'),
      })
      .refine((v) => Boolean(v.id || v.name), {
        message: 'either id or name is required',
      }),
    execute: async (params, context) => {
      const all = await store.listCharacters(context.sessionId);
      const match = all.find((c) =>
        params.id ? c.id === params.id : c.name === params.name,
      );
      if (!match) {
        return { found: false };
      }
      return { found: true, character: toSnapshot(match) };
    },
  });
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create the full set of builtin character tools bound to a DataStore instance.
 * Call this during bootstrap when the store is available.
 */
export function createCharacterTools(store: CharacterStore): readonly ToolModule[] {
  return [
    createCreateCharacterTool(store),
    createUpdateCharacterTool(store),
    createListCharactersTool(store),
    createGetCharacterTool(store),
  ];
}
