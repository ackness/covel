import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const PackageStateScopeSchema = z.enum(["world", "session"]);

export const PackageStateRecordSchema = z.object({
  scope: PackageStateScopeSchema,
  ownerId: NonEmptyString,
  packageName: NonEmptyString,
  collection: NonEmptyString,
  key: NonEmptyString,
  value: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime({ offset: true })
});

export type PackageStateScope = z.infer<typeof PackageStateScopeSchema>;
export type PackageStateRecord = z.infer<typeof PackageStateRecordSchema>;
