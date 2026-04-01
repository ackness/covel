/**
 * API client for communicating with the Covel server.
 */

// ── Types ──────────────────────────────────────────────────────────

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  lore?: string;
  tags?: string[];
  createdAt: string;
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

export interface PackageSummary {
  name: string;
  enabled: boolean;
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
  if (stored) {
    try {
      const keys = JSON.parse(stored);
      headers["X-Provider-Keys"] = btoa(JSON.stringify(keys));
    } catch {
      // skip
    }
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
  const slotConfig = localStorage.getItem(SLOT_CONFIG_KEY);
  const paramOverrides = localStorage.getItem(PARAM_OVERRIDES_KEY);
  const slots = slotConfig ? JSON.parse(slotConfig) : {};
  const overrides = paramOverrides ? JSON.parse(paramOverrides) : {};
  const hasSlots = Object.keys(slots).length > 0;
  const hasOverrides = Object.keys(overrides).length > 0;
  if (!hasSlots && !hasOverrides) return {};
  return {
    "X-Slot-Config": btoa(JSON.stringify({ slots, paramOverrides: overrides })),
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

export async function createWorld(name: string, description: string): Promise<WorldRecord> {
  return request<WorldRecord>("/worlds", {
    method: "POST",
    body: JSON.stringify({ name, description }),
  });
}

// ── Session API ────────────────────────────────────────────────────

export async function listSessions(worldId: string): Promise<SessionRecord[]> {
  return request<SessionRecord[]>(`/sessions?worldId=${encodeURIComponent(worldId)}`);
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

// ── Block Schemas ─────────────────────────────────────────────────

export async function fetchBlockSchemas(): Promise<Record<string, unknown>> {
  const res = await request<{ schemas: Record<string, unknown> }>("/block-schemas");
  return res.schemas;
}

// ── Actions (SSE) ──────────────────────────────────────────────────

export type ActionType = "send_message" | "execute_command" | "submit_block_response" | "start_session";

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
        onError?.(err as Error);
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

// ── Helpers ───────────────────────────────────────────────────────

export function uid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
