#!/usr/bin/env npx tsx
/**
 * Fetch the latest LiteLLM model_prices_and_context_window.json from GitHub,
 * transform it into our compact ModelDbEntry format, and write to data/model-db.json.
 *
 * Usage:
 *   npx tsx packages/ai-provider/scripts/update-model-db.ts
 *   # or via pnpm script:
 *   pnpm --filter @covel/ai-provider update-model-db
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = resolve(__dirname, "../data/model-db.json");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// ── Types ────────────────────────────────────────────────────────

type InputModality = "text" | "image" | "audio" | "video" | "file";
type OutputModality = "text" | "image" | "audio" | "embedding";
type ModelFeature =
  | "function_calling"
  | "structured_output"
  | "streaming"
  | "reasoning"
  | "vision"
  | "prompt_caching"
  | "web_search"
  | "computer_use";

interface ModelDbEntry {
  /** What the model accepts */
  input: InputModality[];
  /** What the model produces */
  output: OutputModality[];
  /** Feature flags */
  features: ModelFeature[];
  /** Max input tokens */
  contextWindow: number;
  /** Max output tokens */
  maxOutputTokens: number;
  /** LiteLLM mode (chat, image_generation, etc.) */
  mode: string;
  /** Provider from LiteLLM */
  litellmProvider?: string;
  /** Pricing: cost per 1M input tokens (USD) */
  inputPerMToken?: number;
  /** Pricing: cost per 1M output tokens (USD) */
  outputPerMToken?: number;
  /** Pricing: cost per image */
  perImage?: number;
  /** Pricing: audio input per 1M tokens */
  audioInputPerMToken?: number;
  /** Pricing: audio output per 1M tokens */
  audioOutputPerMToken?: number;
}

interface ModelDbFile {
  /** ISO timestamp of last update */
  updatedAt: string;
  /** Source URL */
  source: string;
  /** Number of models */
  count: number;
  /** Model entries keyed by model ID */
  models: Record<string, ModelDbEntry>;
}

// ── LiteLLM raw types ────────────────────────────────────────────

interface LiteLlmEntry {
  max_tokens?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  input_cost_per_image?: number;
  input_cost_per_audio_token?: number;
  output_cost_per_audio_token?: number;
  litellm_provider?: string;
  mode?: string;
  supports_function_calling?: boolean;
  supports_parallel_function_calling?: boolean;
  supports_vision?: boolean;
  supports_response_schema?: boolean;
  supports_prompt_caching?: boolean;
  supports_system_messages?: boolean;
  supports_tool_choice?: boolean;
  supports_streaming?: boolean;
  supports_audio_input?: boolean;
  supports_audio_output?: boolean;
  supports_pdf_input?: boolean;
  supports_reasoning?: boolean;
  supports_web_search?: boolean;
  supports_computer_use?: boolean;
  supported_modalities?: string[];
  supported_output_modalities?: string[];
  // ... other fields we don't need
}

// ── Transform ────────────────────────────────────────────────────

function transformEntry(key: string, raw: LiteLlmEntry): ModelDbEntry | null {
  const mode = raw.mode ?? "chat";

  // Skip sample/test entries
  if (key.startsWith("sample_spec") || key === "sample_spec") return null;

  // Build input modalities
  const input = deriveInputModalities(raw, mode);
  const output = deriveOutputModalities(raw, mode);
  const features = deriveFeatures(raw);

  const contextWindow = raw.max_input_tokens ?? raw.max_tokens ?? 0;
  const maxOutputTokens = raw.max_output_tokens ?? raw.max_tokens ?? 0;

  const entry: ModelDbEntry = {
    input,
    output,
    features,
    contextWindow,
    maxOutputTokens,
    mode,
  };

  if (raw.litellm_provider) entry.litellmProvider = raw.litellm_provider;

  // Pricing (convert per-token to per-million-token)
  if (raw.input_cost_per_token) {
    entry.inputPerMToken = roundPrice(raw.input_cost_per_token * 1_000_000);
  }
  if (raw.output_cost_per_token) {
    entry.outputPerMToken = roundPrice(raw.output_cost_per_token * 1_000_000);
  }
  if (raw.input_cost_per_image) {
    entry.perImage = raw.input_cost_per_image;
  }
  if (raw.input_cost_per_audio_token) {
    entry.audioInputPerMToken = roundPrice(
      raw.input_cost_per_audio_token * 1_000_000,
    );
  }
  if (raw.output_cost_per_audio_token) {
    entry.audioOutputPerMToken = roundPrice(
      raw.output_cost_per_audio_token * 1_000_000,
    );
  }

  return entry;
}

function deriveInputModalities(
  raw: LiteLlmEntry,
  mode: string,
): InputModality[] {
  // Use explicit arrays if available
  if (raw.supported_modalities && raw.supported_modalities.length > 0) {
    return raw.supported_modalities.filter(isInputModality);
  }

  // Derive from mode + boolean flags
  const modalities: InputModality[] = [];

  switch (mode) {
    case "chat":
    case "completion":
    case "responses":
      modalities.push("text");
      if (raw.supports_vision) modalities.push("image");
      if (raw.supports_audio_input) modalities.push("audio");
      if (raw.supports_pdf_input) modalities.push("file");
      break;
    case "audio_transcription":
      modalities.push("audio");
      break;
    case "audio_speech":
      modalities.push("text");
      break;
    case "image_generation":
      modalities.push("text");
      break;
    case "image_edit":
      modalities.push("text", "image");
      break;
    case "embedding":
      modalities.push("text");
      break;
    case "video_generation":
      modalities.push("text");
      break;
    case "ocr":
      modalities.push("image");
      break;
    case "realtime":
      modalities.push("text", "audio");
      break;
    default:
      modalities.push("text");
  }

  return modalities;
}

function deriveOutputModalities(
  raw: LiteLlmEntry,
  mode: string,
): OutputModality[] {
  // Use explicit arrays if available
  if (
    raw.supported_output_modalities &&
    raw.supported_output_modalities.length > 0
  ) {
    return raw.supported_output_modalities.filter(isOutputModality);
  }

  // Derive from mode + boolean flags
  switch (mode) {
    case "chat":
    case "completion":
    case "responses": {
      const out: OutputModality[] = ["text"];
      if (raw.supports_audio_output) out.push("audio");
      return out;
    }
    case "audio_transcription":
    case "ocr":
      return ["text"];
    case "audio_speech":
    case "realtime":
      return ["audio"];
    case "image_generation":
    case "image_edit":
      return ["image"];
    case "embedding":
      return ["embedding"];
    case "video_generation":
      return ["text"]; // video not in our OutputModality, degrade to text
    default:
      return ["text"];
  }
}

function deriveFeatures(raw: LiteLlmEntry): ModelFeature[] {
  const features: ModelFeature[] = [];
  if (raw.supports_function_calling) features.push("function_calling");
  if (raw.supports_response_schema) features.push("structured_output");
  if (raw.supports_streaming !== false) features.push("streaming"); // default true for chat
  if (raw.supports_reasoning) features.push("reasoning");
  if (raw.supports_vision) features.push("vision");
  if (raw.supports_prompt_caching) features.push("prompt_caching");
  if (raw.supports_web_search) features.push("web_search");
  if (raw.supports_computer_use) features.push("computer_use");
  return features;
}

function isInputModality(s: string): s is InputModality {
  return ["text", "image", "audio", "video", "file"].includes(s);
}

function isOutputModality(s: string): s is OutputModality {
  return ["text", "image", "audio", "embedding"].includes(s);
}

function roundPrice(n: number): number {
  if (n === 0) return 0;
  if (n < 0.001) return Number(n.toPrecision(3));
  if (n < 1) return Number(n.toFixed(4));
  return Number(n.toFixed(2));
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching LiteLLM model database from:\n  ${LITELLM_URL}\n`);

  const res = await fetch(LITELLM_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch: ${res.status} ${res.statusText}`);
  }

  const raw = (await res.json()) as Record<string, LiteLlmEntry>;

  const models: Record<string, ModelDbEntry> = {};
  let skipped = 0;

  for (const [key, entry] of Object.entries(raw)) {
    const transformed = transformEntry(key, entry);
    if (transformed) {
      models[key] = transformed;
    } else {
      skipped++;
    }
  }

  const db: ModelDbFile = {
    updatedAt: new Date().toISOString(),
    source: LITELLM_URL,
    count: Object.keys(models).length,
    models,
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(db, null, 2), "utf-8");

  console.log(`Done! Written ${db.count} models to data/model-db.json`);
  if (skipped > 0) console.log(`  (skipped ${skipped} invalid/test entries)`);

  // Print some stats
  const modes = new Map<string, number>();
  for (const m of Object.values(models)) {
    modes.set(m.mode, (modes.get(m.mode) ?? 0) + 1);
  }
  console.log("\nMode distribution:");
  for (const [mode, count] of [...modes.entries()].sort(
    (a, b) => b[1] - a[1],
  )) {
    console.log(`  ${mode}: ${count}`);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
