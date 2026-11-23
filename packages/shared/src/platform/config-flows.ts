import { z } from "zod";
import { createPlatformIdSchema, platformTextSchema } from "./primitives.js";

export const CONFIG_FLOW_STEP_KINDS = [
  "form",
  "browser",
  "device",
  "import",
  "confirm",
  "done",
  "error",
] as const;

export type ConfigFlowStepKind = (typeof CONFIG_FLOW_STEP_KINDS)[number];

export const configFlowIdSchema = createPlatformIdSchema("Flow ID");

export const configFlowFieldSchema = z.strictObject({
  name: z.string().min(1).describe("Field identifier submitted in step data."),
  label: platformTextSchema.describe(
    "Human-readable label (string or locale map).",
  ),
  type: z
    .enum(["text", "secret", "url", "number", "boolean", "select"])
    .describe("Field input type rendered by the host form UI."),
  required: z
    .boolean()
    .describe("Whether a non-empty value is required.")
    .optional(),
  placeholder: platformTextSchema
    .describe("Optional placeholder hint shown inside the input.")
    .optional(),
  description: platformTextSchema
    .describe("Optional helper text rendered beneath the input.")
    .optional(),
  defaultValue: z
    .union([z.string(), z.number(), z.boolean()])
    .describe("Optional initial JSON scalar value.")
    .optional(),
  options: z
    .array(
      z.strictObject({
        value: z.string(),
        label: platformTextSchema,
      }),
    )
    .describe("Selectable choices when type is `select`.")
    .optional(),
});

export type ConfigFlowField = z.infer<typeof configFlowFieldSchema>;

export const configFlowStepSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("form"),
    stepId: z.string().min(1),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    fields: z.array(configFlowFieldSchema),
    submitLabel: platformTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("browser"),
    stepId: z.string().min(1),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    authorizeUrl: z.string().url(),
    completion: z.enum(["loopback-or-paste", "paste", "loopback"]),
    callbackUrl: z.string().url().optional(),
    expiresAt: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("device"),
    stepId: z.string().min(1),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    userCode: z.string().min(1),
    verificationUri: z.string().url(),
    verificationUriComplete: z.string().url().optional(),
    intervalSec: z.number().int().min(1).max(60).optional(),
    expiresAt: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.literal("import"),
    stepId: z.string().min(1),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    accept: z.string().min(1).optional(),
    maxBytes: z.number().int().min(1).max(1_048_576).optional(),
    placeholder: platformTextSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal("confirm"),
    stepId: z.string().min(1),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    confirmLabel: platformTextSchema.optional(),
    cancelLabel: platformTextSchema.optional(),
    destructive: z.boolean().optional(),
    details: z
      .array(
        z.strictObject({
          label: platformTextSchema,
          value: z.string(),
        }),
      )
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("done"),
    title: platformTextSchema,
    description: platformTextSchema.optional(),
    summary: z.record(z.string(), z.unknown()).optional(),
    refreshSections: z.array(z.string().min(1)).optional(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    code: z.string().min(1).optional(),
    title: platformTextSchema,
    message: platformTextSchema,
    retryable: z.boolean().optional(),
  }),
]);

export type ConfigFlowStep = z.infer<typeof configFlowStepSchema>;

export const configFlowRunSnapshotSchema = z.strictObject({
  runId: z.string().min(1),
  pluginId: z.string().min(1),
  flowId: z.string().min(1),
  status: z.enum(["active", "completed", "failed", "cancelled", "expired"]),
  step: configFlowStepSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type ConfigFlowRunSnapshot = z.infer<typeof configFlowRunSnapshotSchema>;
