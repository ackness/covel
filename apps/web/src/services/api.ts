/**
 * API client for communicating with the Covel server.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  lore?: string;
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
  providerBinding?: string;
}

export interface PackageSummary {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  enabled: boolean;
  runtimes?: RuntimeSummary[];
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
const AI_ROUTES = ["/actions", "/api/ai/", "/api/kernel/"];

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

function buildAiHeaders(): Record<string, string> {
  return {
    ...buildProviderKeysHeader(),
    ...buildSlotConfigHeaderInternal(),
  };
}

function buildSlotConfigHeaderInternal(): Record<string, string> {
  const slotConfigRaw = localStorage.getItem(SLOT_CONFIG_KEY);
  const paramOverridesRaw = localStorage.getItem(PARAM_OVERRIDES_KEY);
  let slots: Record<string, unknown> = {};
  let overrides: Record<string, unknown> = {};
  try {
    slots = slotConfigRaw ? JSON.parse(slotConfigRaw) : {};
  } catch {
    slots = {};
  }
  try {
    overrides = paramOverridesRaw ? JSON.parse(paramOverridesRaw) : {};
  } catch {
    overrides = {};
  }

  // Include custom preset definitions for any custom presets referenced by slots
  const customPresets = getCustomPresets();
  const referencedCustomIds = new Set(
    Object.values(slots as Record<string, { presetId: string }>)
      .map((s) => s.presetId)
      .filter((id) => id?.startsWith("custom_"))
  );
  const customPresetDefs = customPresets
    .filter((p) => referencedCustomIds.has(p.id))
    .map(({ id, name, provider, baseUrl, model, protocol }) => ({
      id, name, provider, baseUrl, model, protocol,
    }));

  const hasSlots = Object.keys(slots).length > 0;
  const hasOverrides = Object.keys(overrides).length > 0;
  const hasCustom = customPresetDefs.length > 0;
  if (!hasSlots && !hasOverrides && !hasCustom) return {};
  return {
    "X-Slot-Config": btoa(JSON.stringify({
      slots,
      paramOverrides: overrides,
      ...(hasCustom ? { customPresets: customPresetDefs } : {}),
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
  return request<WorldRecord[]>("/worlds");
}

export async function getWorld(id: string): Promise<WorldRecord> {
  return request<WorldRecord>(`/worlds/${encodeURIComponent(id)}`);
}

export async function createWorld(name: string, description: string): Promise<WorldRecord> {
  return request<WorldRecord>("/worlds", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

export async function updateWorld(
  id: string,
  patch: Partial<Pick<WorldRecord, "name" | "description" | "lore" | "locale" | "tags" | "dimensions">>,
): Promise<WorldRecord> {
  return request<WorldRecord>(`/worlds/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ── Session API ────────────────────────────────────────────────────

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  return request<SessionRecord[]>(`/sessions?worldId=${encodeURIComponent(worldId)}`);
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  return request<SessionRecord>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function listStatePatches(sessionId: string): Promise<StatePatchRecord[]> {
  return request<StatePatchRecord[]>(`/sessions/${encodeURIComponent(sessionId)}/state-patches`);
}

export async function createSession(worldId: string, presetId?: string): Promise<SessionRecord> {
  return request<SessionRecord>("/sessions", {
    method: "POST",
    body: JSON.stringify({ worldId, presetId }),
  });
}

export async function updateSession(
  sessionId: string,
  updates: Partial<Pick<SessionRecord, "status" | "presetId">>
): Promise<SessionRecord> {
  return request<SessionRecord>(`/sessions/${sessionId}`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
}

export async function listMessages(sessionId: string): Promise<MessageRecord[]> {
  return request<MessageRecord[]>(`/sessions/${sessionId}/messages`);
}

// ── Config API ─────────────────────────────────────────────────────

export async function listPresets(): Promise<PresetSummary[]> {
  return request<PresetSummary[]>("/presets");
}

export async function listPackages(): Promise<PackageSummary[]> {
  return request<PackageSummary[]>("/packages");
}

export async function listCommands(): Promise<CommandSummary[]> {
  return request<CommandSummary[]>("/commands");
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
  const res = await request<{ schemas: Record<string, unknown> }>("/block-schemas");
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

export type ActionType = "send_message" | "execute_command" | "submit_block_response" | "start_session" | "retry_runtime";

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
      const res = await fetch("/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAiHeaders(),
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

// ── World Overlay (localStorage) ────────────────────────────────

const WORLD_OVERLAY_KEY_PREFIX = "covel:worldOverlay:";

export interface WorldOverlay {
  lore?: string;
  updatedAt: string;
}

export function getWorldOverlay(worldId: string): WorldOverlay | null {
  const stored = localStorage.getItem(`${WORLD_OVERLAY_KEY_PREFIX}${worldId}`);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

export function setWorldOverlay(worldId: string, overlay: WorldOverlay): void {
  localStorage.setItem(`${WORLD_OVERLAY_KEY_PREFIX}${worldId}`, JSON.stringify(overlay));
}

export function removeWorldOverlay(worldId: string): void {
  localStorage.removeItem(`${WORLD_OVERLAY_KEY_PREFIX}${worldId}`);
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

// ── Helpers ───────────────────────────────────────────────────────

export function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
