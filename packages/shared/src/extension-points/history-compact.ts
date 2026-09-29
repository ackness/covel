import { kernelExtensionPoints } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./definition.js";
import { historyMessageSchema } from "./prompt-history-transform.js";

export const historyCompactionInputSchema = z.strictObject({
  messages: z.array(historyMessageSchema).readonly(),
  existingSummaries: z
    .array(
      z.strictObject({
        id: z.string(),
        sessionId: z.string(),
        turnRangeStart: z.string(),
        turnRangeEnd: z.string(),
        content: z.string(),
        focusSections: z.array(z.string()).readonly(),
        createdAt: z.string(),
      }),
    )
    .readonly(),
  contextWindow: z.number().positive(),
  estimatedTokens: z.number().nonnegative(),
  locale: z.string(),
});
export const historyCompactionOutputSchema = z
  .strictObject({
    messageIds: z.array(z.string()).min(1).readonly(),
    content: z.string().min(1),
    focusSections: z.array(z.string()).readonly(),
    truncated: z.boolean().optional(),
  })
  .nullable();
export type HistoryCompactionInput = z.infer<
  typeof historyCompactionInputSchema
>;
export type HistoryCompactionOutput = z.infer<
  typeof historyCompactionOutputSchema
>;
export const historyCompactV1 = defineExtensionPoint({
  ...kernelExtensionPoints.historyCompact,
  input: historyCompactionInputSchema,
  output: historyCompactionOutputSchema,
  timeoutMs: 60_000,
  onError: "skip",
});
