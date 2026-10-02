import { z } from "zod";
import {
  triggerConfigSchema,
  stageSchema,
  turnCompletionConfigSchema,
  toolsConfigSchema,
  effectsDeclSchema,
  permissionsDeclSchema,
  pluginDataInjectDeclSchema,
  runtimeManifestInputSchema,
} from "./plugin-schemas.js";

export const contractIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/);
const textSchema = z.union([
  z.string().min(1),
  z.record(z.string(), z.string()),
]);
const runtimeSourceSchema = z.union([
  z.strictObject({ runtime: z.string().min(1) }),
  z.strictObject({
    contract: contractIdSchema,
    cardinality: z.enum(["one", "all"]).optional(),
  }),
]);
const sourceSchema = z.union([
  runtimeSourceSchema,
  z.strictObject({ kernel: z.literal("turn-digest@1") }),
]);
const afterSchema = z.union([z.string().min(1), runtimeSourceSchema]);
const needsSchema = z.union([
  z.string().min(1),
  z.strictObject({
    runtime: z.string().min(1),
    scope: z.enum(["turn", "session"]).optional(),
  }),
  z.strictObject({
    contract: contractIdSchema,
    cardinality: z.enum(["one", "all"]).optional(),
    scope: z.enum(["turn", "session"]).optional(),
  }),
]);
export const runtimeAuthoringManifestSchema = z
  .strictObject({
    type: z.enum(["agent", "function"]),
    description: textSchema.optional(),
    schedule: z
      .strictObject({
        stage: stageSchema.optional(),
        trigger: triggerConfigSchema.optional(),
        needs: z.array(needsSchema).optional(),
        after: z.array(afterSchema).optional(),
        completion: turnCompletionConfigSchema.optional(),
        manual: z
          .strictObject({ execution: z.enum(["sync", "background"]) })
          .optional(),
      })
      .optional(),
    io: z
      .strictObject({
        inputs: z
          .record(
            z.string().min(1),
            z.strictObject({
              from: sourceSchema,
              scope: z.enum(["turn", "committed"]).optional(),
              select: z.string().optional(),
              required: z.boolean().optional(),
              accepts: z.string().optional(),
              recordAs: z.string().optional(),
            }),
          )
          .optional(),
        selfData: z
          .array(pluginDataInjectDeclSchema.omit({ kind: true }))
          .optional(),
        payloadSchema: z.string().optional(),
        output: z
          .strictObject({
            contract: contractIdSchema.optional(),
            schema: z.string().optional(),
            recordAs: z.string().optional(),
          })
          .optional(),
        visibility: z.enum(["story", "plugin", "system"]).optional(),
      })
      .optional(),
    agent: z
      .strictObject({
        model: z.string().optional(),
        llm: runtimeManifestInputSchema.shape.llm,
        history: runtimeManifestInputSchema.shape.history,
        tools: toolsConfigSchema.optional(),
        advertiseEvents: z.boolean().optional(),
        loop: z
          .strictObject({
            maxSteps: z.number().int().positive().optional(),
            timeoutMs: z.number().int().positive().optional(),
            callTimeoutMs: z.number().int().positive().optional(),
            firstTokenTimeoutMs: z.number().int().positive().optional(),
            maxRetries: z.number().int().min(0).max(5).optional(),
            loopDetection: z.number().int().min(0).max(20).optional(),
            maxRecursionDepth: z.number().int().min(0).max(50).optional(),
            completion: z
              .strictObject({
                require: z.enum(["explicit", "tool-use"]).optional(),
                afterTools: z.array(z.string()).optional(),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    function: z
      .strictObject({
        handler: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
        tools: toolsConfigSchema.optional(),
      })
      .optional(),
    guard: z.string().optional(),
    effects: effectsDeclSchema.optional(),
    permissions: permissionsDeclSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === "function" && (!value.function || value.agent))
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message:
          "Function runtime requires function.handler and cannot declare agent",
      });
    if (value.type === "agent" && value.function)
      ctx.addIssue({
        code: "custom",
        path: ["function"],
        message: "Agent runtime cannot declare function",
      });
    for (const [name, binding] of Object.entries(value.io?.inputs ?? {})) {
      if (
        binding.scope === "committed" &&
        (!binding.recordAs || "kernel" in binding.from)
      )
        ctx.addIssue({
          code: "custom",
          path: ["io", "inputs", name],
          message: "Committed input requires a runtime source and recordAs",
        });
    }
  });
