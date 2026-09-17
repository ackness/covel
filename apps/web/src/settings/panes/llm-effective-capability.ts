import { getBuiltinProviderConnection } from "@covel/shared";
import {
  mergeCapability,
  type LlmSlotInfo,
  type ModelParameterOverrides,
  type ModelCapabilityInfo,
  type ModelCapabilityLookupResult,
} from "@/services/api.js";

export interface EffectiveModelTarget {
  provider: string;
  model: string;
  protocol: string;
  baseCapability?: ModelCapabilityInfo;
  parameterDefaults?: ModelParameterOverrides;
}

export function resolveEffectiveModelTarget(
  boundModel:
    | {
        provider: string;
        model: string;
        protocol?: string;
        capability?: ModelCapabilityInfo;
        parameterOverrides?: ModelParameterOverrides;
      }
    | undefined,
  serverSlot: LlmSlotInfo | null | undefined,
): EffectiveModelTarget {
  const target = boundModel ?? serverSlot;
  const provider = target?.provider ?? "";
  return {
    provider,
    model: target?.model ?? "",
    protocol:
      target?.protocol ??
      getBuiltinProviderConnection(provider)?.protocol ??
      "openai-chat-v1",
    // A role override changes the request target. The previous slot's limits
    // cannot establish the capabilities of the newly selected model.
    baseCapability: target?.capability,
    parameterDefaults: target?.parameterOverrides,
  };
}

export function resolveDisplayCapability(
  lookup: ModelCapabilityLookupResult | null | undefined,
  baseCapability?: ModelCapabilityInfo | null,
  override?: Partial<ModelCapabilityInfo>,
): ModelCapabilityInfo | undefined {
  const known = lookup?.found && lookup.source !== "protocol-default";
  const capability = known
    ? lookup.capability
    : lookup?.capability
      ? {
          input: lookup.capability.input,
          output: lookup.capability.output,
          features: lookup.capability.features,
        }
      : undefined;
  // Protocol defaults describe a transport's baseline support, not a model's
  // documented token budget. Explicit user overrides remain authoritative.
  return mergeCapability(
    mergeCapability(capability, baseCapability ?? undefined),
    override,
  );
}
