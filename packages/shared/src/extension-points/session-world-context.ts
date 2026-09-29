import { kernelExtensionPoints } from "./contracts.js";
import { z } from "zod";
import { defineExtensionPoint } from "./index.js";

export const sessionWorldContextV1 = defineExtensionPoint({
  ...kernelExtensionPoints.sessionWorldContext,
  input: z.strictObject({}),
  output: z.strictObject({
    schema: z.record(z.string(), z.unknown()).optional(),
    entries: z.record(z.string(), z.unknown()).optional(),
  }),
  timeoutMs: 500,
  onError: "skip",
});
