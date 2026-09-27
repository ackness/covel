import { z } from "zod";
import { defineExtensionPoint } from "./index.js";
export const mediaImageFlowSchema = z.strictObject({
  pluginId: z.string().optional(),
  entryRuntimeId: z.string().min(1),
  assetRuntimeIds: z.array(z.string().min(1)).min(1).max(20).readonly(),
});
export type MediaImageFlow = z.infer<typeof mediaImageFlowSchema>;
export const mediaImageFlowV1 = defineExtensionPoint({
  id: "media.image-flow@1",
  mode: "single",
  input: z.strictObject({}),
  output: mediaImageFlowSchema,
  timeoutMs: 500,
  onError: "skip",
  attributeOutput(output, provider) {
    for (const id of [output.entryRuntimeId, ...output.assetRuntimeIds]) {
      if (id !== provider.pluginId && !id.startsWith(`${provider.pluginId}/`))
        throw new Error("Image flow can only declare its provider's runtimes");
    }
    return { ...output, pluginId: provider.pluginId };
  },
});
