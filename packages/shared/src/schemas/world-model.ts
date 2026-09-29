import { z } from "zod";
import { attributeDefinitionSchema } from "./world.js";
import type { AttributeDefinition } from "../types/character-schema.js";

export const lorebookOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world") }).strict(),
  z
    .object({ kind: z.literal("plugin"), pluginId: z.string().trim().min(1) })
    .strict(),
  z.object({ kind: z.literal("player") }).strict(),
]);

export const characterSchemaSchema = z
  .object({
    version: z.number().int().positive(),
    types: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine((value) => value !== "player", "player is a reserved type"),
      )
      .refine(
        (values) => new Set(values).size === values.length,
        "character types must be unique",
      )
      .default(["npc", "companion"]),
    attributes: z.array(
      z.lazy(() => attributeDefinitionSchema as z.ZodType<AttributeDefinition>),
    ),
  })
  .strict();

export const characterSchemaRecordSchema = characterSchemaSchema.extend({
  sessionId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
