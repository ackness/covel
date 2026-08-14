/**
 * ModelDatabase — loads from the bundled LiteLLM-derived JSON and supports
 * runtime updates (from GitHub fetch or manual edits).
 *
 * The database is lazy-loaded on first access. Updates can be persisted to
 * an external store (IndexedDB in browser, PostgreSQL on server) via the
 * provided persistence hooks.
 */

import type {
  InputModality,
  OutputModality,
  ModelFeature,
  ModelCapability,
  ModelPricing,
} from "../types.js";
import {
  modelLookupCandidateDetails,
  type ModelMatchKind,
} from "./model-identity.js";

// ── Types ────────────────────────────────────────────────────────

/** A single entry in the model database (matches data/model-db.json format). */
export interface ModelDbEntry {
  input: InputModality[];
  output: OutputModality[];
  features: ModelFeature[];
  contextWindow: number;
  maxOutputTokens: number;
  mode: string;
  litellmProvider?: string;
  inputPerMToken?: number;
  outputPerMToken?: number;
  perImage?: number;
  audioInputPerMToken?: number;
  audioOutputPerMToken?: number;
}

/** The bundled JSON file shape. */
export interface ModelDbFile {
  updatedAt: string;
  source: string;
  count: number;
  models: Record<string, ModelDbEntry>;
}

/** Persistence interface — implement to store model DB in IndexedDB or PostgreSQL. */
export interface ModelDbPersistence {
  load(): Promise<ModelDbFile | null>;
  save(db: ModelDbFile): Promise<void>;
}

export interface ModelDbMatch {
  readonly id: string;
  readonly entry: ModelDbEntry;
  readonly kind: ModelMatchKind;
}

// ── ModelDatabase ────────────────────────────────────────────────

export interface ModelDatabase {
  /** Get the database metadata. */
  getInfo(): { updatedAt: string; count: number; source: string } | null;

  /** Look up a model by ID. Supports fuzzy matching (prefix, provider/model). */
  lookup(modelId: string, provider?: string): ModelDbEntry | null;

  /** Same lookup with the database key and match strategy for UI diagnostics. */
  lookupMatch(modelId: string, provider?: string): ModelDbMatch | null;

  /** Convert a ModelDbEntry to our ModelCapability format. */
  toCapability(entry: ModelDbEntry): ModelCapability;

  /** Search models by prefix or substring. Returns up to `limit` matches. */
  search(
    query: string,
    limit?: number,
  ): Array<{ id: string; entry: ModelDbEntry }>;

  /** Get all models (for export or bulk display). */
  listAll(): Record<string, ModelDbEntry>;

  /** Update a single model entry (user override). */
  upsert(modelId: string, entry: ModelDbEntry): void;

  /** Refresh the entire database from raw data (e.g. fetched from GitHub). */
  replaceAll(db: ModelDbFile): void;

  /** Persist current state to external store. */
  persist(): Promise<void>;

  /** Total model count. */
  readonly count: number;
}

/**
 * Create a ModelDatabase instance.
 *
 * @param bundledData - The bundled model-db.json data (imported statically or loaded)
 * @param persistence - Optional persistence layer for dynamic updates
 */
export function createModelDatabase(
  bundledData: ModelDbFile,
  persistence?: ModelDbPersistence,
): ModelDatabase & { ready: Promise<void> } {
  let data: ModelDbFile = bundledData;
  let dirty = false;

  // Try loading persisted data (may override bundled if newer)
  let persistedLoaded = false;
  const loadPersisted = async () => {
    if (persistedLoaded || !persistence) return;
    persistedLoaded = true;
    const persisted = await persistence.load();
    if (persisted && persisted.updatedAt > data.updatedAt) {
      data = persisted;
    }
  };

  // Eagerly start loading persisted data; callers can await `ready` to avoid races
  const readyPromise = loadPersisted();

  function lookupMatch(
    modelId: string,
    provider?: string,
  ): ModelDbMatch | null {
    const candidates = modelLookupCandidateDetails(modelId, provider);

    // Exact candidate match. This covers both bare IDs and provider/model IDs
    // stored verbatim by LiteLLM.
    for (const candidate of candidates) {
      const direct = data.models[candidate.id];
      if (direct)
        return { id: candidate.id, entry: direct, kind: candidate.kind };
    }

    // Some databases only carry a provider-prefixed key for a bare request ID.
    const providerId = provider?.trim().toLowerCase();
    if (providerId) {
      for (const candidate of candidates) {
        const key = `${providerId}/${candidate.id}`;
        const entry = data.models[key];
        if (entry) return { id: key, entry, kind: candidate.kind };
      }
    }

    // Match a canonical database key by its trailing model name.
    for (const candidate of candidates) {
      for (const [key, entry] of Object.entries(data.models)) {
        const modelPart = key.split("/").at(-1);
        if (modelPart === candidate.id) {
          return { id: key, entry, kind: candidate.kind };
        }
      }
    }

    // Versioned IDs may extend a stable database key with a date/snapshot.
    let bestMatch: ModelDbMatch | null = null;
    let bestLength = 0;
    for (const candidate of candidates) {
      for (const [key, entry] of Object.entries(data.models)) {
        const modelPart = key.split("/").at(-1) ?? key;
        if (
          candidate.id.startsWith(modelPart) &&
          modelPart.length > bestLength
        ) {
          bestMatch = { id: key, entry, kind: "prefix" };
          bestLength = modelPart.length;
        }
      }
    }

    return bestMatch;
  }

  function lookup(modelId: string, provider?: string): ModelDbEntry | null {
    return lookupMatch(modelId, provider)?.entry ?? null;
  }

  function toCapability(entry: ModelDbEntry): ModelCapability {
    const pricing: ModelPricing | undefined =
      (entry.inputPerMToken ??
      entry.outputPerMToken ??
      entry.perImage ??
      entry.audioInputPerMToken ??
      entry.audioOutputPerMToken)
        ? {
            ...(entry.inputPerMToken != null
              ? { inputPerMToken: entry.inputPerMToken }
              : {}),
            ...(entry.outputPerMToken != null
              ? { outputPerMToken: entry.outputPerMToken }
              : {}),
            ...(entry.perImage != null ? { perImage: entry.perImage } : {}),
            ...(entry.audioInputPerMToken != null
              ? { audioInputPerMToken: entry.audioInputPerMToken }
              : {}),
            ...(entry.audioOutputPerMToken != null
              ? { audioOutputPerMToken: entry.audioOutputPerMToken }
              : {}),
          }
        : undefined;

    return {
      input: entry.input,
      output: entry.output,
      features: entry.features,
      contextWindow: entry.contextWindow || undefined,
      maxOutputTokens: entry.maxOutputTokens || undefined,
      pricing,
    };
  }

  function search(
    query: string,
    limit = 20,
  ): Array<{ id: string; entry: ModelDbEntry }> {
    const q = query.toLowerCase();
    const results: Array<{ id: string; entry: ModelDbEntry; score: number }> =
      [];

    for (const [id, entry] of Object.entries(data.models)) {
      const idLower = id.toLowerCase();
      if (idLower === q) {
        results.push({ id, entry, score: 100 });
      } else if (idLower.startsWith(q)) {
        results.push({ id, entry, score: 80 });
      } else if (idLower.includes(q)) {
        results.push({ id, entry, score: 50 });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ id, entry }) => ({ id, entry }));
  }

  function upsert(modelId: string, entry: ModelDbEntry): void {
    data = {
      ...data,
      models: { ...data.models, [modelId]: entry },
      count: Object.keys(data.models).length + (data.models[modelId] ? 0 : 1),
    };
    dirty = true;
  }

  function replaceAll(db: ModelDbFile): void {
    data = db;
    dirty = true;
  }

  async function persist(): Promise<void> {
    if (!persistence || !dirty) return;
    await persistence.save(data);
    dirty = false;
  }

  return {
    getInfo: () => ({
      updatedAt: data.updatedAt,
      count: data.count,
      source: data.source,
    }),
    lookup,
    lookupMatch,
    toCapability,
    search,
    listAll: () => data.models,
    upsert,
    replaceAll,
    persist,
    get count() {
      return data.count;
    },
    ready: readyPromise,
  };
}

// ── LiteLLM GitHub Fetch ─────────────────────────────────────────

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Fetch the latest LiteLLM model data from GitHub and transform it.
 * Returns a ModelDbFile ready to be passed to `replaceAll()`.
 */
export async function fetchLiteLlmModels(
  url = LITELLM_URL,
): Promise<ModelDbFile> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    throw new Error(
      `Failed to fetch LiteLLM models: ${res.status} ${res.statusText}`,
    );
  }

  const raw = (await res.json()) as Record<string, Record<string, unknown>>;
  const models: Record<string, ModelDbEntry> = {};

  for (const [key, entry] of Object.entries(raw)) {
    if (key === "sample_spec" || key.startsWith("sample_spec")) continue;
    const transformed = transformLiteLlmEntry(entry);
    if (transformed) models[key] = transformed;
  }

  return {
    updatedAt: new Date().toISOString(),
    source: url,
    count: Object.keys(models).length,
    models,
  };
}

function transformLiteLlmEntry(
  raw: Record<string, unknown>,
): ModelDbEntry | null {
  const mode = (raw.mode as string) ?? "chat";
  const input = deriveInput(raw, mode);
  const output = deriveOutput(raw, mode);
  const features = deriveFeatures(raw);

  const entry: ModelDbEntry = {
    input,
    output,
    features,
    contextWindow:
      (raw.max_input_tokens as number) ?? (raw.max_tokens as number) ?? 0,
    maxOutputTokens:
      (raw.max_output_tokens as number) ?? (raw.max_tokens as number) ?? 0,
    mode,
  };

  if (raw.litellm_provider)
    entry.litellmProvider = raw.litellm_provider as string;
  if (raw.input_cost_per_token)
    entry.inputPerMToken = roundPrice(
      (raw.input_cost_per_token as number) * 1e6,
    );
  if (raw.output_cost_per_token)
    entry.outputPerMToken = roundPrice(
      (raw.output_cost_per_token as number) * 1e6,
    );
  if (raw.input_cost_per_image)
    entry.perImage = raw.input_cost_per_image as number;
  if (raw.input_cost_per_audio_token)
    entry.audioInputPerMToken = roundPrice(
      (raw.input_cost_per_audio_token as number) * 1e6,
    );
  if (raw.output_cost_per_audio_token)
    entry.audioOutputPerMToken = roundPrice(
      (raw.output_cost_per_audio_token as number) * 1e6,
    );

  return entry;
}

function deriveInput(
  raw: Record<string, unknown>,
  mode: string,
): InputModality[] {
  const explicit = raw.supported_modalities as string[] | undefined;
  if (explicit?.length)
    return explicit.filter((s): s is InputModality =>
      ["text", "image", "audio", "video", "file"].includes(s),
    );

  const m: InputModality[] = [];
  switch (mode) {
    case "chat":
    case "completion":
    case "responses":
      m.push("text");
      if (raw.supports_vision) m.push("image");
      if (raw.supports_audio_input) m.push("audio");
      if (raw.supports_pdf_input) m.push("file");
      break;
    case "audio_transcription":
      m.push("audio");
      break;
    case "audio_speech":
    case "image_generation":
    case "video_generation":
      m.push("text");
      break;
    case "image_edit":
      m.push("text", "image");
      break;
    case "embedding":
      m.push("text");
      break;
    case "ocr":
      m.push("image");
      break;
    case "realtime":
      m.push("text", "audio");
      break;
    default:
      m.push("text");
  }
  return m;
}

function deriveOutput(
  raw: Record<string, unknown>,
  mode: string,
): OutputModality[] {
  const explicit = raw.supported_output_modalities as string[] | undefined;
  if (explicit?.length)
    return explicit.filter((s): s is OutputModality =>
      ["text", "image", "audio", "video", "embedding"].includes(s),
    );

  switch (mode) {
    case "chat":
    case "completion":
    case "responses": {
      const o: OutputModality[] = ["text"];
      if (raw.supports_audio_output) o.push("audio");
      return o;
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
    case "video_generation":
      return ["video"];
    case "embedding":
      return ["embedding"];
    default:
      return ["text"];
  }
}

function deriveFeatures(raw: Record<string, unknown>): ModelFeature[] {
  const f: ModelFeature[] = [];
  if (raw.supports_function_calling) f.push("function_calling");
  if (raw.supports_response_schema) f.push("structured_output");
  if (raw.supports_streaming !== false) f.push("streaming");
  if (raw.supports_reasoning) f.push("reasoning");
  if (raw.supports_vision) f.push("vision");
  if (raw.supports_prompt_caching) f.push("prompt_caching");
  if (raw.supports_web_search) f.push("web_search");
  if (raw.supports_computer_use) f.push("computer_use");
  return f;
}

function roundPrice(n: number): number {
  if (n === 0) return 0;
  if (n < 0.001) return Number(n.toPrecision(3));
  if (n < 1) return Number(n.toFixed(4));
  return Number(n.toFixed(2));
}
