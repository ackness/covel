import { getSettings } from "@/settings/store";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";
import {
  buildProviderKeysHeader,
  buildSlotConfigHeaderInternal,
} from "./model-settings.js";
import { request } from "./request.js";

// -- LLM Config -------------------------------------------------

export type InputModality = "text" | "image" | "audio" | "video" | "file";
export type OutputModality = "text" | "image" | "audio" | "embedding";
export type ModelFeature =
  | "function_calling"
  | "structured_output"
  | "streaming"
  | "reasoning"
  | "vision"
  | "prompt_caching"
  | "web_search"
  | "computer_use";

export interface ModelPricing {
  inputPerMToken?: number;
  outputPerMToken?: number;
  imageInputPerMToken?: number;
  audioInputPerMToken?: number;
  audioOutputPerMToken?: number;
  perImage?: number;
}

export interface ModelCapabilityInfo {
  input: InputModality[];
  output: OutputModality[];
  features?: ModelFeature[];
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing?: ModelPricing;
}

export interface LlmSlotInfo {
  provider: string;
  model: string;
  protocol: string;
  fallback?: string;
  tag: string;
  capability?: ModelCapabilityInfo;
}

export interface LlmConfigResponse {
  configured: boolean;
  slots: Record<string, LlmSlotInfo>;
  providers: string[];
  /** Present only when the last llm.toml load failed to parse (fell back to default). */
  error?: string;
}

export async function fetchLlmConfig(): Promise<LlmConfigResponse> {
  return request<LlmConfigResponse>("/api/llm-config");
}

export interface LlmReloadResult {
  /** true when llm.toml parsed (or is absent → default); false when a present file failed to parse. */
  ok: boolean;
  /** Slot names active after the reload. */
  slots: string[];
  /** Parse error message when `ok` is false. */
  error?: string;
}

/**
 * Re-read llm.toml on the server and apply it to the live gateway without a
 * restart. On desktop the request carries the REST bearer token (the endpoint
 * is auth-gated there); dev/web tiers stay open. Callers should refetch
 * `fetchLlmConfig()` afterwards to refresh the slot picker.
 */
export async function reloadLlmConfig(): Promise<LlmReloadResult> {
  return request<LlmReloadResult>("/api/llm-config/reload", {
    method: "POST",
    headers: getDesktopRestAuthHeaders(),
  });
}

// -- Model Database API -------------------------------------------

export interface ModelDbInfo {
  available: boolean;
  updatedAt?: string;
  count?: number;
  source?: string;
}

export interface ModelDbSearchResult {
  id: string;
  input: InputModality[];
  output: OutputModality[];
  features: ModelFeature[];
  contextWindow: number;
  maxOutputTokens: number;
  mode: string;
  inputPerMToken?: number;
  outputPerMToken?: number;
}

export async function fetchModelDbInfo(): Promise<ModelDbInfo> {
  return request<ModelDbInfo>("/api/model-db");
}

export async function searchModelDb(
  query: string,
  limit = 20,
): Promise<ModelDbSearchResult[]> {
  const res = await request<{ results: ModelDbSearchResult[] }>(
    `/api/model-db/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return res.results;
}

export async function lookupModelCapability(
  model: string,
  provider?: string,
): Promise<ModelCapabilityInfo | null> {
  const params = new URLSearchParams({ model });
  if (provider) params.set("provider", provider);
  const res = await request<{
    found: boolean;
    capability?: ModelCapabilityInfo;
  }>(`/api/model-db/lookup?${params.toString()}`);
  return res.found ? (res.capability ?? null) : null;
}

export async function refreshModelDb(): Promise<{
  ok: boolean;
  count?: number;
  error?: string;
}> {
  return request<{ ok: boolean; count?: number; error?: string }>(
    "/api/model-db/refresh",
    {
      method: "POST",
    },
  );
}

// -- Capability Overrides -------------------------------------

export function getCapabilityOverrides(): Record<
  string,
  Partial<ModelCapabilityInfo>
> {
  return (
    getSettings().get<Record<string, Partial<ModelCapabilityInfo>>>(
      "llm.capabilityOverrides",
    ) ?? {}
  );
}

export function setCapabilityOverrides(
  overrides: Record<string, Partial<ModelCapabilityInfo>>,
): void {
  void getSettings().set("llm.capabilityOverrides", overrides);
}

/**
 * Merge server capability with user's local overrides.
 * User overrides take precedence for each field.
 */
export function mergeCapability(
  base: ModelCapabilityInfo | undefined,
  override: Partial<ModelCapabilityInfo> | undefined,
): ModelCapabilityInfo | undefined {
  if (!base && !override) return undefined;
  if (!override) return base;
  if (!base) return override as ModelCapabilityInfo;
  return {
    input: override.input ?? base.input,
    output: override.output ?? base.output,
    features: override.features ?? base.features,
    contextWindow: override.contextWindow ?? base.contextWindow,
    maxOutputTokens: override.maxOutputTokens ?? base.maxOutputTokens,
    pricing: override.pricing
      ? { ...base.pricing, ...override.pricing }
      : base.pricing,
  };
}

// -- Block Schemas -------------------------------------------------

export async function fetchBlockSchemas(): Promise<Record<string, unknown>> {
  const res = await request<{ schemas: Record<string, unknown> }>(
    "/api/block-schemas",
  );
  return res.schemas;
}

// -- AI Ping -------------------------------------------------------

/**
 * Which of the server's resolution rules picked the preset:
 *   - `direct`: exact presetId match
 *   - `slot`: `slot-<name>` -> client override or slotRegistry
 *   - `tag-fallback`: text-tag fallback (slot didn't exist -> first text preset)
 *   - `any`: last-resort "any enabled preset"
 *
 * UIs should flag `tag-fallback` / `any` when the user explicitly requested
 * a specific slot - it means that slot isn't actually configured.
 */
export type PingResolvedVia = "direct" | "slot" | "tag-fallback" | "any";

export interface PingTestedTarget {
  presetId: string;
  provider: string;
  model: string;
  baseUrl?: string;
  protocol?: string;
  resolvedVia: PingResolvedVia;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  ttfbMs?: number;
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
  /** Echoes the exact preset/baseUrl/model that was probed. Always present for resolved pings. */
  testedTarget?: PingTestedTarget;
}

/**
 * Send a minimal "hi" to a specific preset to test connectivity and latency.
 * Requires API keys in localStorage.
 */
export async function pingPreset(presetId: string): Promise<PingResult> {
  const res = await fetch("/api/ai/ping", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...buildProviderKeysHeader(),
      ...buildSlotConfigHeaderInternal({ includeCustomPresetIds: [presetId] }),
    },
    body: JSON.stringify({ presetId }),
  });
  return res.json() as Promise<PingResult>;
}
