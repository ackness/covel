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
import {
  characterLabel,
  characterNameKey,
  describeUnresolvedCharacter,
  findCharacterAliasConflict,
  mergeCharacterAliases,
  resolveCharacter,
} from "@covel/plugin-handlers-utils";
import type { ToolExecutionContext, ToolModule } from "../types.js";
import {
  getPendingProposals,
  getToolContent,
  withPendingProposals,
} from "../result.js";
import { overlayCharacters } from "../proposal-overlay.js";
import { validateFieldsAgainstSchema } from "../schema-validator.js";
import { wordId } from "../short-id.js";
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

/** Ids of the characters this execution holds buffered writes for. */
function bufferedCharacterIds(context: ToolExecutionContext): string[] {
  return [
    ...(context.upstreamProposals ?? []),
    ...(context.pendingProposals ?? []),
  ].flatMap((proposal) =>
    proposal.type === "character.upsert" &&
    proposal.sessionId === context.sessionId
      ? [proposal.payload.id]
      : [],
  );
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
  "Create a character. A name that an existing character of the same type has, or that is an alias of any character, is not created again: the existing character is returned. `fields` are merged with the world schema defaults; validation warnings are returned.";

const ALIASES_DESCRIPTION =
  "Other names the story uses for this same person: a nickname, a title, the name in another script. Optional";

/**
 * One name means one person: an alias that another character has as a name
 * or alias is refused, with the owner named so the model can write there.
 */
function assertAliasesFree(
  all: readonly CharacterRecord[],
  character: { id: string; name: string; aliases: readonly string[] },
): void {
  const conflict = findCharacterAliasConflict(all, character);
  if (conflict)
    throw new Error(
      `"${conflict.alias}" is already a name of ${characterLabel(conflict.owner)} [${conflict.owner.id}]. If ${character.name} is that person, update ${conflict.owner.id} and create nothing; if not, leave this alias out.`,
    );
}

function createCharacterParametersSchema(schema?: CharacterSchema) {
  return z.object({
    name: z.string().min(1).describe("Character name"),
    aliases: z
      .array(z.string().min(1))
      .optional()
      .describe(ALIASES_DESCRIPTION),
    type: characterTypeSchema(schema),
    description: z.string().optional().describe("Short description"),
    fields: buildFieldsZod(null)
      .optional()
      .describe("Optional attributes, keyed by world schema attribute id"),
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

      // Idempotent: a character that has this name and type, or any character
      // that has this name as an alias, already exists in this session —
      // committed OR buffered earlier in this loop — and is returned instead
      // of a duplicate. The same name with another type stays a new record.
      const existing = await mergeCharacterViews(store, context);
      const nameKey = characterNameKey(params.name);
      const match =
        existing.find(
          (c) => characterNameKey(c.name) === nameKey && c.type === params.type,
        ) ??
        existing.find((c) =>
          (c.aliases ?? []).some(
            (alias) => characterNameKey(alias) === nameKey,
          ),
        );
      if (match) {
        return {
          _text: `Character "${characterLabel(match)}" (${match.type}) already exists as ${match.id}. No new record created. Use update-character to modify it.`,
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

      // A word id from the name (`char-lin-yao`): models read character ids in
      // every roster and write them back, and a UUID is long and easy to
      // miscopy. Ids buffered in this execution are taken too: a batch of
      // creates does not show in `existing` until the loop records it.
      const id = wordId(
        "char",
        params.name,
        new Set([
          ...existing.map((character) => character.id),
          ...bufferedCharacterIds(context),
        ]),
      );
      const aliases = mergeCharacterAliases(params.name, [], params.aliases);
      assertAliasesFree(existing, { id, name: params.name, aliases });
      // Write buffers into a character.upsert proposal — the commit handler
      // persists the character inside the execution transaction.
      const proposal = makeCharacterUpsertProposal(
        context,
        {
          id,
          name: params.name,
          ...(aliases.length > 0 ? { aliases } : {}),
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
  "Update a character by id; its name or an alias also finds it. `description` is replaced, `fields` are shallow-merged, `aliases` are added, and `version` increases by 1. Send only what changed.";

function createUpdateCharacterParametersSchema() {
  return z.object({
    id: z
      .string()
      .min(1)
      .describe("Character id; the character's name or an alias also works"),
    aliases: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Names to add when the story reveals another name of this same person; omit otherwise",
      ),
    description: z
      .string()
      .optional()
      .describe("New description; omit to keep the current one"),
    fields: buildFieldsZod(null)
      .optional()
      .describe("Attribute patch, keyed by world schema attribute id"),
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
      // No partial match: a write must reach the person named, not the one
      // whose name happens to contain the same word.
      const resolution = resolveCharacter(all, params.id);
      if (resolution.status !== "found") {
        throw new Error(
          `${describeUnresolvedCharacter(params.id, resolution, all)} Nothing was updated.`,
        );
      }
      const existing = resolution.character;
      const addedAliases = mergeCharacterAliases(
        existing.name,
        existing.aliases,
        params.aliases,
      ).slice(existing.aliases?.length ?? 0);
      assertAliasesFree(all, {
        id: existing.id,
        name: existing.name,
        aliases: addedAliases,
      });

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
          ...(addedAliases.length > 0 ? { aliases: addedAliases } : {}),
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
      if (addedAliases.length > 0)
        changeLines.push(`  aliases: + ${addedAliases.join(", ")}`);
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
      const batchContext = (): ToolExecutionContext => ({
        ...context,
        pendingProposals: [...(context.pendingProposals ?? []), ...proposals],
        // The supplied world already represents the outer execution's writes.
        // Only replay this composite call's new writes over that snapshot.
        ...(context.world
          ? {
              world: {
                ...context.world,
                characters: [
                  ...overlayCharacters(
                    proposals,
                    context.world.characters,
                    context.sessionId,
                  ).values(),
                ],
              },
            }
          : {}),
      });

      for (const params of creates) {
        const rawResult = await createCharacter.execute(params, batchContext());
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
        const rawResult = await updateCharacter.execute(params, batchContext());
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

/**
 * Lines `list-characters` returns. The bundled worlds seed 10 to 16
 * characters; a long session adds the people it meets, and every call would
 * otherwise repeat all of them. Most-interacted characters come first, so the
 * ones cut are the least recently relevant.
 */
const MAX_LISTED_CHARACTERS = 50;

function createListCharactersTool(store: CharacterStore): ToolModule {
  return tool({
    name: "list-characters",
    description:
      "List the characters in this session (session scope, visible to all plugins; at the most 50, with a note when more exist). Sorted by version, highest first (a higher version means more interaction), then by latest update. Can filter by a type the world schema declares. Returns a compact text list, one line per character: id / name with its aliases / type / version / short description. Call get-character for full attributes.",
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
        .describe("Filter by type (optional)"),
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
      const shown = sorted.slice(0, MAX_LISTED_CHARACTERS);
      const hidden = sorted.length - shown.length;
      const lines = shown.map((c, idx) => {
        const desc = c.description ? ` — ${truncate(c.description, 80)}` : "";
        return `${idx + 1}. ${characterLabel(c)} [${c.type}] ${c.id} (v${c.version})${desc}`;
      });

      const more =
        hidden > 0
          ? [
              `… ${hidden} more not listed. Filter by type, or call get-character with a name to check for a specific one.`,
            ]
          : [];

      return {
        _text: [header, ...lines, ...more].join("\n"),
        count: sorted.length,
        characters: shown.map(toSnapshot),
      };
    },
  });
}

// ── get-character ────────────────────────────────────────────────

/** Names listed when nothing is close, as the miss text lists them. */
const MAX_NAMES_ON_MISS = 30;

function createGetCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: "get-character",
    description:
      "Get one character's full attributes by id, name or alias (all fields, description, version). Pass id or name. The name need not match exactly: a single character whose name or alias contains it, or that it contains, also matches. When nothing matches, the closest known names are returned, so list-characters is not needed.",
    parameters: z
      .object({
        id: z.string().optional().describe("Character id"),
        name: z
          .string()
          .optional()
          .describe(
            "Character name or alias; a part of it also works, for example without the title",
          ),
      })
      .refine((v) => Boolean(v.id || v.name), {
        message: "either id or name is required",
      }),
    execute: async (params, context) => {
      const all = await mergeCharacterViews(store, context);
      const query = (params.id || params.name)!;
      const resolution = resolveCharacter(all, query, { partial: true });
      if (resolution.status !== "found") {
        return {
          _text: describeUnresolvedCharacter(query, resolution, all),
          found: false,
          candidates: (resolution.status === "ambiguous"
            ? resolution.candidates
            : resolution.closest.length > 0
              ? resolution.closest
              : all.slice(0, MAX_NAMES_ON_MISS)
          ).map((c) => c.name),
        };
      }
      const match = resolution.character;

      const lines: string[] = [];
      lines.push(`Character: ${match.name} [${match.type}] ${match.id}`);
      if (match.aliases?.length)
        lines.push(`Also known as: ${match.aliases.join(", ")}`);
      if (match.description) {
        lines.push(`Description: ${match.description}`);
      }
      lines.push(`Version: ${match.version}`);
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
