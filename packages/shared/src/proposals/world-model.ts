import { z } from "zod";
import type { CharacterRecord } from "../types/character-record.js";
import type { CharacterSchemaRecord } from "../types/world-model.js";
import type { Proposal } from "../types/proposal.js";
import { characterSchemaSchema } from "../schemas/world.js";
import { buildFieldsZodFromSchema } from "../schemas/character-fields.js";
import { materializeCharacterUpsert } from "./character-upsert.js";
import {
  characterLabel,
  characterNameKey,
  findCharacterAliasConflict,
} from "@covel/plugin-handlers-utils";
import {
  dimensionInitializePayloadSchema,
  materializeDimensionRecords,
} from "./dimensions.js";
import {
  dimensionSnapshotFromRecords,
  resolveWorldDimensionsLocale,
} from "../schemas/dimensions.js";

export interface WorldModelView {
  readonly worldRecord?: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly lore?: string;
    readonly tags?: readonly string[];
    readonly locale?: string;
    readonly dimensions?: import("../types/world.js").WorldDimensions;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly createdAt: string;
    readonly updatedAt?: string;
  } | null;
  readonly characterSchema: CharacterSchemaRecord | null;
  readonly characters: readonly CharacterRecord[];
  readonly dimensions: import("../types/dimensions.js").DimensionSnapshot;
  readonly dimensionProviderPluginId?: string;
}

export const characterSchemaSetPayloadSchema = characterSchemaSchema.omit({
  version: true,
});
export const characterUpsertPayloadSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).optional(),
    removeAliases: z.array(z.string().trim().min(1)).optional(),
    type: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    fields: z.unknown().optional(),
    version: z.number().int().positive().optional(),
    expectedVersion: z.number().int().positive().optional(),
    createdAt: z.string().optional(),
  })
  .strict();

type NameKey = (text: string) => string;

/** `characterNameKey` that folds each spelling once per validation. */
function memoizedNameKey(): NameKey {
  const keys = new Map<string, string>();
  return (text) => {
    let key = keys.get(text);
    if (key === undefined) {
      key = characterNameKey(text);
      keys.set(text, key);
    }
    return key;
  };
}

/** For each name key, the IDs of who has it as a name and as an alias. */
type NameOwners = ReadonlyMap<
  string,
  { readonly names: string[]; readonly aliases: string[] }
>;

function characterNameOwners(
  characters: readonly CharacterRecord[],
  keyOf: NameKey,
): NameOwners {
  const owners = new Map<string, { names: string[]; aliases: string[] }>();
  const entry = (text: string) => {
    const key = keyOf(text);
    let hit = owners.get(key);
    if (!hit) owners.set(key, (hit = { names: [], aliases: [] }));
    return hit;
  };
  for (const character of characters) {
    entry(character.name).names.push(character.id);
    for (const alias of character.aliases ?? [])
      entry(alias).aliases.push(character.id);
  }
  return owners;
}

/**
 * One name means one person: no alias of `character` is a name or an alias
 * of another character, and its name is no alias of another. `owners` answers
 * that by lookup; only a conflict walks the characters, for a message that
 * names the other character, so a model can write there instead.
 */
function assertCharacterNamesFree(
  characters: readonly CharacterRecord[],
  owners: NameOwners,
  character: CharacterRecord,
  keyOf: NameKey,
): void {
  const other = (ids: readonly string[] | undefined) =>
    ids?.some((id) => id !== character.id) ?? false;
  const nameOwners = owners.get(keyOf(character.name));
  if (
    !other(nameOwners?.aliases) &&
    !(character.aliases ?? []).some((alias) => {
      const hit = owners.get(keyOf(alias));
      return other(hit?.names) || other(hit?.aliases);
    })
  )
    return;
  const conflict = findCharacterAliasConflict(characters, character);
  if (conflict)
    throw new Error(
      `Alias "${conflict.alias}" of ${character.name} [${character.id}] is already a name of ${characterLabel(conflict.owner)} [${conflict.owner.id}]. If they are one person, write to ${conflict.owner.id}. If the alias is wrong for ${conflict.owner.name}, remove it there first (removeAliases). Otherwise use a different alias.`,
    );
  const key = keyOf(character.name);
  const owner = characters.find(
    (candidate) =>
      candidate.id !== character.id &&
      (candidate.aliases ?? []).some((alias) => keyOf(alias) === key),
  );
  if (owner)
    throw new Error(
      `Name "${character.name}" of [${character.id}] is an alias of ${characterLabel(owner)} [${owner.id}]. If they are one person, write to ${owner.id}. If the alias is wrong for ${owner.name}, remove it there first (removeAliases). Otherwise use a different name.`,
    );
}

export function validateWorldModel(view: WorldModelView): void {
  validateWithNameKeys(view, memoizedNameKey());
}

function validateWithNameKeys(view: WorldModelView, keyOf: NameKey): void {
  const allowedTypes = new Set([
    "player",
    ...(view.characterSchema?.types ?? ["npc", "companion"]),
  ]);
  const fields = view.characterSchema
    ? buildFieldsZodFromSchema(view.characterSchema)
    : null;
  const owners = characterNameOwners(view.characters, keyOf);
  let players = 0;
  for (const character of view.characters) {
    if (!allowedTypes.has(character.type))
      throw new Error(`Unknown character type: ${character.type}`);
    if (character.type === "player" && ++players > 1)
      throw new Error("A session may have at most one player character");
    if (fields) fields.parse(character.fields ?? {});
    assertCharacterNamesFree(view.characters, owners, character, keyOf);
  }
}

/** The same domain validation runs for commit and execution-local reads. */
export function materializeWorldModel(
  base: Omit<WorldModelView, "dimensions"> & {
    readonly dimensions?: WorldModelView["dimensions"];
  },
  proposals: readonly Proposal[],
  sessionId: string,
  /** The session's content locale; resolves declared dimensions to it. */
  locale?: string,
): WorldModelView {
  let state: WorldModelView = {
    ...structuredClone(base),
    dimensions: structuredClone(base.dimensions ?? {}),
  };
  const keyOf = memoizedNameKey();
  for (const proposal of proposals) {
    if (proposal.sessionId !== sessionId) continue;
    if (proposal.type === "character.schema.set") {
      const payload = characterSchemaSetPayloadSchema.parse(
        structuredClone(proposal.payload),
      );
      state = {
        ...state,
        characterSchema: {
          ...payload,
          sessionId,
          version: (state.characterSchema?.version ?? 0) + 1,
          createdAt: state.characterSchema?.createdAt ?? proposal.timestamp,
          updatedAt: proposal.timestamp,
        },
      };
    } else if (proposal.type === "character.upsert") {
      const payload = characterUpsertPayloadSchema.parse(
        structuredClone(proposal.payload),
      );
      const live = state.characters.find(
        (character) => character.id === payload.id,
      );
      if (
        payload.expectedVersion !== undefined &&
        (!live || payload.expectedVersion > live.version)
      )
        throw new Error(`Invalid expectedVersion for character ${payload.id}`);
      const record = materializeCharacterUpsert(
        payload,
        live,
        sessionId,
        proposal.timestamp,
      );
      // Checked for the written record first, so the message is about it and
      // not about the stored character it collides with.
      assertCharacterNamesFree(
        state.characters,
        characterNameOwners(state.characters, keyOf),
        record,
        keyOf,
      );
      state = {
        ...state,
        characters: [
          ...state.characters.filter((character) => character.id !== record.id),
          record,
        ],
      };
    } else if (
      proposal.type === "dimension.initialize" &&
      proposal.source.pluginId === state.dimensionProviderPluginId
    ) {
      const definitions = resolveWorldDimensionsLocale(
        dimensionInitializePayloadSchema.parse(proposal.payload).definitions,
        locale,
      );
      const dimensions = { ...state.dimensions };
      for (const [id, definition] of Object.entries(definitions)) {
        if (dimensions[id]) continue;
        dimensions[id] = dimensionSnapshotFromRecords({
          [id]: { definition, value: definition.initialValue, version: 1 },
        })[id]!;
      }
      state = { ...state, dimensions };
    } else if (
      proposal.type === "dimension.update" &&
      proposal.source.pluginId === state.dimensionProviderPluginId
    ) {
      const records = Object.fromEntries(
        Object.entries(state.dimensions).map(([id, entry]) => [
          id,
          {
            definition: {
              name: entry.name,
              ...(entry.description ? { description: entry.description } : {}),
              schema: entry.schema,
              initialValue: entry.value,
            },
            value: entry.value,
            version: entry.version,
          },
        ]),
      );
      state = {
        ...state,
        dimensions: dimensionSnapshotFromRecords(
          materializeDimensionRecords(records, proposal, locale),
        ),
      };
    } else continue;
    validateWithNameKeys(state, keyOf);
  }
  return state;
}
