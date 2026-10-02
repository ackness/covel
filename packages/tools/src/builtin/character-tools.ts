/**
 * Built-in character management tools.
 *
 * These tools are the canonical way for plugin LLM agents to create and update
 * characters (players, NPCs, companions) in the current session. They return
 * buffered character proposals; the commit handler writes the character table
 * and publishes World Model changes to the session.
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

import type {
  CharacterSchema,
  CharacterRecord,
  CharacterUpsertPayload,
  Proposal,
} from "@covel/shared";
import { z } from "zod";
import { tool } from "../tool.js";
import type { ToolExecutionContext, ToolModule } from "../types.js";
import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "../result.js";
import { overlayCharacters } from "../proposal-overlay.js";
import { validateFieldsAgainstSchema } from "../schema-validator.js";
import {
  buildFieldsZod,
  assertCharacterFields,
  characterTypeSchema,
  characterFieldsHint,
  formatFields,
  formatFieldValue,
  loadCharacterSchema,
  mergeSchemaDefaults,
  sortByFrequencyThenRecency,
  toSnapshot,
  truncate,
  type CharacterStore,
} from "./character-tool-helpers.js";

export { mergeSchemaDefaults } from "./character-tool-helpers.js";
export type {
  CharacterSnapshot,
  CharacterStore,
} from "./character-tool-helpers.js";

// ── Buffered write plumbing ──────────────────────────────────────

/**
 * Session characters as seen by THIS execution: committed rows overlaid with
 * `character.upsert` proposals buffered earlier in the same tool loop. Writes
 * commit only at turn end, so without this a create→list→create dedup, or an
 * update reading its own prior create, would miss the buffered state.
 *
 * Buffered entries win (they are the newer write) and stamp `updatedAt = now`
 * so recency sorting keeps them ahead of committed rows.
 */
async function mergeCharacterViews(
  store: CharacterStore,
  context: ToolExecutionContext,
): Promise<CharacterRecord[]> {
  if (context.world) return structuredClone([...context.world.characters]);
  const stored = await store.listCharacters(context.sessionId);
  return [
    ...overlayCharacters(
      [
        ...(context.upstreamProposals ?? []),
        ...(context.pendingProposals ?? []),
      ],
      stored,
      context.sessionId,
    ).values(),
  ];
}

/** Build a session-scoped character proposal. */
function makeCharacterUpsertProposal(
  context: ToolExecutionContext,
  payload: CharacterUpsertPayload,
  timestamp: string,
): Proposal {
  return {
    id: crypto.randomUUID(),
    type: "character.upsert",
    source: { pluginId: context.pluginId, runtimeId: context.runtimeId },
    turnId: context.turnId,
    sessionId: context.sessionId,
    payload,
    timestamp,
  };
}

// ── create-character ─────────────────────────────────────────────

const CREATE_DESCRIPTION =
  "创建角色；同 session 的同名同类型会去重。fields 按世界 schema 合并默认值并返回校验 warning。";

function createCharacterParametersSchema(schema?: CharacterSchema) {
  return z.object({
    name: z.string().min(1).describe("角色名"),
    type: characterTypeSchema(schema),
    description: z.string().optional().describe("简短描述"),
    fields: buildFieldsZod(null)
      .optional()
      .describe("可选属性；使用 world schema attribute id"),
  });
}

function createCreateCharacterTool(
  store: CharacterStore,
  schema?: CharacterSchema,
): ToolModule {
  return tool({
    name: "create-character",
    description: CREATE_DESCRIPTION + characterFieldsHint(schema),
    parameters: createCharacterParametersSchema(schema),
    execute: async (params, context) => {
      const now = new Date().toISOString();

      // Idempotent: if a character with the same (name, type) already exists in
      // this session — committed OR buffered earlier in this loop — return it
      // instead of creating a duplicate.
      const existing = await mergeCharacterViews(store, context);
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

      // Load the schema BEFORE the write so we can persist declared defaults
      // into the stored fields — keeping the panel (which overlays defaults at
      // render time) in sync with what the model later reads via get-character
      // and prompt context. A null schema leaves fields untouched.
      const schema = await loadCharacterSchema(store, context.sessionId, [
        ...(context.upstreamProposals ?? []),
        ...(context.pendingProposals ?? []),
      ]);
      const allowedTypes = new Set([
        "player",
        ...(schema?.types ?? ["npc", "companion"]),
      ]);
      if (!allowedTypes.has(params.type))
        throw new Error(`Unknown character type: ${params.type}`);
      if (
        params.type === "player" &&
        existing.some((character) => character.type === "player")
      ) {
        throw new Error("A session may have at most one player character");
      }
      const fields = mergeSchemaDefaults(params.fields, schema);

      const id = `char-${crypto.randomUUID()}`;
      // Write buffers into a character.upsert proposal — the commit handler
      // persists the character inside the execution transaction.
      const proposal = makeCharacterUpsertProposal(
        context,
        {
          id,
          name: params.name,
          type: params.type,
          ...(params.description !== undefined
            ? { description: params.description }
            : {}),
          fields,
          version: 1,
          createdAt: now,
        },
        now,
      );

      // Soft schema validation on the stored (default-merged) fields — surfaces
      // any off-schema keys as _text warnings the LLM can self-correct next turn.
      const { warningText } = validateFieldsAgainstSchema(fields, schema);

      const summary = params.description
        ? ` — ${truncate(params.description, 60)}`
        : "";
      const warning = warningText ? `\n\n${warningText}` : "";
      return withPendingProposals(
        {
          _text: `Created ${params.type} "${params.name}" as ${id}.${summary}${warning}`,
          success: true,
          existed: false,
          characterId: id,
          name: params.name,
          type: params.type,
        },
        [proposal],
      );
    },
  });
}

// ── update-character ─────────────────────────────────────────────

const UPDATE_DESCRIPTION =
  "按 id 更新角色；description 替换，fields shallow merge，version 自动 +1。只传明确变化。";

function createUpdateCharacterParametersSchema() {
  return z.object({
    id: z.string().min(1).describe("角色 id"),
    description: z.string().optional().describe("新描述；省略则保留"),
    fields: buildFieldsZod(null)
      .optional()
      .describe("属性 patch；使用 world schema attribute id"),
  });
}

function createUpdateCharacterTool(
  store: CharacterStore,
  schema?: CharacterSchema,
): ToolModule {
  return tool({
    name: "update-character",
    description: UPDATE_DESCRIPTION + characterFieldsHint(schema),
    parameters: createUpdateCharacterParametersSchema(),
    execute: async (params, context) => {
      const all = await mergeCharacterViews(store, context);
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
      const prevFields =
        (existing.fields as Record<string, unknown> | undefined) ?? {};
      const mergedFields =
        params.fields !== undefined
          ? { ...prevFields, ...params.fields }
          : existing.fields;
      const newVersion = existing.version + 1;
      const schema = await loadCharacterSchema(store, context.sessionId, [
        ...(context.upstreamProposals ?? []),
        ...(context.pendingProposals ?? []),
      ]);
      // Validate the supplied patch, so correcting one legacy field does not
      // require rewriting unrelated attributes that were already malformed.
      if (params.fields !== undefined)
        assertCharacterFields(params.fields, schema);

      // Buffer the upsert as a proposal (commit handler does the write +
      // record). `existing` may itself be a buffered create from earlier in
      // this loop, so the merged view above is what makes chained
      // create→update land the right base state.
      const proposal = makeCharacterUpsertProposal(
        context,
        {
          id: existing.id,
          name: existing.name,
          type: existing.type,
          ...(params.description !== undefined
            ? { description: params.description }
            : {}),
          ...(params.fields !== undefined ? { fields: params.fields } : {}),
          version: newVersion,
          expectedVersion: existing.version,
          createdAt: existing.createdAt,
        },
        now,
      );

      // Build a short human-readable diff summary.
      const changeLines: string[] = [];
      if (
        params.description !== undefined &&
        params.description !== existing.description
      ) {
        changeLines.push(`  description: updated`);
      }
      if (params.fields) {
        for (const [k, newVal] of Object.entries(params.fields)) {
          const oldVal = prevFields[k];
          if (oldVal === undefined) {
            changeLines.push(`  ${k}: (new) ${formatFieldValue(newVal)}`);
          } else if (formatFieldValue(oldVal) !== formatFieldValue(newVal)) {
            changeLines.push(
              `  ${k}: ${formatFieldValue(oldVal)} → ${formatFieldValue(newVal)}`,
            );
          }
        }
      }
      const changeBlock =
        changeLines.length > 0 ? `\n${changeLines.join("\n")}` : "";

      // Soft schema validation over the merged fields — catches drift the
      // LLM introduced this turn as well as ones already in storage, so a
      // cleanup update can surface outstanding warnings too.
      const { warningText } = validateFieldsAgainstSchema(mergedFields, schema);
      const warning = warningText ? `\n\n${warningText}` : "";

      return withPendingProposals(
        {
          _text: `Updated ${existing.type} "${existing.name}" (${existing.id}) → v${newVersion}.${changeBlock}${warning}`,
          success: true,
          characterId: existing.id,
          version: newVersion,
        },
        [proposal],
      );
    },
  });
}

// ── sync-characters ─────────────────────────────────────────────

interface CharacterWriteOutput {
  readonly success?: boolean;
  readonly existed?: boolean;
  readonly characterId?: string;
  readonly name?: string;
  readonly type?: string;
  readonly version?: number;
  readonly _text?: string;
}

function createSyncCharactersTool(
  store: CharacterStore,
  schema?: CharacterSchema,
): ToolModule {
  const createCharacter = createCreateCharacterTool(store, schema);
  const updateCharacter = createUpdateCharacterTool(store, schema);

  return tool({
    name: "sync-characters",
    description:
      "Atomically submit every explicit character change from this narrative turn. Put new named NPCs in creates and patches for existing character ids in updates. Duplicate creates are returned as unchanged and never overwrite existing profiles; put changes in updates. Correct and resubmit the full batch after a failure. When nothing changed, submit empty arrays to settle the turn." +
      characterFieldsHint(schema),
    parameters: z.object({
      creates: z
        .array(createCharacterParametersSchema(schema))
        .max(5)
        .default([])
        .describe("Up to 5 named, plot-relevant new NPCs."),
      updates: z
        .array(createUpdateCharacterParametersSchema())
        .max(10)
        .default([])
        .describe("Explicit patches for existing character ids."),
    }),
    execute: async ({ creates, updates }, context) => {
      // An empty batch is the explicit "no character changed" settlement, the
      // same shape a bookkeeping runtime uses when it must call a tool.
      if (creates.length + updates.length === 0) {
        return {
          _text: "No character changes this turn.",
          success: true,
          created: [],
          updated: [],
          unchanged: [],
        };
      }
      const proposals: Proposal[] = [];
      const created: Array<Record<string, unknown>> = [];
      const updated: Array<Record<string, unknown>> = [];
      const unchanged: Array<Record<string, unknown>> = [];

      for (const params of creates) {
        const rawResult = await createCharacter.execute(params, {
          ...context,
          pendingProposals: [...(context.pendingProposals ?? []), ...proposals],
        });
        const result = getToolContent(rawResult) as CharacterWriteOutput;
        if (result.success !== true) {
          throw new Error(
            result._text ?? `Character ${params.name} could not be created`,
          );
        }
        if (result.existed === true) {
          unchanged.push({
            characterId: result.characterId,
            name: result.name,
            type: result.type,
          });
          continue;
        }
        proposals.push(...getPendingProposals(rawResult));
        created.push({
          characterId: result.characterId,
          name: result.name,
          type: result.type,
        });
      }

      for (const params of updates) {
        const rawResult = await updateCharacter.execute(params, {
          ...context,
          pendingProposals: [...(context.pendingProposals ?? []), ...proposals],
        });
        const result = getToolContent(rawResult) as CharacterWriteOutput;
        if (result.success !== true) {
          throw new Error(
            result._text ?? `Character ${params.id} could not be updated`,
          );
        }
        proposals.push(...getPendingProposals(rawResult));
        updated.push({
          characterId: result.characterId,
          version: result.version,
        });
      }

      return withPendingProposals(
        {
          _text: `Synchronized ${created.length} new and ${updated.length} existing characters.${unchanged.length ? ` Duplicate creates left unchanged: ${JSON.stringify(unchanged)}. Put explicit field changes in updates using these ids.` : ""}`,
          success: true,
          created,
          updated,
          unchanged,
        },
        proposals,
      );
    },
  });
}

// ── list-characters ──────────────────────────────────────────────

function createListCharactersTool(store: CharacterStore): ToolModule {
  return tool({
    name: "list-characters",
    description:
      "列出本 session 中的所有角色（session 作用域，跨插件可见）。输出按频率降序排序（version 越高表示被交互得越频繁），频率相同时按最近更新时间降序排序。可按世界 schema 声明的 type 过滤。返回紧凑的文本列表——每个角色一行，包含 id / 名字 / 类型 / 版本 / 简短描述。需要完整属性时调用 get-character。",
    parameters: z.object({
      type: z
        .preprocess((value) => {
          if (value == null) return undefined;
          if (typeof value !== "string") return value;
          const normalized = value.trim().toLowerCase();
          if (
            normalized === "" ||
            normalized === "none" ||
            normalized === "null" ||
            normalized === "all"
          ) {
            return undefined;
          }
          return normalized;
        }, z.string().min(1).optional().nullable())
        .describe("按类型过滤（可选）"),
    }),
    execute: async (params, context) => {
      const all = await mergeCharacterViews(store, context);
      const filtered =
        params.type != null ? all.filter((c) => c.type === params.type) : all;
      const sorted = sortByFrequencyThenRecency(filtered);

      if (sorted.length === 0) {
        const filterNote = params.type ? ` of type ${params.type}` : "";
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
        const desc = c.description ? ` — ${truncate(c.description, 80)}` : "";
        return `${idx + 1}. ${c.name} [${c.type}] ${c.id} (v${c.version})${desc}`;
      });

      return {
        _text: [header, ...lines].join("\n"),
        count: sorted.length,
        characters: sorted.map(toSnapshot),
      };
    },
  });
}

// ── get-character ────────────────────────────────────────────────

const MAX_NAMES_ON_MISS = 30;

/**
 * Resolve a name the way a model writes it: exact, then case-insensitive,
 * then the one character whose name contains the query or is contained in
 * it ("Mina Park" finds "Dr. Mina Park"). Several partial matches come back
 * as candidates, so a miss does not cost a `list-characters` round trip.
 */
function findCharacterByName<C extends { name: string }>(
  all: readonly C[],
  name: string,
): { match?: C; candidates: readonly C[] } {
  const exact = all.find((c) => c.name === name);
  if (exact) return { match: exact, candidates: [] };
  const query = name.trim().toLowerCase();
  const same = all.filter((c) => c.name.toLowerCase() === query);
  if (same.length === 1) return { match: same[0], candidates: [] };
  const partial = all.filter((c) => {
    const candidate = c.name.toLowerCase();
    return candidate.includes(query) || query.includes(candidate);
  });
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  return { candidates: same.length > 1 ? same : partial };
}

function createGetCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: "get-character",
    description:
      "按 id 或 name 查询单个角色的完整属性（包括所有 fields、description、version、时间戳）。必须传入 id 或 name 其中之一；name 不必完全一致，唯一包含或被包含的名字也算命中。找不到时返回候选名字，无需再调用 list-characters。",
    parameters: z
      .object({
        id: z.string().optional().describe("角色 id"),
        name: z
          .string()
          .optional()
          .describe("角色名称；也可写名字的一部分，如省略头衔"),
      })
      .refine((v) => Boolean(v.id || v.name), {
        message: "either id or name is required",
      }),
    execute: async (params, context) => {
      const all = await mergeCharacterViews(store, context);
      const { match, candidates } = params.id
        ? { match: all.find((c) => c.id === params.id), candidates: [] }
        : findCharacterByName(all, params.name!);
      if (!match) {
        const lookupKey = params.id ? `id=${params.id}` : `name=${params.name}`;
        const names = (candidates.length > 0 ? candidates : all)
          .slice(0, MAX_NAMES_ON_MISS)
          .map((c) => c.name);
        return {
          _text: [
            `Character not found (${lookupKey}).`,
            ...(names.length > 0
              ? [
                  `${candidates.length > 0 ? "Did you mean" : "Characters in session"}: ${names.join(", ")}`,
                ]
              : []),
          ].join("\n"),
          found: false,
          candidates: names,
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
        lines.push("");
        lines.push("Attributes:");
        lines.push(...fieldLines);
      }

      return {
        _text: lines.join("\n"),
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
 * Schema validation uses the authoritative session World Model.
 */
export function createCharacterTools(
  store: CharacterStore,
): readonly ToolModule[] {
  return [
    tool({
      name: "get-character-schema",
      description: "Read the current session's authoritative character schema.",
      parameters: z.object({}),
      execute: async (_params, context) => {
        const schema = await loadCharacterSchema(store, context.sessionId, [
          ...(context.upstreamProposals ?? []),
          ...(context.pendingProposals ?? []),
        ]);
        return {
          _text: schema
            ? JSON.stringify(schema)
            : "No character schema is available.",
          schema,
        };
      },
    }),
    createCreateCharacterTool(store),
    createUpdateCharacterTool(store),
    createSyncCharactersTool(store),
    createListCharactersTool(store),
    createGetCharacterTool(store),
  ];
}

/**
 * Build session write-tool variants. The LLM-facing `fields` schema stays a
 * compact generic object; each tool advertises structural field constraints
 * once in its description. World prose/defaults are not repeated in the create
 * and update arrays. Execution reloads the authoritative session schema for
 * defaults and validation, including changes made after tool preparation.
 *
 * Read tools (`list-characters`, `get-character`) are schema-independent so
 * they're not rebuilt here; callers keep using the globally-registered
 * variants from `createCharacterTools`.
 */
export function buildSessionCharacterWriteTools(
  store: CharacterStore,
  schema: CharacterSchema,
): readonly ToolModule[] {
  return [
    createCreateCharacterTool(store, schema),
    createUpdateCharacterTool(store, schema),
    createSyncCharactersTool(store, schema),
  ];
}
