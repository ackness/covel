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

export async function createSession(worldId: string, plugins: string[]): Promise<SessionRecord> {
  return request<SessionRecord>("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worldId, plugins, locale: "zh-CN" }),
  });
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

export async function submitInputs(
  sessionId: string,
  payload: SubmitInputPayload,
): Promise<{ filledNarrative: string; accepted: boolean }> {
  return request<{ filledNarrative: string; accepted: boolean }>(
    `/api/sessions/${sessionId}/submit-inputs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        turnId: payload.turnId,
        formId: payload.interactionId,
        values: payload.values,
      }),
    },
  );
}

// ── Plugins ──────────────────────────────────────────────────────

export interface PluginInfo {
  name: string;
  displayName: string;
}

export async function listPlugins(): Promise<PluginInfo[]> {
  const res = await request<{ packages: PluginInfo[] }>("/api/packages");
  return res.packages;
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
