import { z } from "zod";

const NonEmptyString = z.string().trim().min(1);

export const WorkflowRunStatusSchema = z.enum([
  "running",
  "suspended",
  "completed",
  "failed"
]);

export const WorkflowSnapshotRecordSchema = z.object({
  runId: NonEmptyString,
  stepId: NonEmptyString,
  sessionId: NonEmptyString,
  status: WorkflowRunStatusSchema,
  suspendPayload: z.record(z.string(), z.unknown()).optional(),
  resumeData: z.record(z.string(), z.unknown()).optional(),
  updatedAt: z.string().datetime({ offset: true })
});

export const WorkflowSignalTypeSchema = z.enum([
  "workflow.suspended",
  "workflow.resumed"
]);

export const WorkflowSignalSchema = z.object({
  type: WorkflowSignalTypeSchema,
  runId: NonEmptyString,
  stepId: NonEmptyString,
  payload: z.record(z.string(), z.unknown()).optional()
});

export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;
export type WorkflowSnapshotRecord = z.infer<typeof WorkflowSnapshotRecordSchema>;
export type WorkflowSignalType = z.infer<typeof WorkflowSignalTypeSchema>;
export type WorkflowSignal = z.infer<typeof WorkflowSignalSchema>;
