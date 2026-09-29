import { z } from "zod";

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
