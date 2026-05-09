import { request } from "./request.js";

// -- Plugin Data API -------------------------------------------

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
      { silentErrors: true },
    );
  } catch {
    return null;
  }
}

// -- UI Specs (plugin panel discovery) -------------------------

export interface UISlotSpec {
  id?: string;
  label: unknown;
  shortLabel?: unknown;
  icon?: string;
  group?: string;
  groupLabel?: unknown;
  groupOrder?: number;
  dataSource?: { namespace: string };
  emptyState?: { message: unknown };
  view: Record<string, unknown>;
}

export interface UISlotEntry {
  pluginId: string;
  specs: UISlotSpec[];
}

export interface UISpecsResponse {
  right: UISlotEntry[];
  message?: UISlotEntry[];
}

export async function fetchUiSpecs(
  sessionId?: string,
): Promise<UISpecsResponse> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<UISpecsResponse>(`/api/ui-specs${qs}`);
}
