import { kernelExtensionPoints } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./definition.js";
import { dimensionSnapshotSchema } from "../schemas/dimensions.js";

export const sessionWorldContextV1 = defineExtensionPoint({
  ...kernelExtensionPoints.sessionWorldContext,
  input: z.strictObject({}),
  output: z.strictObject({
    schema: z.record(z.string(), z.unknown()).optional(),
    entries: z.record(z.string(), z.unknown()).optional(),
    dimensions: dimensionSnapshotSchema.optional(),
    dimensionRecovery: z
      .strictObject({
        editorRuntimeId: z.string().min(1),
        trackerRuntimeId: z.string().min(1),
      })
      .optional(),
    dimensionProviderPluginId: z.string().min(1).optional(),
  }),
  timeoutMs: 500,
  onError: "fail-turn",
});
