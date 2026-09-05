import { z } from "zod";
import type {
  ActionRequestValidation,
  ActionRequest,
  WorldCreateRequest,
  WorldPatchRequest,
  SuspensionSummary,
} from "../types/api-contract.js";
import type {
  PluginRuntimeSummary,
  PluginSummary,
  WorldPluginPlan,
} from "../types/plugin-api.js";
import { canonicalizeLocale } from "../utils/locale-registry.js";
import {
  pluginRelationsSchema,
  pluginUserSettingSpecSchema,
  stageSchema,
  triggerConfigSchema,
} from "./plugin-schemas.js";
import { i18nTextSchema, worldDimensionsSchema } from "./world.js";

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const SAFE_WORLD_ID_PATTERN = /^[a-z0-9_-]{1,64}$/i;
const ACTION_TYPES = [
  "send_message",
  "execute_command",
  "start_session",
  "retry_runtime",
  "retry_turn",
] as const;

function requiredActionString(
  field: string,
  maxLength: number,
  pattern?: RegExp,
) {
  let schema = z
    .string()
    .min(1, { message: `${field} must be a non-empty string` })
    .max(maxLength, {
      message: `${field} must be at most ${maxLength} characters`,
    });
  if (pattern) {
    schema = schema.regex(pattern, {
      message: `${field} has an invalid format`,
    });
  }
  return schema;
}

const actionLocaleSchema = z
  .string()
  .refine((value) => canonicalizeLocale(value) !== undefined, {
    message: "locale has an invalid format",
  })
  .transform((value) => canonicalizeLocale(value)!);

const actionModelSchema = requiredActionString("model", 256).refine(
  (value) =>
    [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && codePoint !== 0x7f;
    }),
  { message: "model has an invalid format" },
);

const actionBase = {
  requestId: requiredActionString("requestId", 128, ACTION_ID_PATTERN),
  sessionId: requiredActionString("sessionId", 256, ACTION_ID_PATTERN),
  locale: actionLocaleSchema.optional(),
  model: actionModelSchema.optional(),
};

export const actionTypeSchema = z.enum(ACTION_TYPES);

export const actionRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...actionBase,
      type: z.literal("send_message"),
      payload: z
        .object({
          content: requiredActionString("send_message.content", 100_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal("execute_command"),
      payload: z
        .object({
          command: requiredActionString("execute_command.command", 10_000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal("start_session"),
      payload: z
        .object({
          loreOverride: z
            .string()
            .max(500_000, {
              message:
                "start_session.loreOverride must be at most 500000 characters",
            })
            .optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal("retry_runtime"),
      payload: z
        .object({
          runtimeId: requiredActionString(
            "retry_runtime.runtimeId",
            200,
            ACTION_ID_PATTERN,
          ),
          retryFromTurnId: requiredActionString(
            "retry_runtime.retryFromTurnId",
            256,
            ACTION_ID_PATTERN,
          ).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...actionBase,
      type: z.literal("retry_turn"),
      payload: z.object({}).strict(),
    })
    .strict(),
]);

export function validateActionRequest(raw: unknown): ActionRequestValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const rawType = (raw as Record<string, unknown>).type;
  if (!ACTION_TYPES.includes(rawType as (typeof ACTION_TYPES)[number])) {
    return {
      ok: false,
      error: `Unsupported action type: ${String(rawType)}`,
    };
  }
  const result = actionRequestSchema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues[0]?.message ?? "Invalid action request",
    };
  }
  return { ok: true, value: result.data as ActionRequest };
}

export const apiErrorResponseSchema = z
  .object({
    error: z.string(),
    code: z
      .string()
      .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u)
      .optional(),
    details: z.unknown().optional(),
  })
  .strict();

/** Canonical collection envelope used by ordinary list endpoints. */
export function apiListResponseSchema<Item extends z.ZodType>(item: Item) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z.string().nullable().optional(),
    })
    .strict();
}

const effectiveTurnCompletionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("await") }).strict(),
  z
    .object({
      mode: z.literal("detached"),
      maxQueueMs: z.number().int().positive().optional(),
      maxExecutionMs: z.number().int().positive().optional(),
      overlap: z.literal("serial"),
      stalePolicy: z.literal("reject"),
    })
    .strict(),
]);

const pluginRuntimeSummarySchema: z.ZodType<PluginRuntimeSummary> = z
  .object({
    id: z.string().min(1),
    runtimeType: z.enum(["agent", "function"]),
    stage: stageSchema.optional(),
    trigger: triggerConfigSchema,
    execution: z.enum(["sync", "background"]),
    turnCompletion: effectiveTurnCompletionSchema,
    model: z.string().optional(),
    outputKind: z.enum(["story", "plugin", "system"]),
    capabilities: z.array(z.string()),
    tags: z.array(z.string()),
    relations: pluginRelationsSchema.optional(),
  })
  .strict();

/** Registry-level plugin DTO returned by plugin discovery endpoints. */
export const pluginSummarySchema: z.ZodType<PluginSummary> = z
  .object({
    id: z.string().min(1),
    displayName: i18nTextSchema,
    description: i18nTextSchema,
    pluginType: z.enum(["core-plugin", "plugin"]),
    source: z.enum(["builtin", "community"]),
    status: z.enum(["discovered", "registered", "active", "disabled", "error"]),
    error: z.string().optional(),
    runtimeCount: z.number().int().nonnegative(),
    version: z.string().optional(),
    capabilities: z.array(z.string()),
    tags: z.array(z.string()),
    relations: pluginRelationsSchema.optional(),
    runtimes: z.array(pluginRuntimeSummarySchema),
    tools: z.array(
      z
        .object({
          id: z.string().min(1),
          kind: z.enum(["builtin", "local"]),
          runtimeId: z.string().optional(),
        })
        .strict(),
    ),
    userSettings: z.array(pluginUserSettingSpecSchema),
  })
  .strict();

const pluginPackSchema = z
  .object({
    id: z.string().min(1),
    label: i18nTextSchema,
    description: i18nTextSchema.optional(),
    pluginIds: z.array(z.string()),
    optionalPluginIds: z.array(z.string()),
    excludedPluginIds: z.array(z.string()),
    tags: z.array(z.string()),
    reason: i18nTextSchema.optional(),
    source: z.enum(["builtin", "world"]),
  })
  .strict();

/** Server-resolved plugin-selection plan for one world. */
export const worldPluginPlanSchema: z.ZodType<WorldPluginPlan> = z
  .object({
    worldId: z.string().min(1),
    packs: z.array(pluginPackSchema),
    policy: z
      .object({
        presetId: z.string().optional(),
        preferredTags: z.array(z.string()),
        avoidedTags: z.array(z.string()),
        requiredCapabilities: z.array(z.string()),
        requiredPluginIds: z.array(z.string()),
        recommendedPluginIds: z.array(z.string()),
        excludedPluginIds: z.array(z.string()),
      })
      .strict(),
    selectedPackId: z.string().optional(),
    defaultPluginIds: z.array(z.string()),
  })
  .strict();

/** Public suspension DTO; runtime continuation state never crosses the API. */
export const suspensionSummarySchema: z.ZodType<SuspensionSummary> = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    turnId: z.string().min(1),
    runtimeId: z.string().min(1),
    pluginId: z.string().min(1),
    reason: z.string().optional(),
    resumeSchema: z.unknown().optional(),
    createdAt: z.string().min(1),
  })
  .strict();

export const sseEnvelopeSchema = z
  .object({
    type: z.string().min(1),
    requestId: z.string(),
    traceId: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    flowId: z.string(),
    seq: z.number().int().nonnegative(),
    timestamp: z.string(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

const worldLocaleSchema = z
  .string()
  .refine((value) => canonicalizeLocale(value) !== undefined, {
    message: "locale has an invalid format",
  })
  .transform((value) => canonicalizeLocale(value)!);

const worldMutableFields = {
  name: z.string().min(1, { message: "name (string) is required" }),
  description: z.string().optional(),
  lore: z.string().optional(),
  tags: z.array(z.string()).optional(),
  locale: worldLocaleSchema.optional(),
  dimensions: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
};

export const worldCreateRequestSchema: z.ZodType<WorldCreateRequest> = z
  .object({
    id: z
      .string()
      .regex(SAFE_WORLD_ID_PATTERN, {
        message: "id must match /^[a-z0-9_-]{1,64}$/i",
      })
      .optional(),
    ...worldMutableFields,
    createdAt: z.string().optional(),
  })
  .strict();

export const worldPatchRequestSchema: z.ZodType<WorldPatchRequest> = z
  .object({
    ...worldMutableFields,
  })
  .partial()
  .strict();

export const worldWireRecordSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    lore: z.string().optional(),
    tags: z.array(z.string()).optional(),
    locale: z.string().optional(),
    dimensions: worldDimensionsSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
  })
  .strict();
