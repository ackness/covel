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
import {
  modelLookupCandidateDetails,
  modelNamespace,
  type ModelMatchKind,
} from "./model-identity.js";

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
interface KnownModelMatch {
  readonly id: string;
  readonly entry: KnownModelEntry;
  readonly kind: ModelMatchKind;
}

function lookupKnownModel(
  modelId: string,
  provider?: string,
): KnownModelMatch | null {
  const candidates = modelLookupCandidateDetails(modelId, provider);

  for (const candidate of candidates) {
    const direct = KNOWN_MODELS.get(candidate.id);
    if (direct) {
      return { id: candidate.id, entry: direct, kind: candidate.kind };
    }
    const aliasTarget = MODEL_ALIASES.get(candidate.id);
    const aliased = aliasTarget ? KNOWN_MODELS.get(aliasTarget) : undefined;
    if (aliasTarget && aliased) {
      return { id: aliasTarget, entry: aliased, kind: candidate.kind };
    }
  }

  const providerId = provider?.trim().toLowerCase();
  if (providerId) {
    for (const candidate of candidates) {
      const key = `${providerId}/${candidate.id}`;
      const prefixed = KNOWN_MODELS.get(key);
      if (prefixed) return { id: key, entry: prefixed, kind: candidate.kind };
    }
  }

  // Versioned IDs may extend a stable known key with a date/snapshot suffix.
  let bestMatch: KnownModelMatch | null = null;
  let bestLength = 0;
  for (const candidate of candidates) {
    for (const [key, entry] of KNOWN_MODELS) {
      const modelPart = key.split("/").at(-1) ?? key;
      if (candidate.id.startsWith(modelPart) && modelPart.length > bestLength) {
        bestMatch = { id: key, entry, kind: "prefix" };
        bestLength = modelPart.length;
      }
    }
  }

  for (const candidate of candidates) {
    for (const [alias, target] of MODEL_ALIASES) {
      if (candidate.id.startsWith(alias) && alias.length > bestLength) {
        const entry = KNOWN_MODELS.get(target);
        if (entry) {
          bestMatch = { id: target, entry, kind: "prefix" };
          bestLength = alias.length;
        }
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

export type CapabilitySource = "known" | "model-database" | "protocol-default";

export type CapabilityPricingKind =
  "provider" | "reference" | "configured" | "unknown";

export interface CapabilityResolutionDetails {
  readonly capability: ModelCapability;
  readonly source: CapabilitySource;
  readonly matchedModelId?: string;
  readonly matchKind?: ModelMatchKind;
  readonly pricingKind: CapabilityPricingKind;
  readonly candidates: string[];
}

function pricingKindForMatch(args: {
  modelId: string;
  provider?: string;
  matchedProvider?: string;
  hasPricing: boolean;
  manualPricing: boolean;
}): CapabilityPricingKind {
  if (args.manualPricing) return "configured";
  if (!args.hasPricing) return "unknown";

  const providerId = args.provider?.trim().toLowerCase();
  const namespace = modelNamespace(args.modelId, args.provider);
  const matchedProvider = args.matchedProvider?.trim().toLowerCase();
  if (
    (namespace && providerId && namespace !== providerId) ||
    (matchedProvider && providerId && matchedProvider !== providerId)
  ) {
    return "reference";
  }
  return "provider";
}

/**
 * Resolve capabilities together with the identity match used to infer them.
 * The original model ID remains opaque and is never rewritten for requests.
 */
export function resolveCapabilityDetails(
  modelId: string,
  provider?: string,
  protocol?: ProviderProtocol,
  manual?: ManualCapabilityOverride,
): CapabilityResolutionDetails {
  const defaults = getProtocolDefaults(protocol);
  const candidates = modelLookupCandidateDetails(modelId, provider).map(
    (candidate) => candidate.id,
  );
  const known = lookupKnownModel(modelId, provider);
  const dbMatch = known
    ? null
    : (_modelDb?.lookupMatch(modelId, provider) ?? null);

  let base: ModelCapability;
  let source: CapabilitySource;
  let matchedModelId: string | undefined;
  let matchKind: ModelMatchKind | undefined;
  let matchedProvider: string | undefined;

  if (known) {
    base = {
      input: known.entry.input,
      output: known.entry.output,
      features: known.entry.features,
      contextWindow: known.entry.contextWindow,
      maxOutputTokens: known.entry.maxOutputTokens,
      pricing: known.entry.pricing,
    };
    source = "known";
    matchedModelId = known.id;
    matchKind = known.kind;
  } else if (dbMatch && _modelDb) {
    base = _modelDb.toCapability(dbMatch.entry);
    source = "model-database";
    matchedModelId = dbMatch.id;
    matchKind = dbMatch.kind;
    matchedProvider = dbMatch.entry.litellmProvider;
  } else {
    base = defaults;
    source = "protocol-default";
  }

  const capability = manual
    ? {
        input: manual.input ?? base.input,
        output: manual.output ?? base.output,
        features: manual.features ?? base.features,
        contextWindow: manual.contextWindow ?? base.contextWindow,
        maxOutputTokens: manual.maxOutputTokens ?? base.maxOutputTokens,
        pricing: manual.pricing
          ? { ...base.pricing, ...manual.pricing }
          : base.pricing,
      }
    : base;

  return {
    capability,
    source,
    ...(matchedModelId ? { matchedModelId } : {}),
    ...(matchKind ? { matchKind } : {}),
    pricingKind: pricingKindForMatch({
      modelId,
      provider,
      matchedProvider,
      hasPricing: capability.pricing !== undefined,
      manualPricing: manual?.pricing !== undefined,
    }),
    candidates,
  };
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
  return resolveCapabilityDetails(modelId, provider, protocol, manual)
    .capability;
}
