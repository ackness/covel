/**
 * Protocol Registry — everything that varies per wire protocol.
 *
 * A protocol states its adapter, cache strategy, capability defaults and its
 * translations of portable settings in one {@link ProtocolDefinition}. The
 * gateway, the provider registry and the capability resolver query this
 * table; none of them compares a protocol ID.
 *
 * Adding a protocol is a descriptor in `PROVIDER_PROTOCOL_DESCRIPTORS`
 * (`@covel/shared`) and an entry in {@link BUILTIN_PROTOCOLS}, which is typed
 * `Record<ProviderProtocol, ProtocolDefinition>` — so a descriptor without an
 * entry is a *compile error*.
 */

import {
  PROVIDER_PROTOCOL_DESCRIPTORS,
  isBuiltinProviderProtocol,
  protocolOutputModalities,
  type BuiltinProviderProtocol,
  type ProviderProtocolDescriptor,
} from "@covel/shared";
import { createEvaluationAdapter } from "./adapters/evaluation.js";
import type { ModelProviderAdapter } from "./adapters/adapter.js";
import { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
import {
  createAnthropicMessagesAdapter,
  listAnthropicModels,
} from "./adapters/anthropic-messages.js";
import {
  createGoogleGenerativeAiAdapter,
  listGoogleModels,
} from "./adapters/google-generative-ai.js";
import { fetchModelIds } from "./adapters/model-list.js";
import { AiProviderError } from "./errors.js";
import {
  getTextWire,
  listTextWires,
  textWireAdapter,
} from "./text/wire-registry.js";
import type {
  OptionalWireParameter,
  ProviderOptionWire,
} from "./provider-options.js";
import {
  anthropicReasoningFields,
  googleReasoningFields,
  openAiChatReasoningFields,
  openAiResponsesReasoningFields,
  reasoningRequestFields,
  type ReasoningWire,
} from "./reasoning-effort.js";
import type {
  CacheStrategy,
  ModelCapability,
  ModelRequestContext,
  ProviderConfig,
  ProviderProtocol,
} from "./types.js";

/**
 * Everything that differs between wire protocols, bundled in one place.
 *
 * - `createAdapter` — fresh {@link ModelProviderAdapter} per call (one
 *   instance per `resolve`).
 * - `cacheStrategy` — default prompt-cache ergonomics for this protocol.
 * - `capabilityDefaults` — fallback {@link ModelCapability} used when no
 *   curated/DB entry matches a model on this protocol.
 * - `reasoningFields` — the request fields for a `reasoningEffort` level.
 *   Absent: the setting sends nothing on this protocol.
 * - `providerOptionFields` — the `providerOptions` settings this protocol
 *   accepts. Absent: only `reasoningEffort` and `extraBody` apply.
 * - `parameters` — the optional generation parameters it has a field for.
 * - `mediaWire: "explicit"` — the endpoint has no OpenAI-style media routes,
 *   so an image or speech slot on it must name its wire.
 * - `listModels` — the model IDs the endpoint offers, for the settings UI.
 */
export interface ProtocolDefinition {
  readonly createAdapter: () => ModelProviderAdapter;
  readonly cacheStrategy: CacheStrategy;
  readonly capabilityDefaults: ModelCapability;
  readonly reasoningFields?: ReasoningWire;
  readonly providerOptionFields?: ProviderOptionWire;
  readonly parameters?: readonly OptionalWireParameter[];
  readonly mediaWire?: "explicit";
  readonly listModels?: (
    config: ProviderConfig,
    signal?: AbortSignal,
  ) => Promise<string[]>;
}

// ── Capability defaults ────────────────────────────────────────────

/**
 * The lowest-tier capability fallback, used when no protocol is known
 * (or an unregistered one is requested). Exported so the capability
 * resolver shares the exact same base instead of redeclaring it.
 */
export const BASE_CAPABILITY_DEFAULTS: ModelCapability = {
  input: ["text"],
  output: ["text"],
  features: ["streaming"],
};

const listOpenAiModels: ProtocolDefinition["listModels"] = (config, signal) =>
  fetchModelIds(config, "/models", "openai", signal);

/** Settings the two OpenAI wires share. */
const openAiOptionFields: ProviderOptionWire = (settings, fields) => {
  const wireFields = [
    ["parallelToolCalls", "parallel_tool_calls"],
    ["store", "store"],
    ["user", "user"],
  ] as const;
  for (const [key, wire] of wireFields) {
    if (settings[key] !== undefined) fields[wire] = settings[key];
  }
  return wireFields.map(([key]) => key);
};

// ── Built-in protocol table (exhaustive) ───────────────────────────

/**
 * Built-in protocol definitions.
 *
 * Typed `Record<ProviderProtocol, ProtocolDefinition>`: TypeScript requires
 * a key for *every* union member, so adding a `ProviderProtocol` without a
 * matching entry fails `tsc`. This is the compile-time "no silent miss"
 * guarantee.
 */
const BUILTIN_PROTOCOLS: Record<BuiltinProviderProtocol, ProtocolDefinition> = {
  "google-generative-ai-v1": {
    createAdapter: createGoogleGenerativeAiAdapter,
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      input: ["text"],
      output: ["text"],
      features: ["function_calling", "structured_output", "streaming"],
    },
    reasoningFields: googleReasoningFields,
    providerOptionFields(settings, fields) {
      const keys = ["thinkingConfig", "cachedContent", "seed"] as const;
      for (const key of keys) {
        if (settings[key] !== undefined) fields[key] = settings[key];
      }
      return keys;
    },
    parameters: ["topK", "frequencyPenalty", "presencePenalty"],
    mediaWire: "explicit",
    listModels: listGoogleModels,
  },
  "typesafe-systemone-v1": {
    createAdapter: () => createEvaluationAdapter("typesafe-systemone-v1"),
    cacheStrategy: "none",
    capabilityDefaults: {
      input: ["text"],
      output: protocolOutputModalities("typesafe-systemone-v1"),
      features: [],
    },
  },
  "openrouter-decisions-v1": {
    createAdapter: () => createEvaluationAdapter("openrouter-decisions-v1"),
    cacheStrategy: "none",
    capabilityDefaults: {
      input: ["text"],
      output: protocolOutputModalities("openrouter-decisions-v1"),
      features: [],
    },
  },
  "vercel-evaluation-v4": {
    createAdapter: () => createEvaluationAdapter("vercel-evaluation-v4"),
    cacheStrategy: "none",
    capabilityDefaults: {
      input: ["text"],
      output: protocolOutputModalities("vercel-evaluation-v4"),
      features: [],
    },
  },
  "openai-decisions-v1": {
    createAdapter: () => createEvaluationAdapter("openai-decisions-v1"),
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      input: ["text"],
      output: protocolOutputModalities("openai-decisions-v1"),
      features: [],
    },
  },
  "openai-chat-v1": {
    createAdapter: createOpenAiChatAdapter,
    // OpenAI / DeepSeek / Qwen transparently cache repeated prefixes.
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      ...BASE_CAPABILITY_DEFAULTS,
      features: ["function_calling", "structured_output", "streaming"],
    },
    reasoningFields: openAiChatReasoningFields,
    providerOptionFields(settings, fields) {
      if (settings.seed !== undefined) fields.seed = settings.seed;
      return [...openAiOptionFields(settings, fields), "seed"];
    },
    parameters: ["frequencyPenalty", "presencePenalty"],
    listModels: listOpenAiModels,
  },
  "openai-responses-v1": {
    createAdapter: createOpenAiResponsesAdapter,
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      ...BASE_CAPABILITY_DEFAULTS,
      features: ["function_calling", "structured_output", "streaming"],
    },
    reasoningFields: openAiResponsesReasoningFields,
    providerOptionFields(settings, fields) {
      if (settings.reasoningSummary !== undefined) {
        const reasoning = fields.reasoning;
        fields.reasoning = {
          ...(reasoning !== null &&
          typeof reasoning === "object" &&
          !Array.isArray(reasoning)
            ? reasoning
            : {}),
          summary: settings.reasoningSummary,
        };
      }
      return [...openAiOptionFields(settings, fields), "reasoningSummary"];
    },
    listModels: listOpenAiModels,
  },
  "anthropic-messages-v1": {
    createAdapter: createAnthropicMessagesAdapter,
    // Anthropic requires explicit cache_control breakpoints.
    cacheStrategy: "anthropic-explicit",
    capabilityDefaults: {
      ...BASE_CAPABILITY_DEFAULTS,
      features: [
        "function_calling",
        "structured_output",
        "streaming",
        "prompt_caching",
      ],
    },
    reasoningFields: anthropicReasoningFields,
    providerOptionFields(settings, fields) {
      if (settings.thinking !== undefined) {
        fields.thinking =
          settings.thinking.type === "enabled"
            ? { type: "enabled", budget_tokens: settings.thinking.budgetTokens }
            : { type: settings.thinking.type };
      }
      return ["thinking"];
    },
    parameters: ["topK"],
    listModels: listAnthropicModels,
  },
};

/**
 * Look up a protocol's definition: a built-in one, or the text wire a plugin
 * registered under that ID. `undefined` when neither exists.
 */
export function getProtocolDefinition(
  protocol: ProviderProtocol,
): ProtocolDefinition | undefined {
  if (isBuiltinProviderProtocol(protocol)) return BUILTIN_PROTOCOLS[protocol];
  const wire = getTextWire(protocol);
  if (!wire) return undefined;
  return {
    createAdapter: () => textWireAdapter(wire),
    cacheStrategy: wire.cacheStrategy ?? "none",
    capabilityDefaults: wire.capabilityDefaults ?? {
      ...BASE_CAPABILITY_DEFAULTS,
      features: ["function_calling", "structured_output", "streaming"],
    },
    reasoningFields: wire.reasoningFields,
    providerOptionFields: wire.providerOptionFields,
    parameters: wire.parameters,
    listModels: wire.listModels,
  };
}

/** Every protocol a model can be configured with, for the settings UI. */
export function listProviderProtocols(): ProviderProtocolDescriptor[] {
  return [
    ...PROVIDER_PROTOCOL_DESCRIPTORS,
    ...listTextWires().map((wire) => ({
      id: wire.id,
      label: wire.label ?? wire.id,
      output: "text" as const,
    })),
  ];
}

/** Translate a unified reasoning selection into the given protocol's fields. */
export function extractReasoningRequestFields(
  metadata: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  protocol: ProviderProtocol,
  requestModel: string,
): Record<string, unknown> {
  return reasoningRequestFields(
    getProtocolDefinition(protocol)?.reasoningFields,
    metadata,
    context,
    protocol,
    requestModel,
  );
}

/** The model IDs an endpoint offers on a protocol that can list them. */
export async function listProtocolModels(
  protocol: ProviderProtocol,
  config: ProviderConfig,
  provider: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const listModels = getProtocolDefinition(protocol)?.listModels;
  if (!listModels) {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message: `Protocol "${protocol}" has no model list; enter the model IDs by hand.`,
      provider,
      retriable: false,
    });
  }
  return listModels(config, signal);
}
