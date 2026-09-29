import { z } from "zod";
import { characterSchemaSchema } from "./world.js";

export const lorebookOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world") }).strict(),
  z
    .object({ kind: z.literal("plugin"), pluginId: z.string().trim().min(1) })
    .strict(),
  z.object({ kind: z.literal("player") }).strict(),
]);

export const characterSchemaRecordSchema = characterSchemaSchema.extend({
  sessionId: z.string().min(1),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});
