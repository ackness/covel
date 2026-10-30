import type {
  ModelFeature,
  ModelRequestContext,
  ProviderProtocol,
} from "./types.js";

import { REASONING_EFFORT_VALUES, type ReasoningEffort } from "@covel/shared";
import {
  resolveReasoningControls,
  type ReasoningControls,
  type ReasoningEffortOption,
  type ReasoningEffortProfile,
  type ReasoningFormat,
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
  baseUrl?: string,
): ReasoningEffortProfile | null {
  return resolveReasoningControls(
    modelId,
    provider,
    protocol,
    features,
    baseUrl,
  ).profile;
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
  /** How the target writes a level on an OpenAI-compatible request. */
  format: ReasoningFormat;
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

/** What of the request itself decides its reasoning fields. */
export interface ReasoningRequestShape {
  /** The request offers the model function tools. */
  tools?: boolean;
}

/**
 * Translate a unified UI selection through one protocol's wire. A selection
 * the model does not offer sends nothing, so the provider default applies.
 * When the target accepts only some levels with tools (`withTools` in the
 * reasoning model data) and the request carries tools, a selection outside
 * them, or no selection, is sent the first accepted level instead.
 */
export function reasoningRequestFields(
  wire: ReasoningWire | undefined,
  metadata: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  protocol: ProviderProtocol,
  requestModel: string,
  shape: ReasoningRequestShape = {},
): Record<string, unknown> {
  if (!wire) return {};
  const selected = readReasoningEffort(metadata);
  if ((!selected || selected === "provider-default") && !shape.tools) return {};

  const provider = context?.preset?.provider ?? context?.profile?.provider;
  const model =
    context?.preset?.model ?? context?.profile?.model ?? requestModel;
  const {
    family,
    profile,
    format,
    parameterStyle,
    thinkingAlwaysOn,
    withTools,
  } = reasoningControlsFor(context, protocol, requestModel);
  const selection =
    shape.tools && withTools && !(selected && withTools.includes(selected))
      ? withTools[0]
      : selected;
  if (!selection || selection === "provider-default") return {};
  const option = profile?.options.find((entry) => entry.value === selection);
  // A model of an unnamed family with no entry takes the level as selected.
  if (!option && (profile || family !== "compatible")) {
    return format === "enable-thinking" && thinkingAlwaysOn
      ? { enable_thinking: true }
      : {};
  }
  return wire({
    selection,
    family,
    option,
    format,
    parameterStyle,
    model,
    provider,
    protocol,
    metadata,
  });
}

/**
 * Whether a level turns thinking off. Catalog entries name the off level
 * `none` where Covel's own rules say `disabled`; formats with a separate
 * switch treat both alike.
 */
function isOff(selection: ReasoningEffort): boolean {
  return selection === "disabled" || selection === "none";
}

export function anthropicReasoningFields({
  selection,
  family,
  format,
  parameterStyle,
  metadata,
}: ReasoningWireRequest): Record<string, unknown> {
  if (isOff(selection)) {
    return { thinking: { type: "disabled" } };
  }
  if (selection === "automatic") return {};
  const adaptive = family === "anthropic" && parameterStyle === "adaptive";
  return {
    ...(format === "thinking-type" ? { thinking: { type: "enabled" } } : {}),
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

/** OpenAI Chat, written in the target's format (see `ReasoningFormat`). */
export function openAiChatReasoningFields({
  selection,
  format,
  option,
  parameterStyle,
}: ReasoningWireRequest): Record<string, unknown> {
  if (format === "thinking-type") {
    if (isOff(selection)) {
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

  if (format === "enable-thinking") {
    if (option?.thinkingBudgetTokens !== undefined) {
      return {
        enable_thinking: true,
        thinking_budget: option.thinkingBudgetTokens,
      };
    }
    if (parameterStyle === "effort" && selection !== "automatic") {
      return {
        enable_thinking: !isOff(selection),
        reasoning_effort: isOff(selection) ? "none" : selection,
      };
    }
    return { enable_thinking: !isOff(selection) };
  }

  if (selection === "automatic") return {};
  return {
    reasoning_effort: selection === "disabled" ? "none" : selection,
  };
}

/**
 * The reasoning controls of a request's target, from the slot's provider and
 * model when the context names them.
 */
export function reasoningControlsFor(
  context: ModelRequestContext | undefined,
  protocol: ProviderProtocol,
  requestModel: string,
): ReasoningControls {
  const provider = context?.preset?.provider ?? context?.profile?.provider;
  const model =
    context?.preset?.model ?? context?.profile?.model ?? requestModel;
  return resolveReasoningControls(
    model || requestModel,
    provider,
    protocol,
    undefined,
    context?.preset?.baseUrl,
  );
}

/**
 * Whether a request body turns thinking on or off. `undefined`: it says
 * nothing, so the model's default applies.
 */
export function requestedThinking(
  body: Record<string, unknown>,
): boolean | undefined {
  const thinking = asRecord(body.thinking).type;
  if (thinking === "enabled" || thinking === "adaptive") return true;
  if (thinking === "disabled") return false;
  if (typeof body.enable_thinking === "boolean") return body.enable_thinking;
  const effort = body.reasoning_effort ?? asRecord(body.reasoning).effort;
  if (effort === "none") return false;
  return undefined;
}

/** Whether the target thinks on a request with this body. */
export function thinksOnRequest(
  body: Record<string, unknown>,
  controls: Pick<ReasoningControls, "thinksByDefault">,
): boolean {
  return requestedThinking(body) ?? controls.thinksByDefault;
}

/** A slot whose target narrows reasoning on requests that carry tools. */
export interface ReasoningToolLimit {
  slot: string;
  provider: string;
  model: string;
  protocol: string;
  /** The levels requests with tools are limited to, first one sent. */
  withTools: ReasoningEffort[];
}

/**
 * The slots whose provider, model and protocol accept only some reasoning
 * levels on requests with tools, from the reasoning model data, so a host
 * can tell the owner once at load instead of each request quietly changing.
 */
export function reasoningToolLimits(
  presets: ReadonlyArray<{
    name: string;
    provider: string;
    model: string;
    protocol?: string;
    enabled?: boolean;
  }>,
): ReasoningToolLimit[] {
  return presets.flatMap((preset) => {
    if (preset.enabled === false || !preset.protocol) return [];
    const { withTools } = resolveReasoningControls(
      preset.model,
      preset.provider,
      preset.protocol,
    );
    return withTools
      ? [
          {
            slot: preset.name,
            provider: preset.provider,
            model: preset.model,
            protocol: preset.protocol,
            withTools,
          },
        ]
      : [];
  });
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
