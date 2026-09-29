import { kernelExtensionPoints } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./index.js";

export const promptSegmentSchema = z.strictObject({
  id: z.string().min(1),
  content: z.string(),
  position: z.union([
    z.enum(["system", "pre-history", "post-history"]),
    z.strictObject({ depth: z.number().int().nonnegative() }),
  ]),
  role: z.enum(["system", "user", "assistant"]).optional(),
  audience: z.union([
    z.enum(["all", "story", "self"]),
    z.strictObject({ contract: z.string().min(1) }),
  ]),
  volatility: z.enum(["stable", "session", "turn"]),
  order: z.number().int().optional(),
  providerPluginId: z.string().optional(),
});
export type PromptSegment = z.infer<typeof promptSegmentSchema>;

export const promptSegmentV1 = defineExtensionPoint({
  ...kernelExtensionPoints.promptSegment,
  input: z.strictObject({ turnId: z.string(), playerMessage: z.string() }),
  output: z.array(promptSegmentSchema),
  timeoutMs: 500,
  onError: "skip",
  attributeOutput: (segments, provider) =>
    segments.map((segment) => ({
      ...segment,
      providerPluginId: provider.pluginId,
    })),
});
