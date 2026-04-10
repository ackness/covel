/**
 * API client for communicating with the Covel server.
 */

import type { I18nText } from "@covel/shared";
import { sanitizeRuntimeBindingsForHeader } from "../lib/runtime-binding-utils.js";

// ── Types ──────────────────────────────────────────────────────────

export interface WorldRecord {
  id: string;
  name: I18nText;
  description: I18nText;
  lore?: I18nText;
  locale?: string;
  tags?: string[];
  dimensions?: import("@covel/shared").WorldDimensions;
  createdAt: string;
  updatedAt?: string;
}

export type SessionPhase = "init" | "character_creation" | "playing" | "ended";

export interface SessionRecord {
  id: string;
  worldId: string;
  status: "active" | "waiting_for_input" | "archived";
  phase: SessionPhase;
  presetId?: string;
  taskBindings?: Record<string, string>;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: "system" | "user" | "assistant";
  content: string;
  turnId?: string;
  runtimeId?: string;
  /** Runtime kind (e.g. "story", "plugin") — used to filter display on restore. */
  kind?: string;
  block?: Record<string, unknown>;
  createdAt: string;
}

export interface StatePatchRecord {
  id: string;
  sessionId: string;
  summary: string;
  packageName: string;
  data?: unknown;
  createdAt: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
}

export interface RuntimeSummary {
  id: string;
  kind: string;
  priority: number;
  trigger: { mode: string; onEvents?: string[] };
  providerTag?: string;
}

export interface ToolSummary {
  id: string;
  kind: string;
}

export interface PackageSummary {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  enabled: boolean;
  runtimes?: RuntimeSummary[];
  tools?: ToolSummary[];
  requires?: string[];
  version?: string;
  author?: string;
}

export interface CommandSummary {
  name: string;
  pluginId: string;
  description: string;
  usage?: string;
  examples?: string[];
  positionalHints?: string[];
  flagHints?: Record<string, string>;
}

export interface SseEnvelope {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

// ── Storage Keys ──────────────────────────────────────────────────

const SLOT_CONFIG_KEY = "covel:slotConfig";
const CUSTOM_PRESETS_KEY = "covel:customPresets";
const PARAM_OVERRIDES_KEY = "covel:paramOverrides";

// ── Helpers ────────────────────────────────────────────────────────

/** Routes that need the provider API keys header. */
const AI_ROUTES = ["/api/actions", "/api/ai/", "/api/kernel/"];

function needsProviderKeys(url: string): boolean {
  return AI_ROUTES.some((prefix) => url.startsWith(prefix));
}

function buildProviderKeysHeader(): Record<string, string> {
  const stored = localStorage.getItem("covel:providerKeys");
  const headers: Record<string, string> = {};
  let keys: Record<string, string> = {};
  if (stored) {
    try {
      keys = JSON.parse(stored);
    } catch {
      // skip
    }
  }
  // Merge API keys from custom presets (custom preset key overrides global for same provider)
  const customPresets = getCustomPresets();
  for (const preset of customPresets) {
    if (preset.apiKey?.trim() && preset.provider) {
      keys[preset.provider] = preset.apiKey.trim();
    }
  }
  if (Object.keys(keys).length > 0) {
    headers["X-Provider-Keys"] = btoa(JSON.stringify(keys));
  }
  return headers;
}

function buildAiHeaders(sessionId?: string): Record<string, string> {
  return {
    ...buildProviderKeysHeader(),
    ...buildSlotConfigHeaderInternal(sessionId),
  };
}

function buildSlotConfigHeaderInternal(sessionId?: string): Record<string, string> {
  const slotConfigRaw = localStorage.getItem(SLOT_CONFIG_KEY);
  const paramOverridesRaw = localStorage.getItem(PARAM_OVERRIDES_KEY);
  let slotConfig: Record<string, SlotConfigEntry> = {};
  let overrides: Record<string, unknown> = {};
  try {
    slotConfig = slotConfigRaw ? JSON.parse(slotConfigRaw) : {};
  } catch {
    slotConfig = {};
  }
  try {
    overrides = paramOverridesRaw ? JSON.parse(paramOverridesRaw) : {};
  } catch {
    overrides = {};
  }

  const slotPresetOverrides = Object.fromEntries(
    Object.entries(slotConfig)
      .filter(([, entry]) => typeof entry?.presetId === "string" && entry.presetId.length > 0)
      .map(([slotId, entry]) => [slotId, entry.presetId]),
  );

  // Include custom preset definitions for any custom presets referenced by slot overrides.
  const customPresets = getCustomPresets();
  const referencedCustomIds = new Set(
    Object.values(slotPresetOverrides)
      .filter((id) => id?.startsWith("custom_"))
  );
  const customPresetDefs = customPresets
    .filter((p) => referencedCustomIds.has(p.id))
    .map(({ id, name, provider, baseUrl, model, protocol }) => ({
      id, name, provider, baseUrl, model, protocol,
    }));

  // Include runtime priority overrides (qualified "pluginId:runtimeId" → number)
  const runtimePriority = getRuntimePriorityOverrides();

  // Include per-session runtime bindings (qualifiedRuntimeId → slotName)
  const runtimeBindings = sessionId
    ? sanitizeRuntimeBindingsForHeader(getRuntimeBindings(sessionId))
    : {};

  const hasSlotPresetOverrides = Object.keys(slotPresetOverrides).length > 0;
  const hasOverrides = Object.keys(overrides).length > 0;
  const hasCustom = customPresetDefs.length > 0;
  const hasPriority = Object.keys(runtimePriority).length > 0;
  const hasBindings = Object.keys(runtimeBindings).length > 0;
  if (!hasSlotPresetOverrides && !hasOverrides && !hasCustom && !hasPriority && !hasBindings) return {};
  return {
    "X-Slot-Config": btoa(JSON.stringify({
      ...(hasSlotPresetOverrides ? { slotPresetOverrides } : {}),
      ...(hasOverrides ? { paramOverrides: overrides } : {}),
      ...(hasCustom ? { customPresets: customPresetDefs } : {}),
      ...(hasPriority ? { runtimePriority } : {}),
      ...(hasBindings ? { runtimeBindings } : {}),
    })),
  };
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(needsProviderKeys(url) ? buildAiHeaders() : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json();
}

// ── World API ──────────────────────────────────────────────────────

export async function listWorlds(): Promise<WorldRecord[]> {
  const res = await request<{ items: WorldRecord[] } | WorldRecord[]>("/api/worlds");
  return Array.isArray(res) ? res : res.items;
}

export async function getWorld(id: string): Promise<WorldRecord> {
  return request<WorldRecord>(`/api/worlds/${encodeURIComponent(id)}`);
}

export async function createWorld(name: string, description: string, id?: string): Promise<WorldRecord> {
  return request<WorldRecord>("/api/worlds", {
    method: "POST",
    body: JSON.stringify({ id, name, description }),
  });
}

export async function updateWorld(
  id: string,
  patch: Partial<Pick<WorldRecord, "name" | "description" | "lore" | "locale" | "tags" | "dimensions">>,
): Promise<WorldRecord> {
  return request<WorldRecord>(`/api/worlds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ── AI World Generation ──────────────────────────────────────────────

export interface GenerateWorldProgress {
  type: "progress";
  phase: "generating" | "validating" | "saving";
}

export interface GenerateWorldDone {
  type: "done";
  world: WorldRecord;
}

export interface GenerateWorldError {
  type: "error";
  message: string;
}

export type GenerateWorldEvent = GenerateWorldProgress | GenerateWorldDone | GenerateWorldError;

/**
 * Generate a world via AI from a text prompt.
 * Returns an AbortController to cancel the stream.
 */
export function generateWorld(
  prompt: string,
  locale: string,
  onEvent: (event: GenerateWorldEvent) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/ai/generate-world", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
        },
        body: JSON.stringify({ prompt, locale }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data) {
              try {
                const event = JSON.parse(data) as GenerateWorldEvent;
                onEvent(event);
              } catch {
                // skip malformed
              }
            }
          }
        }
      }

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

// ── Session Plugin API ─────────────────────────────────────────────

export interface SessionPluginInfo {
  id: string;
  displayName: I18nText;
  description?: I18nText;
  isActive: boolean;
  /** Core plugins that are always required and cannot be disabled. */
  locked?: boolean;
  pluginType?: string;
  /** Plugin load status: 'registered' = ok, 'error' = failed to load. */
  status?: string;
  /** Error message when status is 'error'. */
  error?: string;
  priority?: number;
  runtimeType?: string;
  model?: string;
  /** How the framework treats this plugin's output in the UI ('story' | 'plugin' | 'system'). */
  outputKind?: string;
  /** Capability tags declared by this plugin (e.g. 'image-generation', 'world-data-provider'). */
  capabilities?: string[];
  trigger?: { type: string; interval?: number; maxTriggerCount?: number; cooldownTurns?: number };
  tools?: { builtin: string[]; local: string[] };
  config?: Record<string, { type: string; default?: unknown; label?: string; description?: string; options?: string[] }>;
}

export interface SessionPluginsResponse {
  active: string[];
  available: SessionPluginInfo[];
}

/** Fetch the active + available plugins for a session. */
export async function listSessionPlugins(sessionId: string): Promise<SessionPluginsResponse> {
  return request<SessionPluginsResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/plugins`);
}

/** Enable a plugin for a session. Returns updated active list. */
export async function enableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<{ ok: boolean; active: string[] }> {
  return request<{ ok: boolean; active: string[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/enable`,
    { method: "POST", body: JSON.stringify({ pluginId }) },
  );
}

/** Disable a plugin for a session. Returns updated active list. */
export async function disableSessionPlugin(
  sessionId: string,
  pluginId: string,
): Promise<{ ok: boolean; active: string[] }> {
  return request<{ ok: boolean; active: string[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugins/disable`,
    { method: "POST", body: JSON.stringify({ pluginId }) },
  );
}

// ── Session API ────────────────────────────────────────────────────

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  const res = await request<{ items: SessionRecord[] } | SessionRecord[]>(`/api/sessions?worldId=${encodeURIComponent(worldId)}`);
  return Array.isArray(res) ? res : res.items;
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  return request<SessionRecord>(`/api/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
  return request<StatePatchRecord[]>(`/api/sessions/${encodeURIComponent(sessionId)}/state-patches`);
}

export async function loadStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
  return request<Record<string, unknown> | null>(`/api/sessions/${encodeURIComponent(sessionId)}/state-snapshot`);
}

export async function saveStateSnapshot(sessionId: string, snapshot: Record<string, unknown>): Promise<void> {
  await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/state-snapshot`, {
    method: "PUT",
    body: JSON.stringify(snapshot),
  });
}

export async function createSession(worldId: string, presetId?: string, id?: string): Promise<SessionRecord> {
  return request<SessionRecord>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ id, worldId, presetId }),
  });
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Pick<SessionRecord, "status" | "presetId" | "phase">>
): Promise<SessionRecord> {
  return request<SessionRecord>(`/api/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  });
}

export async function listMessages(sessionId: string): Promise<MessageRecord[]> {
  return request<MessageRecord[]>(`/api/sessions/${sessionId}/messages`);
}

export async function syncMessages(
  sessionId: string,
  messages: Array<{ role: string; content: string; turnId?: string; runtimeId?: string; block?: Record<string, unknown> }>,
): Promise<void> {
  await request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(sessionId)}/messages/sync`, {
    method: "POST",
    body: JSON.stringify({ messages }),
  });
}

// ── Config API ─────────────────────────────────────────────────────

export async function listPresets(): Promise<PresetSummary[]> {
  return request<PresetSummary[]>("/api/presets");
}

export interface PluginLoadError {
  pluginId: string;
  errors: string[];
}

interface PackagesResponse {
  packages: PackageSummary[];
  loadErrors: PluginLoadError[];
}

export async function listPackages(): Promise<PackagesResponse> {
  const res = await request<PackagesResponse | PackageSummary[]>("/api/packages");
  // Backward compat: old servers return a plain array
  if (Array.isArray(res)) {
    return { packages: res, loadErrors: [] };
  }
  return res;
}

export async function listCommands(): Promise<CommandSummary[]> {
  return request<CommandSummary[]>("/api/commands");
}

// ── LLM Config ───────────────────────────────────────────────────

export type InputModality = "text" | "image" | "audio" | "video" | "file";
export type OutputModality = "text" | "image" | "audio" | "embedding";
export type ModelFeature =
  | "function_calling" | "structured_output" | "streaming"
  | "reasoning" | "vision" | "prompt_caching"
  | "web_search" | "computer_use";

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
}

export async function fetchLlmConfig(): Promise<LlmConfigResponse> {
  return request<LlmConfigResponse>("/api/llm-config");
}

// ── Model Database API ───────────────────────────────────────────

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

export async function searchModelDb(query: string, limit = 20): Promise<ModelDbSearchResult[]> {
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
  const res = await request<{ found: boolean; capability?: ModelCapabilityInfo }>(
    `/api/model-db/lookup?${params.toString()}`,
  );
  return res.found ? (res.capability ?? null) : null;
}

export async function refreshModelDb(): Promise<{ ok: boolean; count?: number; error?: string }> {
  return request<{ ok: boolean; count?: number; error?: string }>("/api/model-db/refresh", {
    method: "POST",
  });
}

// ── Capability Overrides (localStorage) ──────────────────────────

const CAPABILITY_OVERRIDES_KEY = "covel:capabilityOverrides";

export function getCapabilityOverrides(): Record<string, Partial<ModelCapabilityInfo>> {
  const stored = localStorage.getItem(CAPABILITY_OVERRIDES_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

export function setCapabilityOverrides(overrides: Record<string, Partial<ModelCapabilityInfo>>): void {
  localStorage.setItem(CAPABILITY_OVERRIDES_KEY, JSON.stringify(overrides));
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

// ── Block Schemas ─────────────────────────────────────────────────

export async function fetchBlockSchemas(): Promise<Record<string, unknown>> {
  const res = await request<{ schemas: Record<string, unknown> }>("/api/block-schemas");
  return res.schemas;
}

// ── AI Ping ───────────────────────────────────────────────────────

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  ttfbMs?: number;
  text?: string;
  usage?: { inputTokens: number; outputTokens: number };
  error?: string;
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
    },
    body: JSON.stringify({ presetId }),
  });
  return res.json() as Promise<PingResult>;
}

// ── Actions (SSE) ──────────────────────────────────────────────────

export type ActionType = "send_message" | "execute_command" | "submit_block_response" | "start_session" | "retry_runtime" | "trigger_event";

export interface ActionRequest {
  requestId: string;
  type: ActionType;
  sessionId: string;
  locale?: string;
  payload: Record<string, unknown>;
}

/**
 * Send an action and receive SSE events via callback.
 * Returns an AbortController to cancel the stream.
 */
export function sendAction(
  req: ActionRequest,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(req.sessionId),
        },
        body: JSON.stringify(req),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Action failed ${res.status}: ${text}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data) {
              try {
                const envelope = JSON.parse(data) as SseEnvelope;
                onEvent(envelope);
              } catch {
                // skip malformed
              }
            }
          }
        }
      }

      onDone?.();
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  })();

  return controller;
}

/**
 * Trigger a custom kernel event for the given session.
 * Useful for manual plugin triggers (e.g., image generation button).
 */
export function triggerEvent(
  sessionId: string,
  eventType: string,
  eventData: Record<string, unknown>,
  locale: string,
  onEvent: (envelope: SseEnvelope) => void,
  onError?: (err: Error) => void,
  onDone?: () => void,
): AbortController {
  return sendAction(
    {
      requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "trigger_event",
      sessionId,
      locale,
      payload: { eventType, eventData },
    },
    onEvent,
    onError,
    onDone,
  );
}

// ── Provider Keys (localStorage) ───────────────────────────────────

export function getProviderKeys(): Record<string, string> {
  const stored = localStorage.getItem("covel:providerKeys");
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

export function setProviderKeys(keys: Record<string, string>) {
  localStorage.setItem("covel:providerKeys", JSON.stringify(keys));
}

// ── Slot Config (localStorage) ────────────────────────────────────

export interface SlotConfigEntry {
  presetId: string;
}

export function getSlotConfig(): Record<string, SlotConfigEntry> {
  const stored = localStorage.getItem(SLOT_CONFIG_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

export function setSlotConfig(config: Record<string, SlotConfigEntry>): void {
  localStorage.setItem(SLOT_CONFIG_KEY, JSON.stringify(config));
}

// ── Custom Presets (localStorage) ─────────────────────────────────

export interface CustomPreset {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  protocol?: string;
  apiKey?: string;
}

export function getCustomPresets(): CustomPreset[] {
  const stored = localStorage.getItem(CUSTOM_PRESETS_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

export function setCustomPresets(presets: CustomPreset[]): void {
  localStorage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}

export function addCustomPreset(preset: CustomPreset): void {
  const presets = getCustomPresets();
  presets.push(preset);
  setCustomPresets(presets);
}

export function removeCustomPreset(id: string): void {
  const presets = getCustomPresets().filter((p) => p.id !== id);
  setCustomPresets(presets);
}

// ── Parameter Overrides (localStorage) ────────────────────────────

export interface ModelParameterOverrides {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
}

export function getParamOverrides(): Record<string, ModelParameterOverrides> {
  const stored = localStorage.getItem(PARAM_OVERRIDES_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

export function setParamOverrides(overrides: Record<string, ModelParameterOverrides>): void {
  localStorage.setItem(PARAM_OVERRIDES_KEY, JSON.stringify(overrides));
}

// ── Runtime Priority Config (localStorage) ───────────────────────

const RUNTIME_PRIORITY_KEY = "covel:runtimePriority";

export function getRuntimePriorityOverrides(): Record<string, number> {
  const stored = localStorage.getItem(RUNTIME_PRIORITY_KEY);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

export function setRuntimePriorityOverrides(overrides: Record<string, number>): void {
  localStorage.setItem(RUNTIME_PRIORITY_KEY, JSON.stringify(overrides));
}

// ── Runtime Bindings (localStorage, per-session) ────────────────

const RUNTIME_BINDINGS_PREFIX = "covel:runtimeBindings:";

/** Get saved runtime bindings for a session. */
export function getRuntimeBindings(sessionId: string): Record<string, string> {
  const stored = localStorage.getItem(RUNTIME_BINDINGS_PREFIX + sessionId);
  if (!stored) return {};
  try {
    return JSON.parse(stored);
  } catch {
    return {};
  }
}

/** Save runtime bindings for a session. */
export function setRuntimeBindings(sessionId: string, bindings: Record<string, string>): void {
  localStorage.setItem(RUNTIME_BINDINGS_PREFIX + sessionId, JSON.stringify(bindings));
}

/** Clear saved runtime bindings for a session (e.g., on session delete). */
export function clearRuntimeBindings(sessionId: string): void {
  localStorage.removeItem(RUNTIME_BINDINGS_PREFIX + sessionId);
}

// ── World Overlay (IndexedDB via app-kv-store) ─────────────────

import {
  getWorldOverlay as idbGetWorldOverlay,
  setWorldOverlay as idbSetWorldOverlay,
  removeWorldOverlay as idbRemoveWorldOverlay,
  type WorldOverlay,
} from "./app-kv-store.js";

export type { WorldOverlay };

export async function getWorldOverlay(worldId: string): Promise<WorldOverlay | null> {
  return idbGetWorldOverlay(worldId);
}

export async function setWorldOverlay(worldId: string, overlay: WorldOverlay): Promise<void> {
  return idbSetWorldOverlay(worldId, overlay);
}

export async function removeWorldOverlay(worldId: string): Promise<void> {
  return idbRemoveWorldOverlay(worldId);
}

// ── Plugin Data API ──────────────────────────────────────────────

export interface PluginDataEntry {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

/** List all plugin data entries for a given plugin and optional namespace. */
export async function listPluginData(
  sessionId: string,
  pluginId: string,
  namespace?: string,
): Promise<PluginDataEntry[]> {
  const path = namespace
    ? `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}/${encodeURIComponent(namespace)}`
    : `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}`;
  const res = await request<{ items: PluginDataEntry[] }>(path);
  return res.items;
}

/** Get a single plugin data entry. */
export async function getPluginData(
  sessionId: string,
  pluginId: string,
  namespace: string,
  key: string,
): Promise<PluginDataEntry | null> {
  try {
    return await request<PluginDataEntry>(
      `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data/${encodeURIComponent(pluginId)}/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
    );
  } catch {
    return null;
  }
}

// ── Trace API ────────────────────────────────────────────────────

export interface TraceEvent {
  type: string;
  requestId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  flowId: string;
  seq: number;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TurnTrace {
  turnId: string;
  flowId: string;
  traceId: string;
  startedAt: string;
  completedAt: string;
  eventCount: number;
  events: TraceEvent[];
}

export async function fetchTraceEvents(sessionId: string): Promise<{ sessionId: string; count: number; events: TraceEvent[] }> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}`);
}

export async function fetchTraceTurns(sessionId: string): Promise<{ sessionId: string; turnCount: number; turns: TurnTrace[] }> {
  return request(`/api/traces/${encodeURIComponent(sessionId)}/turns`);
}

// ── Server Info ──────────────────────────────────────────────────

export interface ServerHealth {
  status: string;
  timestamp: string;
  version: string;
  storeBackend: "pg" | "memory";
  bootId?: string;
}

export async function fetchServerHealth(): Promise<ServerHealth> {
  const res = await fetch("/api/health");
  return res.json() as Promise<ServerHealth>;
}

// ── Server session sync guard ────────────────────────────────────
//
// Render free-tier sleeps after 15 min of inactivity, wiping MemoryStore.
// Instead of syncing before every action, we use a time-gated bootId check:
//   1. Track when we last got a successful server response
//   2. If idle > STALE_THRESHOLD, ping /api/health to get bootId
//   3. If bootId changed → server restarted → run full sync
//
// Cost: zero overhead during normal play, one lightweight health check
// after idle periods, full sync only on actual server restart.

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

let lastServerAckTime = 0;
let knownBootId: string | null = null;

/** Call after any successful server response to update the ack timestamp. */
export function markServerAck(): void {
  lastServerAckTime = Date.now();
}

/**
 * Ensure the server still has our session context.
 * Only checks if idle > STALE_THRESHOLD_MS. Triggers full sync on server restart.
 */
export async function ensureServerSession(
  sessionId: string,
  syncFn: (sid: string) => Promise<void>,
): Promise<void> {
  const elapsed = Date.now() - lastServerAckTime;
  if (elapsed < STALE_THRESHOLD_MS && knownBootId !== null) return;

  try {
    const health = await fetchServerHealth();
    markServerAck();

    if (knownBootId !== null && health.bootId !== knownBootId) {
      // Server restarted — rebuild session context
      await syncFn(sessionId);
    }
    knownBootId = health.bootId ?? null;
  } catch {
    // Health check failed (server still waking up?) — sync defensively
    try {
      await syncFn(sessionId);
    } catch {
      // sync also failed — let the action call surface the real error
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────

export function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
