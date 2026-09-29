import { z } from "zod";
import {
  REASONING_EFFORT_VALUES,
  type LLMDiagnostics,
  type LLMProviderWarning,
  type ReasoningEffort,
} from "@covel/shared";
import { AiProviderError } from "./errors.js";
import type { ProviderProtocol } from "./types.js";

/** Validated options selected by protocol ID, then overridden by provider ID. */
export interface ProviderOptionSettings {
  reasoningEffort?: ReasoningEffort;
  reasoningSummary?: "auto" | "concise" | "detailed";
  parallelToolCalls?: boolean;
  store?: boolean;
  seed?: number;
  user?: string;
  thinking?:
    | { type: "enabled"; budgetTokens: number }
    | { type: "disabled" | "adaptive" };
  /** Explicit wire extension; reserved framework fields are still protected. */
  extraBody?: Record<string, unknown>;
}

/** Protocol defaults are overridden by the active provider's namespace. */
export type ProviderOptions = Record<string, ProviderOptionSettings>;

const FRAMEWORK_BODY_FIELDS = new Set([
  "model",
  "messages",
  "input",
  "system",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "response_format",
  "text",
  "parameterOverrides",
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "embeddingFormat",
  "providerOptions",
  "reasoningEffort",
]);

const settingsSchema = z.object({
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
  reasoningSummary: z.enum(["auto", "concise", "detailed"]).optional(),
  parallelToolCalls: z.boolean().optional(),
  store: z.boolean().optional(),
  seed: z.number().int().safe().optional(),
  user: z.string().optional(),
  thinking: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("enabled"),
        budgetTokens: z.number().int().min(1024),
      }),
      z.object({ type: z.enum(["disabled", "adaptive"]) }),
    ])
    .optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
});

/** Only the active namespaces are validated: inactive fallback options are inert. */
export function resolveProviderOptions(
  options: ProviderOptions | undefined,
  provider: string,
  protocol: ProviderProtocol,
): { metadata: Record<string, unknown>; warnings: LLMProviderWarning[] } {
  let metadata: Record<string, unknown> = {};
  const warnings: LLMProviderWarning[] = [];
  if (options === undefined) return { metadata, warnings };
  if (!isRecord(options)) throw invalidOptions(provider);
  for (const namespace of new Set([protocol, provider])) {
    if (!Object.hasOwn(options, namespace)) continue;
    const value = options[namespace];
    const parsed = settingsSchema.safeParse(value);
    if (!parsed.success) throw invalidOptions(provider);
    const settings = parsed.data;
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(settingsSchema.shape, key)) {
        warnings.push(unsupported(`providerOptions.${namespace}.${key}`));
      }
    }
    const fields: Record<string, unknown> = { ...settings.extraBody };
    for (const key of Object.keys(fields)) {
      if (FRAMEWORK_BODY_FIELDS.has(key)) {
        delete fields[key];
        warnings.push(
          unsupported(`providerOptions.${namespace}.extraBody.${key}`),
        );
      }
    }
    const supported = new Set<string>(["extraBody", "reasoningEffort"]);
    if (protocol === "openai-chat-v1" || protocol === "openai-responses-v1") {
      for (const [key, wire] of [
        ["parallelToolCalls", "parallel_tool_calls"],
        ["store", "store"],
        ["user", "user"],
      ] as const) {
        supported.add(key);
        if (settings[key] !== undefined) fields[wire] = settings[key];
      }
      if (protocol === "openai-chat-v1") {
        supported.add("seed");
        if (settings.seed !== undefined) fields.seed = settings.seed;
      } else {
        supported.add("reasoningSummary");
        if (settings.reasoningSummary !== undefined) {
          fields.reasoning = {
            ...(isRecord(fields.reasoning) ? fields.reasoning : {}),
            summary: settings.reasoningSummary,
          };
        }
      }
    } else if (protocol === "anthropic-messages-v1") {
      supported.add("thinking");
      if (settings.thinking !== undefined) {
        fields.thinking =
          settings.thinking.type === "enabled"
            ? { type: "enabled", budget_tokens: settings.thinking.budgetTokens }
            : { type: settings.thinking.type };
      }
    }
    if (settings.reasoningEffort !== undefined)
      fields.reasoning_effort = settings.reasoningEffort;
    for (const key of Object.keys(settings)) {
      if (!supported.has(key))
        warnings.push(unsupported(`providerOptions.${namespace}.${key}`));
    }
    metadata = { ...metadata, ...fields };
  }
  return { metadata, warnings };
}

const parameterSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().nonnegative().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  frequencyPenalty: z.number().min(-2).max(2).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  reasoningEffort: z.enum(REASONING_EFFORT_VALUES).optional(),
});

/** Validate portable generation settings and report fields the wire cannot use. */
export function validateParameterMetadata(
  metadata: Record<string, unknown>,
  provider: string,
  protocol: ProviderProtocol,
): LLMProviderWarning[] {
  if (metadata.parameterOverrides === undefined) return [];
  const parsed = parameterSchema.safeParse(metadata.parameterOverrides);
  if (!parsed.success) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message: "Invalid generation parameter overrides",
      provider,
      retriable: false,
    });
  }
  const warnings: LLMProviderWarning[] = [];
  for (const key of Object.keys(
    metadata.parameterOverrides as Record<string, unknown>,
  )) {
    if (
      !Object.hasOwn(parameterSchema.shape, key) ||
      (key === "topK" && protocol !== "anthropic-messages-v1") ||
      (["frequencyPenalty", "presencePenalty"].includes(key) &&
        protocol !== "openai-chat-v1")
    ) {
      warnings.push(unsupported(`parameterOverrides.${key}`));
    }
  }
  return warnings;
}

export function withProviderWarnings<
  T extends { diagnostics?: LLMDiagnostics },
>(result: T, warnings: readonly LLMProviderWarning[]): T {
  if (!warnings.length) return result;
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      warnings: [...warnings, ...(result.diagnostics?.warnings ?? [])],
    },
  };
}

function unsupported(feature: string): LLMProviderWarning {
  return {
    type: "unsupported",
    feature,
    message:
      "This option is not supported by the selected protocol and was ignored.",
  };
}

function invalidOptions(provider: string): AiProviderError {
  return new AiProviderError({
    code: "CONFIG_ERROR",
    message: "Invalid provider options for the selected target",
    provider,
    retriable: false,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
