import type {
  ModelFeature,
  ModelRequestContext,
  ProviderProtocol,
} from "./types.js";

import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@covel/shared";
import { anthropicModelTraits } from "./anthropic-model-traits.js";
export { REASONING_EFFORT_VALUES };
export type { ReasoningEffort };

export type ReasoningProviderFamily =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "google"
  | "xai"
  | "qwen"
  | "compatible";

export interface ReasoningEffortOption {
  value: ReasoningEffort;
  /** Application budget preset, not a native effort level. */
  thinkingBudgetTokens?: number;
}

/** Provider/model-specific reasoning controls exposed to the settings UI. */
export interface ReasoningEffortProfile {
  family: ReasoningProviderFamily;
  options: ReasoningEffortOption[];
  /** Documented provider default. Omitted when it varies by model. */
  defaultValue?: ReasoningEffort;
}

const options = (...values: ReasoningEffort[]): ReasoningEffortOption[] =>
  values.map((value) => ({ value }));

const ANTHROPIC_EFFORT_MODEL_PATTERN =
  /claude-(?:(?:fable|mythos|opus|sonnet)-5(?:[-.]|$)|opus-4-[5-8](?:-|$)|sonnet-4-6(?:-|$))/;

function isQwenThinkingOnlyModel(model: string): boolean {
  return /qwen[^\s]*[-_/]thinking(?:[-_/]|$)|qwen3\.8-2\.4t-a95b|qwen3\.7-max-(?:preview|2026-05-17)/.test(
    model,
  );
}

function isGeminiModel(model: string, ...names: string[]): boolean {
  const modelName = model.split("/").at(-1) ?? model;
  return names.some(
    (name) =>
      modelName.startsWith(name) &&
      /^(?:-preview(?:-[\d-]+)?|-latest|-\d{3})?$/.test(
        modelName.slice(name.length),
      ),
  );
}

function resolveGeminiReasoningProfile(
  model: string,
  protocol?: ProviderProtocol | string,
): ReasoningEffortProfile | null {
  const openAiCompatible = protocol === "openai-chat-v1";
  if (isGeminiModel(model, "gemini-2.5-pro")) {
    return {
      family: "google",
      options: gemini25BudgetOptions(false, openAiCompatible),
    };
  }
  if (isGeminiModel(model, "gemini-2.5-flash", "gemini-2.5-flash-lite")) {
    return {
      family: "google",
      options: gemini25BudgetOptions(true, openAiCompatible),
    };
  }
  if (isGeminiModel(model, "gemini-3-pro")) {
    return {
      family: "google",
      defaultValue: "high",
      options: options("low", "high"),
    };
  }
  if (isGeminiModel(model, "gemini-3.1-pro")) {
    return {
      family: "google",
      defaultValue: "high",
      options: options(
        ...(openAiCompatible ? ["minimal" as const] : []),
        "low",
        "medium",
        "high",
      ),
    };
  }
  if (isGeminiModel(model, "gemini-3-flash")) {
    return {
      family: "google",
      defaultValue: "high",
      options: options("minimal", "low", "medium", "high"),
    };
  }
  if (isGeminiModel(model, "gemini-3.1-flash-lite", "gemini-3.5-flash-lite")) {
    return {
      family: "google",
      defaultValue: "minimal",
      options: options("minimal", "low", "medium", "high"),
    };
  }
  if (isGeminiModel(model, "gemini-3.5-flash", "gemini-3.6-flash")) {
    return {
      family: "google",
      defaultValue: "medium",
      options: options("minimal", "low", "medium", "high"),
    };
  }
  if (isGeminiModel(model, "gemini-3.7-flash", "gemini-3.8-flash")) {
    return {
      family: "google",
      defaultValue: "medium",
      options: options("low", "medium", "high"),
    };
  }
  return null;
}

function gemini25BudgetOptions(
  canDisable: boolean,
  openAiCompatible: boolean,
): ReasoningEffortOption[] {
  // Application presets within each model's published budget range, not
  // native Gemini 2.5 effort levels.
  return [
    ...(canDisable
      ? [{ value: "none" as const, thinkingBudgetTokens: 0 }]
      : []),
    ...(openAiCompatible
      ? [{ value: "minimal" as const, thinkingBudgetTokens: 1024 }]
      : []),
    { value: "low", thinkingBudgetTokens: 1024 },
    { value: "medium", thinkingBudgetTokens: 8192 },
    { value: "high", thinkingBudgetTokens: 24576 },
  ];
}

/**
 * Resolve the reasoning control from the opaque model ID first, then fall back
 * to the transport provider. This keeps aggregator IDs such as
 * `deepseek/deepseek-v4-flash` provider-correct even when routed through an
 * OpenAI-compatible service.
 */
export function resolveReasoningEffortProfile(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol | string,
  features?: readonly ModelFeature[],
): ReasoningEffortProfile | null {
  const family = resolveReasoningProviderFamily(modelId, provider);
  const model = modelId.toLowerCase();
  const advertisesReasoning = features?.includes("reasoning") ?? false;

  if (family === "deepseek") {
    if (
      !advertisesReasoning &&
      !/deepseek-(?:v4|flash|chat|reasoner|r1)/.test(model)
    ) {
      return null;
    }
    return {
      family,
      defaultValue: "high",
      options: options("disabled", "high", "max"),
    };
  }

  if (family === "anthropic") {
    if (!ANTHROPIC_EFFORT_MODEL_PATTERN.test(model)) return null;
    const supportsXHigh =
      /(?:claude-(?:opus|sonnet|fable|mythos)-5)|(?:opus-4-[78])/.test(model);
    const supportsMax = supportsXHigh || /(?:opus|sonnet)-4-6/.test(model);
    const levels = supportsXHigh
      ? options("low", "medium", "high", "xhigh", "max")
      : supportsMax
        ? options("low", "medium", "high", "max")
        : options("low", "medium", "high");
    const adaptive =
      /claude-(?:(?:opus|sonnet)-5|opus-4-[678]|sonnet-4-6)/.test(model);
    return {
      family,
      defaultValue: "high",
      options:
        (adaptive || /claude-opus-4-5/.test(model)) &&
        anthropicModelTraits(model).thinkingCanBeDisabled
          ? [...options("disabled"), ...levels]
          : levels,
    };
  }

  if (family === "google") {
    return resolveGeminiReasoningProfile(model, protocol);
  }

  if (family === "xai") {
    if (!advertisesReasoning && !/grok-(?:3-mini|4)/.test(model)) return null;
    return {
      family,
      defaultValue: "high",
      options: /(?:4\.20|multi-agent)/.test(model)
        ? options("low", "medium", "high", "xhigh")
        : options("low", "medium", "high"),
    };
  }

  if (family === "qwen") {
    if (!advertisesReasoning && !/qwen3/.test(model)) return null;
    const thinkingOnly = isQwenThinkingOnlyModel(model);
    const supportsChat = !protocol || protocol === "openai-chat-v1";
    if (
      supportsChat &&
      /qwen3\.8-(?:max|flash|omni-flash|27b|2\.4t-a95b)(?:-|$)/.test(model)
    ) {
      return {
        family,
        defaultValue: "xhigh",
        options: options(
          ...(thinkingOnly ? [] : ["disabled" as const]),
          "automatic",
          "low",
          "medium",
          "xhigh",
        ),
      };
    }
    if (supportsChat && /qwen3\.[567]-(?:max|plus|flash)(?:-|$)/.test(model)) {
      return {
        family,
        options: [
          ...options(
            ...(thinkingOnly ? [] : ["disabled" as const]),
            "automatic",
          ),
          { value: "low", thinkingBudgetTokens: 2048 },
          { value: "medium", thinkingBudgetTokens: 8192 },
          { value: "high", thinkingBudgetTokens: 16384 },
        ],
      };
    }
    if (thinkingOnly) {
      return {
        family,
        defaultValue: "automatic",
        options: options("automatic"),
      };
    }
    return {
      family,
      options: options("disabled", "automatic"),
    };
  }

  if (family === "openai") {
    const isReasoningModel =
      advertisesReasoning ||
      /gpt-[5-9]/.test(model) ||
      /(?:^|[/_-])o[134](?:-|$)/.test(model);
    if (!isReasoningModel) return null;
    // GPT-6 and later take the levels of GPT-5.2 and `max` above them. No
    // default is recorded: it is not the same for every model of the family.
    if (/gpt-[6-9]/.test(model)) {
      return {
        family,
        options: options(
          "none",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
        ),
      };
    }
    if (/gpt-5-pro(?:-|$)/.test(model)) {
      return {
        family,
        defaultValue: "high",
        options: options("high"),
      };
    }
    if (/gpt-5\.1/.test(model)) {
      return {
        family,
        defaultValue: "none",
        options: /codex.*max|max.*codex/.test(model)
          ? options("none", "low", "medium", "high", "xhigh")
          : options("none", "low", "medium", "high"),
      };
    }
    if (/(?:^|[/_-])o[134](?:-|$)/.test(model)) {
      return {
        family,
        defaultValue: "medium",
        options: options("low", "medium", "high"),
      };
    }
    return {
      family,
      defaultValue: "medium",
      options: /gpt-5\.[2-9]/.test(model)
        ? options("none", "minimal", "low", "medium", "high", "xhigh")
        : options("minimal", "low", "medium", "high"),
    };
  }

  if (!advertisesReasoning) return null;
  if (protocol === "anthropic-messages-v1") {
    return {
      family: "compatible",
      options: options("low", "medium", "high"),
    };
  }
  return {
    family: "compatible",
    options: options("minimal", "low", "medium", "high"),
  };
}

/** What a wire needs to place a reasoning selection in its request. */
export interface ReasoningWireRequest {
  /** A level the model accepts; `provider-default` never reaches a wire. */
  selection: ReasoningEffort;
  family: ReasoningProviderFamily;
  model: string;
  provider?: string;
  protocol: ProviderProtocol;
  metadata: Record<string, unknown> | undefined;
}

/** One protocol's request fields for a reasoning selection. */
export type ReasoningWire = (
  request: ReasoningWireRequest,
) => Record<string, unknown>;

/**
 * Translate a unified UI selection through one protocol's wire. A selection
 * the model does not offer sends nothing, so the provider default applies.
 */
export function reasoningRequestFields(
  wire: ReasoningWire | undefined,
  metadata: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  protocol: ProviderProtocol,
  requestModel: string,
): Record<string, unknown> {
  const selection = readReasoningEffort(metadata);
  if (!wire || !selection || selection === "provider-default") return {};

  const provider = context?.preset?.provider ?? context?.profile?.provider;
  const model =
    context?.preset?.model ?? context?.profile?.model ?? requestModel;
  const family = resolveReasoningProviderFamily(
    model || requestModel,
    provider,
  );
  if (family !== "compatible") {
    const profile = resolveReasoningEffortProfile(model, provider, protocol);
    const supportsSelection = profile?.options.some(
      (option) => option.value === selection,
    );
    if (!supportsSelection) {
      return family === "qwen" && isQwenThinkingOnlyModel(model.toLowerCase())
        ? { enable_thinking: true }
        : {};
    }
  }
  return wire({ selection, family, model, provider, protocol, metadata });
}

export function anthropicReasoningFields({
  selection,
  family,
  model,
  metadata,
}: ReasoningWireRequest): Record<string, unknown> {
  if (selection === "disabled") {
    return { thinking: { type: "disabled" } };
  }
  if (selection === "automatic") return {};
  const adaptive =
    family === "anthropic" &&
    /claude-(?:(?:fable|mythos|opus|sonnet)-5|opus-4-[678]|sonnet-4-6)/.test(
      model.toLowerCase(),
    );
  return {
    ...(family === "deepseek" ? { thinking: { type: "enabled" } } : {}),
    ...(adaptive
      ? {
          thinking: {
            type: "adaptive",
            display: asRecord(metadata?.thinking).display ?? "summarized",
          },
        }
      : {}),
    output_config: {
      ...asRecord(metadata?.output_config),
      effort: selection,
    },
  };
}

export function googleReasoningFields({
  selection,
  family,
  model,
  protocol,
}: ReasoningWireRequest): Record<string, unknown> {
  if (family !== "google") return {};
  const option = resolveGeminiReasoningProfile(
    model.toLowerCase(),
    protocol,
  )?.options.find((entry) => entry.value === selection);
  if (!option) return {};
  return {
    thinkingConfig:
      option.thinkingBudgetTokens !== undefined
        ? { thinkingBudget: option.thinkingBudgetTokens }
        : { thinkingLevel: selection },
  };
}

export function openAiResponsesReasoningFields({
  selection,
  metadata,
}: ReasoningWireRequest): Record<string, unknown> {
  if (selection === "automatic") return {};
  return {
    reasoning: {
      ...asRecord(metadata?.reasoning),
      effort: selection === "disabled" ? "none" : selection,
    },
  };
}

/** OpenAI Chat, with the fields DeepSeek and Qwen use on the same wire. */
export function openAiChatReasoningFields({
  selection,
  family,
  model,
  provider,
  protocol,
}: ReasoningWireRequest): Record<string, unknown> {
  if (family === "deepseek") {
    if (selection === "disabled") {
      return { thinking: { type: "disabled" } };
    }
    if (selection === "automatic") {
      return { thinking: { type: "enabled" } };
    }
    return {
      thinking: { type: "enabled" },
      reasoning_effort: selection,
    };
  }

  if (family === "qwen") {
    const option = resolveReasoningEffortProfile(
      model,
      provider,
      protocol,
    )?.options.find((entry) => entry.value === selection);
    if (option?.thinkingBudgetTokens !== undefined) {
      return {
        enable_thinking: true,
        thinking_budget: option.thinkingBudgetTokens,
      };
    }
    if (/qwen3\.8-/.test(model.toLowerCase()) && selection !== "automatic") {
      return {
        enable_thinking: selection !== "disabled",
        reasoning_effort: selection === "disabled" ? "none" : selection,
      };
    }
    return { enable_thinking: selection !== "disabled" };
  }

  if (selection === "automatic") return {};
  return {
    reasoning_effort: selection === "disabled" ? "none" : selection,
  };
}

export function readReasoningEffort(
  metadata: Record<string, unknown> | undefined,
): ReasoningEffort | undefined {
  const parameterOverrides = asRecord(metadata?.parameterOverrides);
  for (const value of [
    parameterOverrides.reasoningEffort,
    metadata?.reasoning_effort,
    metadata?.reasoningEffort,
  ]) {
    if (
      typeof value === "string" &&
      (REASONING_EFFORT_VALUES as readonly string[]).includes(value)
    ) {
      return value as ReasoningEffort;
    }
  }
  return undefined;
}

function resolveReasoningProviderFamily(
  modelId: string,
  provider?: string,
): ReasoningProviderFamily {
  const model = modelId.toLowerCase();
  const providerId = provider?.toLowerCase() ?? "";
  if (model.includes("deepseek")) return "deepseek";
  if (model.includes("claude") || model.includes("anthropic"))
    return "anthropic";
  if (model.includes("gemini") || model.includes("google/")) return "google";
  if (model.includes("grok") || model.includes("xai/")) return "xai";
  if (model.includes("qwen") || model.includes("alibaba/")) return "qwen";
  if (
    model.includes("gpt-") ||
    /(?:^|[/_-])o[134](?:-|$)/.test(model) ||
    model.includes("openai/")
  ) {
    return "openai";
  }

  if (providerId.includes("deepseek")) return "deepseek";
  if (providerId.includes("anthropic")) return "anthropic";
  if (providerId.includes("google") || providerId.includes("gemini"))
    return "google";
  if (providerId === "xai" || providerId.includes("grok")) return "xai";
  if (
    providerId.includes("dashscope") ||
    providerId.includes("qwen") ||
    providerId.includes("alibaba")
  ) {
    return "qwen";
  }
  if (providerId.includes("openai")) return "openai";
  return "compatible";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
