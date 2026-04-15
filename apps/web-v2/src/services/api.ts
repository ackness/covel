/**
 * API client for Covel server.
 */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Types ────────────────────────────────────────────────────────

export interface WorldRecord {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface SessionRecord {
  id: string;
  worldId: string;
  phase: string;
  locale?: string;
  createdAt?: string;
}

// ── Health ───────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  storeBackend: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
}

// ── Worlds ───────────────────────────────────────────────────────

export async function listWorlds(): Promise<WorldRecord[]> {
  const res = await request<{ items: WorldRecord[] }>("/api/worlds");
  return res.items;
}

// ── Sessions ─────────────────────────────────────────────────────

export async function listSessions(): Promise<SessionRecord[]> {
  const res = await request<{ items: SessionRecord[] }>("/api/sessions");
  return res.items ?? [];
}

export async function createSession(worldId: string, plugins: string[]): Promise<SessionRecord> {
  return request<SessionRecord>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worldId, plugins, locale: "zh-CN" }),
  });
}

export async function deleteSession(sessionId: string): Promise<void> {
  await request(`/api/sessions/${sessionId}`, { method: "DELETE" });
}

// ── Actions (SSE) ────────────────────────────────────────────────

export interface ActionPayload {
  type: "start_session" | "send_message";
  sessionId: string;
  payload?: { content: string };
  locale?: string;
}

/**
 * Post an action and return the SSE stream response.
 * Caller is responsible for reading the stream.
 */
export async function postAction(payload: ActionPayload): Promise<Response> {
  const res = await fetch("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Action failed ${res.status}: ${body}`);
  }
  return res;
}

// ── Submit Inputs (form/choice/confirmation) ─────────────────────

export interface SubmitInputPayload {
  turnId: string;
  interactionId: string;
  type?: "form" | "choice" | "confirmation";
  values: Record<string, unknown>;
}

export async function submitInputsBatch(
  sessionId: string,
  payload: {
    turnId: string;
    submissions: SubmitInputPayload[];
  },
): Promise<{
  results: Array<{
    submissionId: string;
    interactionId: string;
    filledNarrative: string;
    accepted: boolean;
  }>;
  accepted: boolean;
}> {
  return request<{
    results: Array<{
      submissionId: string;
      interactionId: string;
      filledNarrative: string;
      accepted: boolean;
    }>;
    accepted: boolean;
  }>(
    `/api/sessions/${sessionId}/submit-inputs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnId: payload.turnId,
        submissions: payload.submissions,
      }),
    },
  );
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

export interface PluginInfo {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  pluginType?: string;
}

export async function listPlugins(): Promise<PluginInfo[]> {
  const res = await request<{ packages: PluginInfo[] }>("/api/packages");
  return res.packages;
}

export interface PluginFlowSegment {
  id: "start" | "pre-game" | "core-game-loop";
  label: string;
  rangeLabel: string;
  minPriority: number;
  maxPriority: number;
}

export interface PluginFlowStep {
  id: string;
  pluginId: string;
  pluginName: string;
  runtimeId: string;
  runtimeName: string;
  description: string;
  pluginType: string;
  priority: number;
  segmentId: "pre-game" | "core-game-loop";
  runtimeType: string;
  outputKind: string;
  model?: string;
  trigger: {
    type: string;
    interval?: number;
    cooldownTurns?: number;
    maxTriggerCount?: number;
    phases: string[];
  };
  injects: Array<{ from: string; field: string; as: string }>;
  tools: { builtin: string[]; local: string[] };
  uiSlots: string[];
  docPath: string;
  isStoryRuntime: boolean;
}

export interface PluginFlowResponse {
  version: string;
  generatedAt: string;
  segments: PluginFlowSegment[];
  plugins: Array<{
    id: string;
    name: string;
    description: string;
    pluginType: string;
    runtimeIds: string[];
  }>;
  steps: PluginFlowStep[];
}

export async function fetchPluginFlows(): Promise<PluginFlowResponse> {
  return request<PluginFlowResponse>("/api/plugin-flows");
}

export interface PluginDocEntry {
  id: string;
  runtimeId: string;
  label: string;
  path: string;
  content: string;
}

export interface PluginDocsResponse {
  pluginId: string;
  name: string;
  docs: PluginDocEntry[];
}

export async function fetchPluginDocs(pluginId: string): Promise<PluginDocsResponse> {
  return request<PluginDocsResponse>(`/api/plugin-docs/${encodeURIComponent(pluginId)}`);
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
  characters: Array<{ id: string; name: string; type: string; description?: string; fields?: Record<string, unknown> }>;
  gameState: Record<string, unknown>;
  executionSteps: Array<{ type: string; turnId: string; payload: Record<string, unknown>; timestamp: string }>;
  plugins: Array<{ id: string; name: string; isActive: boolean; priority: number }>;
  characterSchema?: Record<string, unknown>;
}

export async function fetchSnapshot(sessionId: string): Promise<SnapshotResponse> {
  return request<SnapshotResponse>(`/api/sessions/${sessionId}/snapshot`);
}

// ── UI Specs ─────────────────────────────────────────────────────

export interface UISlotEntry {
  pluginId: string;
  specs: readonly Record<string, unknown>[];
}

export interface UISpecsResponse {
  right: UISlotEntry[];
  message: UISlotEntry[];
  left: UISlotEntry[];
}

export async function fetchUiSpecs(sessionId?: string): Promise<UISpecsResponse> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<UISpecsResponse>(`/api/ui-specs${qs}`);
}

// ── Lorebook (framework-owned) ───────────────────────────────────

export interface LorebookEntry {
  id: string;
  sessionId: string;
  pluginId: string;
  keys: readonly string[];
  content: string;
  strategy: "constant" | "selective";
  position: string;
  insertionOrder: number;
  enabled: boolean;
  extra?: unknown;
  createdAt: string;
  updatedAt: string;
}

export async function fetchLorebookEntries(sessionId: string): Promise<LorebookEntry[]> {
  const res = await request<{ entries: LorebookEntry[] }>(
    `/api/sessions/${sessionId}/lorebook`,
  );
  return res.entries ?? [];
}

export async function updateLorebookEntryEnabled(
  sessionId: string,
  entryId: string,
  enabled: boolean,
): Promise<void> {
  await request(`/api/sessions/${sessionId}/lorebook/${entryId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteLorebookEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  await request(`/api/sessions/${sessionId}/lorebook/${entryId}`, {
    method: "DELETE",
  });
}

// ── Plugin Data ──────────────────────────────────────────────────

export async function fetchPluginData(
  sessionId: string,
  pluginId: string,
  namespace?: string,
): Promise<Array<{ namespace: string; key: string; value: unknown }>> {
  const path = namespace
    ? `/api/sessions/${sessionId}/plugin-data/${pluginId}/${namespace}`
    : `/api/sessions/${sessionId}/plugin-data/${pluginId}`;
  const res = await request<{ items: Array<{ namespace: string; key: string; value: unknown }> }>(path);
  return res.items ?? [];
}
