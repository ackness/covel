import { z } from "zod";
import type {
  ActionRequestValidation,
  ActionRequest,
  WorldCreateRequest,
  WorldPatchRequest,
} from "../types/api-contract.js";
import { canonicalizeLocale } from "../utils/locale-registry.js";
import { worldDimensionsSchema } from "./world.js";

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
    code: z.string().optional(),
    details: z.unknown().optional(),
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
