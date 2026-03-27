import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const StatePatchScopeSchema = z.enum(["world", "session"]);
export const StatePatchOperationSchema = z.enum(["replace", "merge"]);

export const StatePatchSchema = z.object({
  scope: StatePatchScopeSchema,
  ownerId: NonEmptyString,
  packageName: NonEmptyString,
  collection: NonEmptyString,
  key: NonEmptyString,
  op: StatePatchOperationSchema,
  value: z.record(z.string(), z.unknown())
});

export type StatePatchScope = z.infer<typeof StatePatchScopeSchema>;
export type StatePatchOperation = z.infer<typeof StatePatchOperationSchema>;
export type StatePatch = z.infer<typeof StatePatchSchema>;
