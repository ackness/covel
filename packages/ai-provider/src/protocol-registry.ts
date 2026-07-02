/**
 * Protocol Registry — single source of truth for everything that varies
 * per wire protocol.
 *
 * Every protocol bundles its three protocol-scoped concerns —
 * `createAdapter`, `cacheStrategy`, `capabilityDefaults` — in one entry.
 * The provider registry and the capability resolver both query this table
 * instead of hand-rolling their own switch.
 *
 * Adding a protocol is a single entry in {@link BUILTIN_PROTOCOLS}, which
 * is typed `Record<ProviderProtocol, ProtocolDefinition>` — so omitting an
 * entry for a new `ProviderProtocol` member is a *compile error*.
 */

import type { ModelProviderAdapter } from "./adapters/adapter.js";
import { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.js";
import type {
  CacheStrategy,
  ModelCapability,
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
 */
export interface ProtocolDefinition {
  readonly createAdapter: () => ModelProviderAdapter;
  readonly cacheStrategy: CacheStrategy;
  readonly capabilityDefaults: ModelCapability;
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
  contextWindow: 8_192,
  maxOutputTokens: 4_096,
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
const BUILTIN_PROTOCOLS: Record<ProviderProtocol, ProtocolDefinition> = {
  "openai-chat-v1": {
    createAdapter: createOpenAiChatAdapter,
    // OpenAI / DeepSeek / Qwen transparently cache repeated prefixes.
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      ...BASE_CAPABILITY_DEFAULTS,
      features: ["function_calling", "structured_output", "streaming"],
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    },
  },
  "openai-responses-v1": {
    createAdapter: createOpenAiResponsesAdapter,
    cacheStrategy: "auto-prefix",
    capabilityDefaults: {
      ...BASE_CAPABILITY_DEFAULTS,
      features: [
        "function_calling",
        "structured_output",
        "streaming",
        "web_search",
      ],
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
    },
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
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
  },
};

/** Look up a protocol's bundled definition, or `undefined` if unknown. */
export function getProtocolDefinition(
  protocol: ProviderProtocol,
): ProtocolDefinition | undefined {
  return BUILTIN_PROTOCOLS[protocol];
}
