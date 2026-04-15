/**
 * API facade for Covel server — front-end edge of the front/back split.
 *
 * This file is a *thin shim* around `@covel/api-client`. Web-v2 must NOT
 * make direct `fetch()` calls anywhere else in the codebase: that would
 * couple the frontend to wire-format details and defeat the separation.
 *
 * - All HTTP/SSE traffic flows through a single `ApiClient` singleton.
 * - Public function signatures preserve the legacy shapes used by stores
 *   and components, so no caller needs to change when this layer evolves.
 * - Types are re-exported from `@covel/api-client` (which itself derives
 *   from `@covel/shared`), giving the whole frontend a single source of
 *   type truth.
 */

import {
  ApiClient,
  type ActionRequest,
  type Character as ApiCharacter,
  type LorebookEntry as ApiLorebookEntry,
  type Message as ApiMessage,
  type PluginDocsResponse as ApiPluginDocsResponse,
  type PluginFlowsResponse as ApiPluginFlowsResponse,
  type PluginPackage,
  type Session as ApiSession,
  type SseEvent,
  type SubmitInputItem as ApiSubmitInputItem,
  type SubmitInputsBatchResponse,
  type UiSpecSlotEntry,
  type UiSpecs,
  type World as ApiWorld,
} from "@covel/api-client";

// ── Singleton client ─────────────────────────────────────────────

const apiClient = new ApiClient({ baseUrl: "/" });

// Expose for advanced consumers that need direct resource access (e.g.
// future Electron transport injection, debug tools). New code should
// prefer the named functions below.
export { apiClient };

// ── Re-exported types (legacy aliases) ───────────────────────────

export type WorldRecord = ApiWorld;
export type SessionRecord = ApiSession;
export type Message = ApiMessage;
export type Character = ApiCharacter;
export type LorebookEntry = ApiLorebookEntry;
export type UISlotEntry = UiSpecSlotEntry;
export type UISpecsResponse = UiSpecs;
export type PluginInfo = PluginPackage;
export type PluginFlowResponse = ApiPluginFlowsResponse;
export type PluginFlowSegment = ApiPluginFlowsResponse["segments"][number];
export type PluginFlowStep = ApiPluginFlowsResponse["steps"][number];
export type PluginDocEntry = ApiPluginDocsResponse["docs"][number];
export type PluginDocsResponse = ApiPluginDocsResponse;
export type SubmitInputPayload = ApiSubmitInputItem;

// ── Health ───────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  storeBackend: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  // The api-client returns the full health envelope; strip down to the
  // legacy shape that web-v2 callers expect.
  const res = (await apiClient.health.get()) as unknown as Record<string, unknown>;
  return {
    status: typeof res.status === "string" ? res.status : "ok",
    storeBackend: typeof res.storeBackend === "string" ? res.storeBackend : "",
  };
}

// ── Worlds ───────────────────────────────────────────────────────

export async function listWorlds(): Promise<WorldRecord[]> {
  return apiClient.worlds.list();
}

// ── Sessions ─────────────────────────────────────────────────────

export async function listSessions(): Promise<SessionRecord[]> {
  return apiClient.sessions.list();
}

export async function createSession(
  worldId: string,
  plugins: string[],
): Promise<SessionRecord> {
  return apiClient.sessions.create({
    worldId,
    plugins,
    locale: "zh-CN",
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  return apiClient.sessions.delete(sessionId);
}

// ── Actions (SSE) ────────────────────────────────────────────────

export interface ActionPayload {
  type: ActionRequest["type"];
  sessionId: string;
  payload?: Record<string, unknown>;
  locale?: string;
}

/**
 * Post an action and return an async-iterable SSE event stream.
 *
 * Callers consume via `for await (const evt of stream)`. Each event
 * already has its `data` field JSON-parsed by the api-client SSE parser.
 */
export function postAction(payload: ActionPayload): AsyncIterable<SseEvent> {
  return apiClient.actions.run({
    type: payload.type,
    sessionId: payload.sessionId,
    payload: payload.payload ?? {},
    ...(payload.locale ? { locale: payload.locale } : {}),
  });
}

// ── Submit Inputs (form/choice/confirmation) ─────────────────────

export async function submitInputsBatch(
  sessionId: string,
  payload: {
    turnId: string;
    submissions: SubmitInputPayload[];
  },
): Promise<SubmitInputsBatchResponse> {
  return apiClient.sessions.submitInputs(sessionId, payload);
}

export async function submitInputs(
  sessionId: string,
  payload: SubmitInputPayload,
): Promise<{ filledNarrative: string; accepted: boolean }> {
  const result = await submitInputsBatch(sessionId, {
    turnId: payload.turnId,
    submissions: [payload],
  });
  return {
    filledNarrative: result.results[0]?.filledNarrative ?? "",
    accepted: result.accepted,
  };
}

// ── Plugins ──────────────────────────────────────────────────────

export async function listPlugins(): Promise<PluginInfo[]> {
  const res = await apiClient.plugins.listPackages();
  return res.packages;
}

export async function fetchPluginFlows(): Promise<PluginFlowResponse> {
  return apiClient.plugins.getFlows();
}

export async function fetchPluginDocs(pluginId: string): Promise<PluginDocsResponse> {
  return apiClient.plugins.getDocs(pluginId);
}

// ── Session Snapshot (restore) ──────────────────────────────────

export interface SnapshotResponse {
  session: { id: string; worldId?: string; phase: string; turnCount: number; locale?: string };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    turnId?: string;
    runtimeId?: string;
    kind?: string;
    block?: Record<string, unknown>;
    createdAt: string;
  }>;
  characters: Array<{
    id: string;
    name: string;
    type: string;
    description?: string;
    fields?: Record<string, unknown>;
  }>;
  gameState: Record<string, unknown>;
  executionSteps: Array<{
    type: string;
    turnId: string;
    payload: Record<string, unknown>;
    timestamp: string;
  }>;
  plugins: Array<{ id: string; name: string; isActive: boolean; priority: number }>;
  characterSchema?: Record<string, unknown>;
}

export async function fetchSnapshot(sessionId: string): Promise<SnapshotResponse> {
  return (await apiClient.sessions.getSnapshot(sessionId)) as SnapshotResponse;
}

// ── UI Specs ─────────────────────────────────────────────────────

export async function fetchUiSpecs(sessionId?: string): Promise<UISpecsResponse> {
  return apiClient.uiSpecs.get(sessionId);
}

// ── Lorebook (framework-owned) ───────────────────────────────────

export async function fetchLorebookEntries(sessionId: string): Promise<LorebookEntry[]> {
  return apiClient.lorebook.list(sessionId);
}

export async function updateLorebookEntryEnabled(
  sessionId: string,
  entryId: string,
  enabled: boolean,
): Promise<void> {
  return apiClient.lorebook.setEnabled(sessionId, entryId, enabled);
}

export async function deleteLorebookEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  return apiClient.lorebook.delete(sessionId, entryId);
}

// ── Plugin Data ──────────────────────────────────────────────────

export async function fetchPluginData(
  sessionId: string,
  pluginId: string,
  namespace?: string,
): Promise<Array<{ namespace: string; key: string; value: unknown }>> {
  const items = await apiClient.pluginData.list(sessionId, pluginId, namespace);
  return items.map((entry) => ({
    namespace: entry.namespace,
    key: entry.key,
    value: entry.value,
  }));
}
