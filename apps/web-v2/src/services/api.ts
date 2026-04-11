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

export async function fetchUiSpecs(): Promise<UISpecsResponse> {
  return request<UISpecsResponse>("/api/ui-specs");
}

// ── Health ───────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  storeBackend: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/api/health");
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
