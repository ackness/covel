/**
 * Curated known-model database.
 *
 * The model entries are **data, not code** — they live in
 * `known-models.data.json` (generated from LiteLLM
 * model_prices_and_context_window.json + OpenRouter /v1/models). This module
 * only declares the entry type and turns the JSON into the `ReadonlyMap`
 * lookups that the resolver consumes.
 *
 * The JSON is imported inline (`resolveJsonModule`) rather than read from disk
 * at runtime, so it bundles cleanly into every build target (server, desktop
 * sidecar, browser) with no filesystem path assumptions.
 *
 * Taxonomy follows OpenRouter's directional approach:
 * - input modalities = what the model ACCEPTS
 * - output modalities = what the model PRODUCES
 *
 * "image" in input (vision) ≠ "image" in output (image generation).
 * "audio" in input (transcription/understanding) ≠ "audio" in output (speech synthesis).
 */

import type {
  InputModality,
  OutputModality,
  ModelFeature,
  ModelPricing,
} from "../types.js";
import knownModelsData from "./known-models.data.json" with { type: "json" };

// ── Known Model Entry ────────────────────────────────────────────

export interface KnownModelEntry {
  input: InputModality[];
  output: OutputModality[];
  features: ModelFeature[];
  contextWindow: number;
  maxOutputTokens: number;
  pricing?: ModelPricing;
}

/** Shape of `known-models.data.json` — entries plus alias map. */
interface KnownModelsFile {
  models: Record<string, KnownModelEntry>;
  aliases: Record<string, string>;
}

const data = knownModelsData as unknown as KnownModelsFile;

// ── Database ─────────────────────────────────────────────────────

/**
 * Key format: lowercase `model-id`.
 * Also supports `provider/model-id` for disambiguation.
 *
 * Lookup order in resolver: exact model → provider/model → prefix match.
 */
export const KNOWN_MODELS: ReadonlyMap<string, KnownModelEntry> = new Map(
  Object.entries(data.models),
);

/**
 * Alias map: common model name variants → canonical key in KNOWN_MODELS.
 */
export const MODEL_ALIASES: ReadonlyMap<string, string> = new Map(
  Object.entries(data.aliases),
);
