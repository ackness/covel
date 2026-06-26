/**
 * Protocol Registry — single source of truth for everything that varies
 * per wire protocol.
 *
 * Before this registry, adding a protocol that needs a new wire shape was
 * shotgun surgery across four independent `switch`/`if` sites (adapter
 * factory, cache strategy, capability defaults, protocol auto-detect),
 * each with a silent `default` fallback. A miss degraded silently.
 *
 * Now every protocol bundles its three protocol-scoped concerns —
 * `createAdapter`, `cacheStrategy`, `capabilityDefaults` — in one
 * registration. The provider registry and the capability resolver both
 * query this registry instead of hand-rolling their own switch.
 *
 * Adding a protocol is a single entry in {@link BUILTIN_PROTOCOLS}, which
 * is typed `Record<ProviderProtocol, ProtocolDefinition>` — so omitting an
 * entry for a new `ProviderProtocol` member is a *compile error*, and
 * {@link assertProtocolRegistryComplete} re-checks at startup.
 */

import type { ModelProviderAdapter } from "./adapters/adapter.js";
import { createOpenAiChatAdapter } from "./adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "./adapters/openai-responses.js";
import { createAnthropicMessagesAdapter } from "./adapters/anthropic-messages.js";
import {
  PROVIDER_PROTOCOLS,
  type CacheStrategy,
  type ModelCapability,
  type ProviderProtocol,
} from "./types.js";

/**
 * Everything that differs between wire protocols, bundled in one place.
 *
 * - `createAdapter` — fresh {@link ModelProviderAdapter} per call, matching
 *   the prior `builtinAdapter()` behaviour (one instance per `resolve`).
 * - `cacheStrategy` — default prompt-cache ergonomics for this protocol.
 * - `capabilityDefaults` — fallback {@link ModelCapability} used when no
 *   curated/DB entry matches a model on this protocol.
 */
export interface ProtocolDefinition {
  readonly createAdapter: () => ModelProviderAdapter;
  readonly cacheStrategy: CacheStrategy;
  readonly capabilityDefaults: ModelCapability;
}

const registry = new Map<ProviderProtocol, ProtocolDefinition>();

/**
 * Register (or overwrite) the definition for a protocol. This is the one
 * place "接一个新协议" happens — call it once and the adapter factory,
 * cache strategy, and capability defaults all light up.
 */
export function registerProtocol(
  protocol: ProviderProtocol,
  definition: ProtocolDefinition,
): void {
  registry.set(protocol, definition);
}

/** Look up a protocol's bundled definition, or `undefined` if unregistered. */
export function getProtocolDefinition(
  protocol: ProviderProtocol,
): ProtocolDefinition | undefined {
  return registry.get(protocol);
}

/** Protocols that currently have a registration. */
export function listRegisteredProtocols(): ProviderProtocol[] {
  return [...registry.keys()];
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
 * guarantee that replaces the old `default`-bearing switches.
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

for (const protocol of PROVIDER_PROTOCOLS) {
  registerProtocol(protocol, BUILTIN_PROTOCOLS[protocol]);
}

/**
 * Startup guard: throws if any known protocol lacks a registration.
 *
 * The `Record<ProviderProtocol, …>` typing of {@link BUILTIN_PROTOCOLS}
 * already enforces this at compile time; this runtime assertion catches
 * the case where a protocol is registered dynamically (or de-registered)
 * and lets a host fail fast at boot rather than degrade silently mid-turn.
 */
export function assertProtocolRegistryComplete(): void {
  const missing = PROVIDER_PROTOCOLS.filter((p) => !registry.has(p));
  if (missing.length > 0) {
    throw new Error(
      `ProtocolRegistry incomplete: no definition for ${missing.join(", ")}.`,
    );
  }
}
