import { z } from "zod";
import { turnActionSchema } from "./action.js";

/** Source execution facts; never reconstructed from a worker's later state. */
export const playerInputSubmissionSchema = z
  .strictObject({
    id: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    formId: z.string(),
    values: z.record(z.string(), z.json()).readonly(),
    createdAt: z.string(),
  })
  .readonly();

export const turnDigestSchema = z
  .strictObject({
    turnId: z.string(),
    playerMessage: z.string(),
    actions: z.array(turnActionSchema).readonly(),
    lastPlayerInput: playerInputSubmissionSchema.nullable(),
    narrativeText: z.string(),
    toolCallSummaries: z.array(z.string()).readonly(),
    runtimeResults: z
      .array(
        z
          .strictObject({
            runtimeId: z.string(),
            status: z.enum(["success", "failed", "skipped", "suspended"]),
          })
          .readonly(),
      )
      .readonly(),
    locale: z.string().optional(),
  })
  .readonly();

/** Model-facing operations staged by completed runs of this execution. */
export const operationsInputSchema = z
  .strictObject({
    operations: z
      .array(
        z
          .strictObject({
            contract: z.string(),
            summary: z.string(),
            request: z.json().optional(),
            result: z.json().optional(),
            truncated: z.literal(true).optional(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
