/**
 * Built-in character management tools.
 *
 * These tools are the canonical way for plugin LLM agents to create and update
 * characters (players, NPCs, companions) in the current session. They return
 * buffered character proposals; the commit handler writes the character table
 * and publishes World Model changes to the session.
 *
 * Explicit model views keep summaries compact while code reads the full content.
 *
 * Scoping rules:
 *   - writes are attributed to the caller plugin via `context.pluginId`
 *   - reads (list / get) are **session-scoped**, not plugin-scoped, because
 *     characters are shared kernel data — a narrator plugin must be able to
 *     see NPCs created by a character tracker plugin.
 */

import {
  assertCharacterFields,
  CharacterFieldValidationError,
  isToolError,
  getModelView,
  mergeSchemaDefaults,
} from "@covel/plugin-handlers-utils";
import type {
  CharacterSchema,
  CharacterRecord,
  CharacterUpsertPayload,
  Proposal,
} from "@covel/shared";
import { z } from "zod";
import { withModelView, ToolError, tool } from "@covel/plugin-handlers-utils";
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
import { wordId } from "@covel/plugin-handlers-utils";
import {
  buildFieldsZod,
  characterTypeSchema,
  characterFieldsHint,
  formatFields,
  formatFieldValue,
  loadCharacterSchema,
  sortByFrequencyThenRecency,
  toSnapshot,
  truncate,
  type CharacterStore,
} from "./character-tool-helpers.js";

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
  // The view's records are frozen and already carry this execution's
  // buffered writes; the callers only read them.
  if (context.world) return [...context.world.characters];
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

// ── Character creation ─────────────────────────────────────────────

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
    throw new ToolError(
      "invalid-input",
      `"${conflict.alias}" is already a name of ${characterLabel(conflict.owner)} [${conflict.owner.id}]. If ${character.name} is that person, update ${conflict.owner.id} and create nothing. If the alias is wrong for ${conflict.owner.name}, remove it there first: update ${conflict.owner.id} with removeAliases. Otherwise leave this alias out.`,
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

async function createCharacter(
  store: CharacterStore,
  params: z.infer<ReturnType<typeof createCharacterParametersSchema>>,
  context: ToolExecutionContext,
) {
  const now = new Date().toISOString();

  // Idempotent: a character that has this name and type, or any character
  // that has this name as an alias, already exists in this session —
  // committed OR buffered earlier in this loop — and is returned instead
  // of a duplicate. The same name with another type stays a new record.
  const existing = await mergeCharacterViews(store, context);
  const nameKey = characterNameKey(params.name);
  // A player character is never an existing character of the world under
  // another type: a second record with its name makes the name ambiguous.
  if (params.type === "player") {
    const owner = existing.find(
      (c) =>
        c.type !== "player" &&
        [c.name, ...(c.aliases ?? [])].some(
          (name) => characterNameKey(name) === nameKey,
        ),
    );
    if (owner)
      throw new ToolError(
        "invalid-input",
        `"${params.name}" is a name of ${characterLabel(owner)} [${owner.id}] (${owner.type}), a character of this world. The player character needs a name no other character has: ask the player for a different name and create nothing until they give one.`,
      );
  }
  const match =
    existing.find(
      (c) => characterNameKey(c.name) === nameKey && c.type === params.type,
    ) ??
    existing.find((c) =>
      (c.aliases ?? []).some((alias) => characterNameKey(alias) === nameKey),
    );
  if (match) {
    return withModelView(
      {
        existed: true,
        characterId: match.id,
        name: match.name,
        type: match.type,
      },
      {
        summary: `Character "${characterLabel(match)}" (${match.type}) already exists as ${match.id}. No new record created. Use sync-characters updates to modify it.`,
      },
    );
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
    throw new ToolError(
      "invalid-input",
      `Unknown character type: ${params.type}`,
    );
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
  // any off-schema keys as summary warnings the LLM can self-correct next turn.
  const { warningText } = validateFieldsAgainstSchema(fields, schema);

  const summary = params.description
    ? ` — ${truncate(params.description, 60)}`
    : "";
  const warning = warningText ? `\n\n${warningText}` : "";
  return withPendingProposals(
    withModelView(
      {
        existed: false,
        characterId: id,
        name: params.name,
        type: params.type,
      },
      {
        summary: `Created ${params.type} "${params.name}" as ${id}.${summary}${warning}`,
      },
    ),
    [proposal],
  );
}

// ── Character updates ─────────────────────────────────────────────

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
    removeAliases: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Aliases to take away because they do not name this person; omit otherwise. The character's name stays",
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

async function updateCharacter(
  store: CharacterStore,
  params: z.infer<ReturnType<typeof createUpdateCharacterParametersSchema>>,
  context: ToolExecutionContext,
) {
  const all = await mergeCharacterViews(store, context);
  // No partial match: a write must reach the person named, not the one
  // whose name happens to contain the same word.
  const resolution = resolveCharacter(all, params.id);
  if (resolution.status !== "found") {
    throw new ToolError(
      resolution.status === "ambiguous" ? "ambiguous" : "not-found",
      `${describeUnresolvedCharacter(params.id, resolution, all)} Nothing was updated.`,
    );
  }
  const existing = resolution.character;
  // Removal runs first, so one call can replace a wrong alias, and a name
  // in both lists stays.
  const removeKeys = new Set(
    (params.removeAliases ?? []).map(characterNameKey),
  );
  const removedAliases = (existing.aliases ?? []).filter((alias) =>
    removeKeys.has(characterNameKey(alias)),
  );
  const keptAliases = (existing.aliases ?? []).filter(
    (alias) => !removeKeys.has(characterNameKey(alias)),
  );
  const addedAliases = mergeCharacterAliases(
    existing.name,
    keptAliases,
    params.aliases,
  ).slice(keptAliases.length);
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
  // Validate the supplied patch, so correcting one malformed field does not
  // require rewriting unrelated attributes that were already malformed.
  if (params.fields !== undefined) assertCharacterFields(params.fields, schema);

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
      ...(removedAliases.length > 0 ? { removeAliases: removedAliases } : {}),
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
  if (removedAliases.length > 0)
    changeLines.push(`  aliases: - ${removedAliases.join(", ")}`);
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
    withModelView(
      {
        characterId: existing.id,
        version: newVersion,
      },
      {
        summary: `Updated ${existing.type} "${existing.name}" (${existing.id}) → v${newVersion}.${changeBlock}${warning}`,
      },
    ),
    [proposal],
  );
}

// ── sync-characters ─────────────────────────────────────────────

interface CharacterWriteOutput {
  readonly existed?: boolean;
  readonly characterId?: string;
  readonly name?: string;
  readonly type?: string;
  readonly version?: number;
}

function createSyncCharactersTool(
  store: CharacterStore,
  schema?: CharacterSchema,
): ToolModule {
  return tool({
    name: "sync-characters",
    description:
      "Atomically submit every explicit character change from this narrative turn. Put new characters in creates and patches for existing characters in updates. Creates return an existing name/type or alias match as unchanged and never overwrite existing profiles. A player name must not be another character's name or alias. Updates find a character by id, name or alias; fields shallow-merge, aliases add, removeAliases take away, and version increases by 1. Correct and resubmit the full batch after a failure. When nothing changed, submit empty arrays to settle the turn." +
      characterFieldsHint(schema),
    parameters: z.object({
      creates: z
        .array(createCharacterParametersSchema(schema))
        .max(5)
        .default([])
        .describe(
          "Up to 5 new characters; existing name/type or alias matches return unchanged. Player names must not belong to another character.",
        ),
      updates: z
        .array(createUpdateCharacterParametersSchema())
        .max(10)
        .default([])
        .describe(
          "Up to 10 patches by id, name or alias; fields shallow-merge, aliases add, removeAliases take away, version increases by 1.",
        ),
    }),
    execute: async ({ creates, updates }, context) => {
      // An empty batch is the explicit "no character changed" settlement, the
      // same shape a bookkeeping runtime uses when it must call a tool.
      if (creates.length + updates.length === 0) {
        return withModelView(
          {
            created: [],
            updated: [],
            unchanged: [],
          },
          { summary: "No character changes this turn." },
        );
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

      const summaries: string[] = [];
      const runEntry = async (
        entry: string,
        execute: () => Promise<unknown>,
      ) => {
        try {
          const result = await execute();
          const summary = getModelView(result)?.summary;
          if (summary) summaries.push(summary);
          return result;
        } catch (error) {
          if (isToolError(error))
            throw new ToolError(error.code, `${entry}: ${error.message}`, {
              hint: error.hint,
            });
          if (error instanceof CharacterFieldValidationError)
            throw new ToolError("invalid-input", `${entry}: ${error.message}`);
          throw new Error(
            `${entry}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      };
      for (const [index, params] of creates.entries()) {
        const rawResult = await runEntry(`creates[${index}]`, () =>
          createCharacter(store, params, batchContext()),
        );
        const result = getToolContent(rawResult) as CharacterWriteOutput;
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

      for (const [index, params] of updates.entries()) {
        const rawResult = await runEntry(`updates[${index}]`, () =>
          updateCharacter(store, params, batchContext()),
        );
        const result = getToolContent(rawResult) as CharacterWriteOutput;
        proposals.push(...getPendingProposals(rawResult));
        updated.push({
          characterId: result.characterId,
          version: result.version,
        });
      }

      return withPendingProposals(
        withModelView(
          {
            created,
            updated,
            unchanged,
          },
          {
            summary: `Synchronized ${created.length} new and ${updated.length} existing characters.${unchanged.length ? ` Duplicate creates left unchanged: ${JSON.stringify(unchanged)}. Put explicit field changes in updates using these ids.` : ""}${summaries.length ? `\n${summaries.join("\n")}` : ""}`,
          },
        ),
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
    annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
    description:
      "List the characters in this session (session scope, visible to all plugins; at the most 50, with a note when more exist). Sorted by version, highest first (a higher version means more interaction), then by latest update. Can filter by a type the world schema declares. Returns a compact text list, one line per character: id / name with its aliases / type / version / short description. Call get-character for full attributes.",
    parameters: z.object({
      type: z.string().min(1).optional().describe("Filter by type (optional)"),
    }),
    execute: async (params, context) => {
      const all = await mergeCharacterViews(store, context);
      const filtered =
        params.type != null ? all.filter((c) => c.type === params.type) : all;
      const sorted = sortByFrequencyThenRecency(filtered);

      if (sorted.length === 0) {
        const filterNote = params.type ? ` of type ${params.type}` : "";
        return withModelView(
          {
            count: 0,
            characters: [],
          },
          {
            summary: `No characters${filterNote} in this session yet.${params.type && all.length ? ` Types in this session: ${[...new Set(all.map((character) => character.type))].sort().join(", ")}.` : ""}`,
          },
        );
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

      return withModelView(
        {
          count: sorted.length,
          characters: shown.map(toSnapshot),
        },
        { summary: [header, ...lines, ...more].join("\n") },
      );
    },
  });
}

// ── get-character ────────────────────────────────────────────────

function createGetCharacterTool(store: CharacterStore): ToolModule {
  return tool({
    name: "get-character",
    annotations: { readOnly: true, idempotent: true, concurrencySafe: true },
    description:
      "Get one character's full attributes by id, name or alias (all fields, description, version). Pass id or name. The name need not match exactly: a single character whose name or alias contains it, or that it contains, also matches. A missing or ambiguous match is an error with the closest known names or candidates, so list-characters is not needed.",
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
      let resolution = resolveCharacter(all, query, { partial: true });
      if (resolution.status === "missing") {
        const key = characterNameKey(query);
        const candidates = resolution.closest.filter(
          (character) =>
            key &&
            [character.name, ...(character.aliases ?? [])].some((name) => {
              const normalized = characterNameKey(name);
              return (
                normalized &&
                (normalized.includes(key) || key.includes(normalized))
              );
            }),
        );
        if (candidates.length > 1)
          resolution = { status: "ambiguous", candidates };
      }
      if (resolution.status !== "found") {
        throw new ToolError(
          resolution.status === "ambiguous" ? "ambiguous" : "not-found",
          describeUnresolvedCharacter(query, resolution, all),
        );
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

      return withModelView(
        {
          character: toSnapshot(match),
        },
        { summary: lines.join("\n") },
      );
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
  return [createSyncCharactersTool(store, schema)];
}
