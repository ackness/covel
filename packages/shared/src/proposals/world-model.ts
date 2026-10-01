import { z } from "zod";
import type { CharacterRecord } from "../types/character-record.js";
import type { CharacterSchemaRecord } from "../types/world-model.js";
import type { Proposal } from "../types/proposal.js";
import { characterSchemaSchema } from "../schemas/world.js";
import { buildFieldsZodFromSchema } from "../schemas/character-fields.js";
import { materializeCharacterUpsert } from "./character-upsert.js";
import {
  dimensionInitializePayloadSchema,
  materializeDimensionRecords,
} from "./dimensions.js";
import { dimensionSnapshotFromRecords } from "../schemas/dimensions.js";

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
    type: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    fields: z.unknown().optional(),
    version: z.number().int().positive().optional(),
    expectedVersion: z.number().int().positive().optional(),
    createdAt: z.string().optional(),
  })
  .strict();

export function validateWorldModel(view: WorldModelView): void {
  const allowedTypes = new Set([
    "player",
    ...(view.characterSchema?.types ?? ["npc", "companion"]),
  ]);
  const fields = view.characterSchema
    ? buildFieldsZodFromSchema(view.characterSchema)
    : null;
  let players = 0;
  for (const character of view.characters) {
    if (!allowedTypes.has(character.type))
      throw new Error(`Unknown character type: ${character.type}`);
    if (character.type === "player" && ++players > 1)
      throw new Error("A session may have at most one player character");
    if (fields) fields.parse(character.fields ?? {});
  }
}

/** The same domain validation runs for commit and execution-local reads. */
export function materializeWorldModel(
  base: Omit<WorldModelView, "dimensions"> & {
    readonly dimensions?: WorldModelView["dimensions"];
  },
  proposals: readonly Proposal[],
  sessionId: string,
): WorldModelView {
  let state: WorldModelView = {
    ...structuredClone(base),
    dimensions: structuredClone(base.dimensions ?? {}),
  };
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
      const { definitions } = dimensionInitializePayloadSchema.parse(
        proposal.payload,
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
          materializeDimensionRecords(records, proposal),
        ),
      };
    } else continue;
    validateWorldModel(state);
  }
  return state;
}
