/**
 * Capability resolver — merges data from multiple sources to produce
 * a complete ModelCapability for a given model.
 *
 * Priority order:
 * 1. Manual override from llm.toml (highest)
 * 2. Known model database (curated LiteLLM/OpenRouter data)
 * 3. Protocol-based defaults (lowest)
 */

import type {
  InputModality,
  OutputModality,
  ModelFeature,
  ModelCapability,
  ModelPricing,
  ProviderProtocol,
} from "../types.js";
import {
  BASE_CAPABILITY_DEFAULTS,
  getProtocolDefinition,
} from "../protocol-registry.js";
import {
  KNOWN_MODELS,
  MODEL_ALIASES,
  type KnownModelEntry,
} from "./known-models.js";
import type { ModelDatabase } from "./model-db.js";

// ── Manual Override (from llm.toml) ─────────────────────────────

/** Fields the user can set in llm.toml to manually override auto-inferred capabilities. */
export interface ManualCapabilityOverride {
  input?: InputModality[];
  output?: OutputModality[];
  features?: ModelFeature[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: Partial<ModelPricing>;
}

// ── Lookup ───────────────────────────────────────────────────────

/**
 * Look up a model in the known database.
 *
 * Tries multiple patterns:
 * 1. Exact match on model ID (e.g. "deepseek-chat")
 * 2. Alias resolution (e.g. "deepseek-v3" → "deepseek-chat")
 * 3. Provider-prefixed match (e.g. "groq/llama-3.3-70b-versatile")
 * 4. Prefix match — find the longest key that starts with the model ID
 */
export function lookupKnownModel(
  modelId: string,
  provider?: string,
): KnownModelEntry | null {
  const normalized = modelId.toLowerCase();

  // 1. Direct match
  const direct = KNOWN_MODELS.get(normalized);
  if (direct) return direct;

  // 2. Alias resolution
  const aliasTarget = MODEL_ALIASES.get(normalized);
  if (aliasTarget) {
    const aliased = KNOWN_MODELS.get(aliasTarget);
    if (aliased) return aliased;
  }

  // 3. Provider-prefixed match
  if (provider) {
    const prefixed = KNOWN_MODELS.get(
      `${provider.toLowerCase()}/${normalized}`,
    );
    if (prefixed) return prefixed;
  }

  // 4. Prefix match (e.g. "qwen-plus-2025-01-01" matches "qwen-plus")
  let bestMatch: KnownModelEntry | null = null;
  let bestLength = 0;
  for (const [key, entry] of KNOWN_MODELS) {
    if (normalized.startsWith(key) && key.length > bestLength) {
      bestMatch = entry;
      bestLength = key.length;
    }
  }
  if (bestMatch) return bestMatch;

  // 5. Try alias prefix match
  for (const [alias, target] of MODEL_ALIASES) {
    if (normalized.startsWith(alias) && alias.length > bestLength) {
      const entry = KNOWN_MODELS.get(target);
      if (entry) {
        bestMatch = entry;
        bestLength = alias.length;
      }
    }
  }

  return bestMatch;
}

// ── Protocol Defaults ────────────────────────────────────────────

/** Deep-ish copy so callers can freely treat the result as their own. */
function cloneCapability(cap: ModelCapability): ModelCapability {
  const clone: ModelCapability = {
    ...cap,
    input: [...cap.input],
    output: [...cap.output],
  };
  if (cap.features) clone.features = [...cap.features];
  if (cap.pricing) clone.pricing = { ...cap.pricing };
  return clone;
}

/**
 * Sensible defaults when no data source matches.
 *
 * Per-protocol capability defaults live in the protocol registry; an
 * unknown/unset protocol falls back to the shared base. Returns a fresh
 * copy each call so downstream mutation never leaks into the registry.
 */
function getProtocolDefaults(protocol?: ProviderProtocol): ModelCapability {
  const defaults =
    (protocol ? getProtocolDefinition(protocol)?.capabilityDefaults : null) ??
    BASE_CAPABILITY_DEFAULTS;
  return cloneCapability(defaults);
}

// ── Resolver ─────────────────────────────────────────────────────

/** Global model database reference. Set via `setModelDatabase()`. */
let _modelDb: ModelDatabase | null = null;

/** Register a ModelDatabase for the resolver to use as secondary lookup source. */
export function setModelDatabase(db: ModelDatabase | null): void {
  _modelDb = db;
}

/** Get the current ModelDatabase (if registered). */
export function getModelDatabase(): ModelDatabase | null {
  return _modelDb;
}

/**
 * Resolve the full ModelCapability for a model.
 *
 * Priority order:
 * 1. Manual override from llm.toml (highest)
 * 2. Hand-curated known-models.ts (fast, always available)
 * 3. LiteLLM full database (bundled + dynamically updated)
 * 4. Protocol-based defaults (lowest)
 *
 * @param modelId - The model ID (e.g. "deepseek-chat", "gpt-4o")
 * @param provider - Optional provider hint for disambiguation
 * @param protocol - Protocol for default fallback
 * @param manual - Optional manual override from llm.toml
 */
export function resolveCapability(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol,
  manual?: ManualCapabilityOverride,
): ModelCapability {
  // Start with protocol defaults
  const defaults = getProtocolDefaults(protocol);

  // Try hand-curated known models first (fast, reliable)
  const known = lookupKnownModel(modelId, provider);
  let base: ModelCapability;

  if (known) {
    base = {
      input: known.input,
      output: known.output,
      features: known.features,
      contextWindow: known.contextWindow,
      maxOutputTokens: known.maxOutputTokens,
      pricing: known.pricing,
    };
  } else if (_modelDb) {
    // Fall back to full LiteLLM database
    const dbEntry = _modelDb.lookup(modelId, provider);
    base = dbEntry ? _modelDb.toCapability(dbEntry) : defaults;
  } else {
    base = defaults;
  }

  // Apply manual overrides (highest priority)
  if (!manual) return base;

  return {
    input: manual.input ?? base.input,
    output: manual.output ?? base.output,
    features: manual.features ?? base.features,
    contextWindow: manual.contextWindow ?? base.contextWindow,
    maxOutputTokens: manual.maxOutputTokens ?? base.maxOutputTokens,
    pricing: manual.pricing
      ? { ...base.pricing, ...manual.pricing }
      : base.pricing,
  };
}
