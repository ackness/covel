import { z } from "zod";
import { defineExtensionPoint } from "./index.js";

export const sessionWorldContextV1 = defineExtensionPoint({
  id: "session.world-context@1",
  mode: "single",
  input: z.strictObject({}),
  output: z.strictObject({
    schema: z.record(z.string(), z.unknown()).optional(),
    entries: z.record(z.string(), z.unknown()).optional(),
  }),
  timeoutMs: 500,
  onError: "skip",
});
