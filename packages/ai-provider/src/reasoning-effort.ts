import type {
  ModelFeature,
  ModelRequestContext,
  ProviderProtocol,
} from "./types.js";

export const REASONING_EFFORT_VALUES = [
  "disabled",
  "automatic",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORT_VALUES)[number];

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
  return /qwen[^\s]*[-_/]thinking(?:[-_/]|$)/.test(model);
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
      !/deepseek-(?:v4|chat|reasoner|r1)/.test(model)
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
    return {
      family,
      defaultValue: "high",
      options: supportsXHigh
        ? options("low", "medium", "high", "xhigh", "max")
        : supportsMax
          ? options("low", "medium", "high", "max")
          : options("low", "medium", "high"),
    };
  }

  if (family === "google") {
    if (!advertisesReasoning && !/gemini-(?:2\.5|3)/.test(model)) return null;
    const canDisable = /gemini-2\.5-(?:flash|flash-lite)/.test(model);
    return {
      family,
      options: canDisable
        ? options("none", "minimal", "low", "medium", "high")
        : options("minimal", "low", "medium", "high"),
    };
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
    if (isQwenThinkingOnlyModel(model)) {
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
      /gpt-5/.test(model) ||
      /(?:^|[/_-])o[134](?:-|$)/.test(model);
    if (!isReasoningModel) return null;
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

/** Translate a unified UI selection into the current wire protocol. */
export function extractReasoningRequestFields(
  metadata: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  protocol: ProviderProtocol,
  requestModel: string,
): Record<string, unknown> {
  const selection = readReasoningEffort(metadata);
  if (!selection) return {};

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
      return family === "qwen" && isQwenThinkingOnlyModel(model)
        ? { enable_thinking: true }
        : {};
    }
  }

  if (protocol === "anthropic-messages-v1") {
    if (selection === "disabled") {
      return { thinking: { type: "disabled" } };
    }
    if (selection === "automatic") return {};
    return {
      ...(family === "deepseek" ? { thinking: { type: "enabled" } } : {}),
      output_config: {
        ...asRecord(metadata?.output_config),
        effort: selection,
      },
    };
  }

  if (protocol === "openai-responses-v1") {
    if (selection === "automatic") return {};
    return {
      reasoning: {
        ...asRecord(metadata?.reasoning),
        effort: selection === "disabled" ? "none" : selection,
      },
    };
  }

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
    if (isQwenThinkingOnlyModel(model)) {
      return { enable_thinking: true };
    }
    return { enable_thinking: selection !== "disabled" };
  }

  if (selection === "automatic") return {};
  return {
    reasoning_effort: selection === "disabled" ? "none" : selection,
  };
}

function readReasoningEffort(
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
