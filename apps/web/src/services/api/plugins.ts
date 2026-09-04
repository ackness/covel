import type {
  I18nText,
  PluginLoadError,
  PluginSummary,
  Stage,
} from "@covel/shared";
import { apiListResponseSchema, pluginSummarySchema } from "@covel/shared";
import { request } from "./request.js";
import type { PresetSummary, TurnCompletionSummary } from "./types.js";
import { getDesktopRestAuthHeaders } from "@/lib/desktop-bridge.js";

export type FlowSegmentId = Stage | "event-manual";

export async function listPresets(): Promise<PresetSummary[]> {
  const response = await request<{ items: PresetSummary[] }>("/api/presets");
  return response.items;
}

export interface PluginCatalog {
  items: PluginSummary[];
  loadErrors: PluginLoadError[];
}

export async function getPluginCatalog(options?: {
  silentErrors?: boolean;
}): Promise<PluginCatalog> {
  const response = await request("/api/plugins", {
    ...options,
    schema: apiListResponseSchema(pluginSummarySchema),
  });
  return {
    items: response.items.filter((plugin) => plugin.status !== "error"),
    loadErrors: response.items
      .filter(
        (plugin): plugin is PluginSummary & { error: string } =>
          plugin.status === "error" && typeof plugin.error === "string",
      )
      .map((plugin) => ({ pluginId: plugin.id, errors: [plugin.error] })),
  };
}

/** List usable plugins. Load diagnostics are available through getPluginCatalog. */
export async function listPlugins(options?: {
  silentErrors?: boolean;
}): Promise<PluginSummary[]> {
  return (await getPluginCatalog(options)).items;
}

export async function uninstallPlugin(pluginId: string): Promise<void> {
  await request(`/api/plugins/${encodeURIComponent(pluginId)}`, {
    method: "DELETE",
    headers: getDesktopRestAuthHeaders(),
    operatorAuth: true,
  });
}

export interface PluginFlowStep {
  pluginId: string;
  runtimeId: string;
  label: string;
  stage?: Stage;
  segmentId: FlowSegmentId;
  trigger: { type: string };
  runtimeType?: string;
  outputKind?: string;
  capabilities?: readonly string[];
  execution?: "sync" | "background";
  model?: string;
  turnCompletion: TurnCompletionSummary;
}

export interface PluginFlowSegment {
  id: FlowSegmentId;
  label: string;
  labelText?: I18nText;
}

export interface PluginFlowResponse {
  steps: PluginFlowStep[];
  segments: PluginFlowSegment[];
}

function normalizeTurnCompletion(
  value: TurnCompletionSummary | undefined,
): TurnCompletionSummary {
  return value?.mode === "detached"
    ? { ...value, mode: "detached" }
    : { mode: "await" };
}

export async function fetchPluginFlows(): Promise<PluginFlowResponse> {
  type RawStep = {
    pluginId: string;
    runtimeId: string;
    runtimeName?: string;
    stage?: Stage;
    segmentId: FlowSegmentId;
    trigger?: { type?: string };
    runtimeType?: string;
    outputKind?: string;
    capabilities?: string[];
    execution?: "sync" | "background";
    model?: string;
    turnCompletion?: TurnCompletionSummary;
  };
  type RawSegment = {
    id: FlowSegmentId;
    label: string;
    labelText?: I18nText;
  };
  const response = await request<{
    steps: RawStep[];
    segments: RawSegment[];
  }>("/api/plugin-flows");
  return {
    steps: response.steps.map((step) => ({
      pluginId: step.pluginId,
      runtimeId: step.runtimeId,
      label: step.runtimeName ?? step.runtimeId,
      ...(step.stage !== undefined ? { stage: step.stage } : {}),
      segmentId: step.segmentId,
      trigger: { type: step.trigger?.type ?? "auto" },
      runtimeType: step.runtimeType,
      outputKind: step.outputKind,
      capabilities: step.capabilities,
      execution: step.execution,
      model: step.model,
      turnCompletion: normalizeTurnCompletion(step.turnCompletion),
    })),
    segments: response.segments.map((segment) => ({
      id: segment.id,
      label: segment.label,
      labelText: segment.labelText,
    })),
  };
}
