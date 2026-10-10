import type {
  ModelFeature,
  ModelRequestContext,
  ProviderProtocol,
} from "./types.js";

import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@covel/shared";
import {
  resolveReasoningControls,
  type ReasoningEffortOption,
  type ReasoningEffortProfile,
  type ReasoningParameterStyle,
  type ReasoningProviderFamily,
} from "./capability/reasoning-models.js";
export { REASONING_EFFORT_VALUES };
export type {
  ReasoningEffort,
  ReasoningEffortOption,
  ReasoningEffortProfile,
  ReasoningProviderFamily,
};

/**
 * The reasoning levels a model offers, for the settings UI and the request
 * path. Which model takes which levels is data
 * (`capability/reasoning-models.data.json`); this file only writes a level
 * into each protocol's request.
 */
export function resolveReasoningEffortProfile(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol | string,
  features?: readonly ModelFeature[],
): ReasoningEffortProfile | null {
  return resolveReasoningControls(modelId, provider, protocol, features)
    .profile;
}

/** What a wire needs to place a reasoning selection in its request. */
export interface ReasoningWireRequest {
  /** A level the model accepts; `provider-default` never reaches a wire. */
  selection: ReasoningEffort;
  family: ReasoningProviderFamily;
  /**
   * The selection as the model's entry lists it, with its token budget when
   * the level is a budget preset. Absent for a model with no entry.
   */
  option?: ReasoningEffortOption;
  /** Which of a family's parameter forms the model takes. */
  parameterStyle?: ReasoningParameterStyle;
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
  const { family, profile, parameterStyle, thinkingAlwaysOn } =
    resolveReasoningControls(model || requestModel, provider, protocol);
  const option = profile?.options.find((entry) => entry.value === selection);
  // A model of an unnamed family with no entry takes the level as selected.
  if (!option && (profile || family !== "compatible")) {
    return family === "qwen" && thinkingAlwaysOn
      ? { enable_thinking: true }
      : {};
  }
  return wire({
    selection,
    family,
    option,
    parameterStyle,
    model,
    provider,
    protocol,
    metadata,
  });
}

export function anthropicReasoningFields({
  selection,
  family,
  parameterStyle,
  metadata,
}: ReasoningWireRequest): Record<string, unknown> {
  if (selection === "disabled") {
    return { thinking: { type: "disabled" } };
  }
  if (selection === "automatic") return {};
  const adaptive = family === "anthropic" && parameterStyle === "adaptive";
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
  option,
}: ReasoningWireRequest): Record<string, unknown> {
  if (family !== "google" || !option) return {};
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
  option,
  parameterStyle,
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
    if (option?.thinkingBudgetTokens !== undefined) {
      return {
        enable_thinking: true,
        thinking_budget: option.thinkingBudgetTokens,
      };
    }
    if (parameterStyle === "effort" && selection !== "automatic") {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
