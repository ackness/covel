import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed"
]);

export const JobRecordSchema = z.object({
  id: NonEmptyString,
  packageName: NonEmptyString,
  jobType: NonEmptyString,
  sessionId: NonEmptyString.optional(),
  status: JobStatusSchema,
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()).optional(),
  error: NonEmptyString.optional(),
  attempt: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).optional(),
  completedAt: z.string().datetime({ offset: true }).optional()
});

export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobRecord = z.infer<typeof JobRecordSchema>;
