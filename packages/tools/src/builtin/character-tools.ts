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
 * Text-first output convention:
 *   All tools return an object with a `_text` string field that holds a
 *   compact, human-readable summary for the LLM. The framework's tool-executor
 *   sends only `_text` to the LLM as the tool-call result, while `parsedResult`
 *   retains the full structured object for trace/debug consumption. This keeps
 *   LLM prompts short and readable while framework-level code still gets all
 *   the metadata it needs.
 *
 * Scoping rules:
 *   - writes are attributed to the caller plugin via `context.pluginId`
 *   - reads (list / get) are **session-scoped**, not plugin-scoped, because
 *     characters are shared kernel data — a narrator plugin must be able to
 *     see NPCs created by a character tracker plugin.
 */

import { z, type ZodType } from 'zod';
import { tool } from '../tool.js';
import type { ToolModule } from '../types.js';
import type { CharacterAttributeSchema } from '@covel/shared';
import { validateFieldsAgainstSchema } from '../schema-validator.js';
import { buildFieldsZodFromSchema } from '../schema-to-zod.js';

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
  /**
   * Fetch a single plugin-data row. Used to load the character-attribute
   * schema for soft validation during create/update. Optional so existing
   * test stores that don't provide it gracefully skip validation.
   */
  getPluginData?(
    sessionId: string,
    pluginId: string,
    namespace: string,
    key: string,
  ): Promise<{ value: unknown; updatedAt: string } | null>;
  /** Optional — reserved for future use; create-character no longer calls this. */
  updateSession?(
    id: string,
    patch: {
      status?: 'active' | 'paused' | 'ended';
      turnCount?: number;
      preGameCompleted?: readonly string[];
      activePlugins?: readonly string[];
      updatedAt?: string;
    },
  ): Promise<void>;
}

/**
 * Factory-level dependencies. Kept as a separate bag so the ctor stays
 * positional and existing test call sites (which pass only a store) still
 * work — schema validation silently becomes a no-op when the plugin
 * resolver isn't provided.
 */
export interface CharacterToolDeps {
  /**
   * Resolve the active plugin package id that holds the character-attribute
   * schema for this session. Injected so `@covel/tools` stays free of a
   * runtime dependency on `@covel/plugin-loader` (same pattern as
   * `createWorldDimensionTools`). Return `undefined` to skip validation.
   */
  findWorldDataPluginId?(sessionId: string): string | undefined;
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

/**
 * Load the character-attribute schema for this session, if any. Returns
 * `null` when the store can't read plugin-data, no world-data plugin is
 * resolved, or the schema hasn't been written yet. Any error swallows to
 * `null` — validation is a best-effort UX hint, never a failure path.
 */
async function loadCharacterSchema(
  store: CharacterStore,
  deps: CharacterToolDeps,
  sessionId: string,
): Promise<CharacterAttributeSchema | null> {
  if (typeof store.getPluginData !== 'function') return null;
  const worldPluginId = deps.findWorldDataPluginId?.(sessionId);
  if (!worldPluginId) return null;
  try {
    const row = await store.getPluginData(
      sessionId,
      worldPluginId,
      'schema',
      'character-attributes',
    );
    if (!row) return null;
    const value = row.value;
    if (!value || typeof value !== 'object') return null;
    const shape = value as { version?: unknown; attributes?: unknown };
    if (!Array.isArray(shape.attributes)) return null;
    return value as CharacterAttributeSchema;
  } catch {
    return null;
  }
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

/**
 * Format an attribute record as a one-line "key: value" string. Arrays of
 * primitives are joined with ", " and objects are JSON-stringified compactly.
 */
function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const allPrimitive = value.every(
      (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean',
    );
    return allPrimitive ? `[${value.join(', ')}]` : JSON.stringify(value);
  }
  return JSON.stringify(value);
}

function formatFields(fields: unknown): string[] {
  if (!fields || typeof fields !== 'object') return [];
  return Object.entries(fields as Record<string, unknown>).map(
    ([k, v]) => `  ${k}: ${formatFieldValue(v)}`,
  );
}

/**
 * Truncate a long description to the first `maxLen` characters for compact
 * list output. Preserves the full description in the detailed `get-character`
 * response.
 */
function truncate(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Sort characters for list-characters output.
 *
 * Primary key: version descending (higher version = more updates =
 * higher involvement frequency — LLM plugins bump version each time they
 * interact with a character).
 *
 * Secondary key: updatedAt descending (more recent = closer to the current
 * turn). Ties in frequency are broken by recency so the most recently
 * touched character surfaces first within the same version band.
 */
function sortByFrequencyThenRecency<T extends { version: number; updatedAt: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort((a, b) => {
    if (b.version !== a.version) return b.version - a.version;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

// ── create-character ─────────────────────────────────────────────

/**
 * Build the `fields` Zod field for create/update-character parameters.
 * When `schema` is provided the fields are strongly typed per attribute id
 * (LLM sees named keys with correct types); otherwise falls back to a
 * permissive record so storytelling isn't blocked before schema-gen runs.
 */
function buildFieldsZod(schema: CharacterAttributeSchema | null): ZodType {
  const typed = schema ? buildFieldsZodFromSchema(schema) : null;
  return typed ?? z.record(z.string(), z.unknown());
}

const CREATE_DESCRIPTION =
  '创建一个新的角色记录（玩家、NPC 或同伴）。角色写入 characters 表并镜像到插件的 plugin-data 供侧边栏面板订阅。\n' +
  '\n' +
  '**fields 约束**（重要）：键名必须严格使用 `<world-schema>` 中声明的 `attributes[*].id`。未声明的键会被保存但会触发 schema warning——LLM 会在返回结果里看到警告并应在下一次调用时自行修正。\n' +
  '\n' +
  '**类型对齐**：number 类型的键必须写数字（不是字符串）、enum 键必须在 options 内、array/object/map 类型不要退化成裸字符串。如果世界观里出现了 schema 没覆盖的机制，优先扩展 schema（通过 set-world-schema）而不是把它塞进 fields 的无名键。\n' +
  '\n' +
  '同 session 内同 (name, type) 会自动去重——返回已存在的角色，不会创建重复项。';

function createCreateCharacterTool(
  store: CharacterStore,
  deps: CharacterToolDeps,
  schema: CharacterAttributeSchema | null = null,
): ToolModule {
  return tool({
    name: 'create-character',
    description: CREATE_DESCRIPTION,
    parameters: z.object({
      name: z.string().min(1).describe('角色名称（必须非空）'),
      type: characterTypeSchema,
      description: z.string().optional().describe('角色简短描述'),
      fields: buildFieldsZod(schema)
        .optional()
        .describe('角色属性键值对。键名必须是 world schema 中声明的 attribute id；未知键会触发 warning。'),
    }),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // Idempotent: if a character with the same (name, type) already exists in
      // this session, return it instead of creating a duplicate.
      const existing = await store.listCharacters(context.sessionId);
      const match = existing.find(
        (c) => c.name === params.name && c.type === params.type,
      );
      if (match) {
        return {
          _text: `Character "${match.name}" (${match.type}) already exists as ${match.id}. No new record created. Use update-character to modify it.`,
          success: true,
          existed: true,
          characterId: match.id,
          name: match.name,
          type: match.type,
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

      // Soft schema validation — runs AFTER the write so the LLM still gets
      // the character into state even when fields drift off-schema. Warnings
      // are appended to _text so the LLM sees them as tool feedback and can
      // self-correct on the next turn.
      const schema = await loadCharacterSchema(store, deps, context.sessionId);
      const { warningText } = validateFieldsAgainstSchema(params.fields, schema);

      const summary = params.description ? ` — ${truncate(params.description, 60)}` : '';
      const warning = warningText ? `\n\n${warningText}` : '';
      return {
        _text: `Created ${params.type} "${params.name}" as ${id}.${summary}${warning}`,
        success: true,
        existed: false,
        characterId: id,
        name: params.name,
        type: params.type,
      };
    },
  });
}

// ── update-character ─────────────────────────────────────────────

const UPDATE_DESCRIPTION =
  '更新已有角色的描述和/或属性字段。字段按 shallow merge 合并进现有 fields（新键覆盖旧键），version 自动 +1。适用于状态变化、装备变更、受伤、死亡标记等。必须先通过 list-characters 或 get-character 获取目标角色 id。\n' +
  '\n' +
  '**fields 约束**（重要）：键名必须严格使用 `<world-schema>` 中声明的 `attributes[*].id`。未声明的键会被保存但会触发 schema warning——看到警告请在下一次调用时改正或先扩展 schema（set-world-schema），不要继续写无名键。number 必须写数字、enum 必须在 options 内、array/object/map 类型保持结构。';

function createUpdateCharacterTool(
  store: CharacterStore,
  deps: CharacterToolDeps,
  schema: CharacterAttributeSchema | null = null,
): ToolModule {
  return tool({
    name: 'update-character',
    description: UPDATE_DESCRIPTION,
    parameters: z.object({
      id: z.string().min(1).describe('要更新的角色 id（由 create-character 或 list-characters 返回）'),
      description: z.string().optional().describe('新的描述（可选，未传则保留原值）'),
      fields: buildFieldsZod(schema)
        .optional()
        .describe('要合并的字段键值对（shallow merge）。键名必须是 world schema 中声明的 attribute id；未知键会触发 warning。'),
    }),
    execute: async (params, context) => {
      const all = await store.listCharacters(context.sessionId);
      const existing = all.find((c) => c.id === params.id);
      if (!existing) {
        return {
          _text: `Character ${params.id} not found in session. It may have been removed or the id is wrong.`,
          success: false,
          notFound: true,
          characterId: params.id,
        };
      }

      const now = new Date().toISOString();
      const prevFields = (existing.fields as Record<string, unknown> | undefined) ?? {};
      const mergedFields =
        params.fields !== undefined ? { ...prevFields, ...params.fields } : existing.fields;
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

      // Build a short human-readable diff summary.
      const changeLines: string[] = [];
      if (params.description !== undefined && params.description !== existing.description) {
        changeLines.push(`  description: updated`);
      }
      if (params.fields) {
        for (const [k, newVal] of Object.entries(params.fields)) {
          const oldVal = prevFields[k];
          if (oldVal === undefined) {
            changeLines.push(`  ${k}: (new) ${formatFieldValue(newVal)}`);
          } else if (formatFieldValue(oldVal) !== formatFieldValue(newVal)) {
            changeLines.push(`  ${k}: ${formatFieldValue(oldVal)} → ${formatFieldValue(newVal)}`);
          }
        }
      }
      const changeBlock = changeLines.length > 0 ? `\n${changeLines.join('\n')}` : '';

      // Soft schema validation over the merged fields — catches drift the
      // LLM introduced this turn as well as ones already in storage, so a
      // cleanup update can surface outstanding warnings too.
      const schema = await loadCharacterSchema(store, deps, context.sessionId);
      const { warningText } = validateFieldsAgainstSchema(mergedFields, schema);
      const warning = warningText ? `\n\n${warningText}` : '';

      return {
        _text: `Updated ${existing.type} "${existing.name}" (${existing.id}) → v${newVersion}.${changeBlock}${warning}`,
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
      '列出本 session 中的所有角色（session 作用域，跨插件可见）。输出按频率降序排序（version 越高表示被交互得越频繁），频率相同时按最近更新时间降序排序。可按 type 过滤：player / npc / companion。返回紧凑的文本列表——每个角色一行，包含 id / 名字 / 类型 / 版本 / 简短描述。需要完整属性时调用 get-character。',
    parameters: z.object({
      type: z.preprocess(
        (value) => {
          if (value == null) return undefined;
          if (typeof value !== 'string') return value;
          const normalized = value.trim().toLowerCase();
          if (normalized === '' || normalized === 'none' || normalized === 'null' || normalized === 'all') {
            return undefined;
          }
          return normalized;
        },
        characterTypeSchema.optional().nullable(),
      ).describe('按类型过滤（可选）'),
    }),
    execute: async (params, context) => {
      const all = await store.listCharacters(context.sessionId);
      const filtered = params.type != null ? all.filter((c) => c.type === params.type) : all;
      const sorted = sortByFrequencyThenRecency(filtered);

      if (sorted.length === 0) {
        const filterNote = params.type ? ` of type ${params.type}` : '';
        return {
          _text: `No characters${filterNote} in this session yet.`,
          count: 0,
          characters: [],
        };
      }

      const header = params.type
        ? `Characters in session (${sorted.length} ${params.type}, sorted by frequency then recency):`
        : `Characters in session (${sorted.length} total, sorted by frequency then recency):`;
      const lines = sorted.map((c, idx) => {
        const desc = c.description ? ` — ${truncate(c.description, 80)}` : '';
        return `${idx + 1}. ${c.name} [${c.type}] ${c.id} (v${c.version})${desc}`;
      });

      return {
        _text: [header, ...lines].join('\n'),
        count: sorted.length,
        characters: sorted.map(toSnapshot),
      };
    },
  });
}

// ── get-character ────────────────────────────────────────────────

function createGetCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: 'get-character',
    description:
      '按 id 或 name 查询单个角色的完整属性（包括所有 fields、description、version、时间戳）。必须传入 id 或 name 其中之一。返回多行文本详情——与 list-characters 的简洁列表形成对照，适合需要深入了解某个角色全部状态的场景。',
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
        const lookupKey = params.id ? `id=${params.id}` : `name=${params.name}`;
        return {
          _text: `Character not found (${lookupKey}).`,
          found: false,
        };
      }

      const lines: string[] = [];
      lines.push(`Character: ${match.name} [${match.type}] ${match.id}`);
      if (match.description) {
        lines.push(`Description: ${match.description}`);
      }
      lines.push(`Version: ${match.version}`);
      lines.push(`Created: ${match.createdAt}`);
      lines.push(`Updated: ${match.updatedAt}`);
      const fieldLines = formatFields(match.fields);
      if (fieldLines.length > 0) {
        lines.push('');
        lines.push('Attributes:');
        lines.push(...fieldLines);
      }

      return {
        _text: lines.join('\n'),
        found: true,
        character: toSnapshot(match),
      };
    },
  });
}

// ── Factory ──────────────────────────────────────────────────────

/**
 * Create the full set of builtin character tools bound to a DataStore instance.
 * Call this during bootstrap when the store is available.
 *
 * `deps.findWorldDataPluginId` is optional: when omitted (e.g. from tests),
 * the create/update tools skip soft schema validation but still function
 * normally. When present, write tools emit `_text` warnings about
 * off-schema keys and type mismatches so the LLM can self-correct.
 */
export function createCharacterTools(
  store: CharacterStore,
  deps: CharacterToolDeps = {},
): readonly ToolModule[] {
  return [
    createCreateCharacterTool(store, deps),
    createUpdateCharacterTool(store, deps),
    createListCharactersTool(store),
    createGetCharacterTool(store),
  ];
}

/**
 * Build session-specific variants of `create-character` / `update-character`
 * whose `fields` Zod is derived from the supplied schema — LLM sees named,
 * correctly-typed keys instead of the generic `Record<string, unknown>`.
 *
 * Read tools (`list-characters`, `get-character`) are schema-independent so
 * they're not rebuilt here; callers keep using the globally-registered
 * variants from `createCharacterTools`.
 */
export function buildSessionCharacterWriteTools(
  store: CharacterStore,
  deps: CharacterToolDeps,
  schema: CharacterAttributeSchema,
): readonly ToolModule[] {
  return [
    createCreateCharacterTool(store, deps, schema),
    createUpdateCharacterTool(store, deps, schema),
  ];
}
