import { request } from "./request.js";

// -- Plugin Data API -------------------------------------------

export interface PluginDataEntry {
  namespace: string;
  key: string;
  value: unknown;
  updatedAt: string;
}

export interface SessionPluginDataEntry extends PluginDataEntry {
  pluginId: string;
}

/** Every readable plugin data row of the session's active plugins, in one request. */
export async function listSessionPluginData(
  sessionId: string,
): Promise<SessionPluginDataEntry[]> {
  const res = await request<{ items: SessionPluginDataEntry[] }>(
    `/api/sessions/${encodeURIComponent(sessionId)}/plugin-data`,
  );
  return res.items;
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
  view?: Record<string, unknown>;
  webview?: { html: string; height?: number };
  surfaces?: readonly ("panel" | "stage")[];
}

export interface UISlotEntry {
  pluginId: string;
  specs: UISlotSpec[];
}

/** A spec rejected by server-side validation, with concrete per-field issues. */
export interface UiSpecDiagnostic {
  pluginId: string;
  runtimeId: string;
  slot: "right" | "message" | "left";
  specIndex: number;
  specId?: string;
  issues: { path: string; message: string; code: string }[];
}

export interface UISpecsResponse {
  right: UISlotEntry[];
  message?: UISlotEntry[];
  left?: UISlotEntry[];
  /** Specs dropped from the slots above because they failed validation. */
  diagnostics?: UiSpecDiagnostic[];
}

export async function fetchUiSpecs(
  sessionId?: string,
): Promise<UISpecsResponse> {
  const qs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<UISpecsResponse>(`/api/ui-specs${qs}`, { sessionId });
}
