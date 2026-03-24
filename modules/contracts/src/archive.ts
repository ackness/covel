import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const ArchiveVersionSchema = z.object({
  id: NonEmptyString,
  sessionId: NonEmptyString,
  turnCutoff: z.number().int().nonnegative(),
  stateSnapshot: z.record(z.string(), z.unknown()),
  workingSummary: NonEmptyString,
  archiveSummary: NonEmptyString,
  createdAt: z.string().datetime({ offset: true })
});

export type ArchiveVersion = z.infer<typeof ArchiveVersionSchema>;
