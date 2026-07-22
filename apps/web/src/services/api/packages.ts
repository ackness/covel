import { request } from "./request.js";
import type { I18nText, Stage } from "@covel/shared";
import type { PackageSummary, PresetSummary, RuntimeSummary } from "./types.js";

/** Flow segment id: a named stage, or the stage-less event/manual bucket. */
export type FlowSegmentId = Stage | "event-manual";

// -- Config API -------------------------------------------------

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

type RawRuntimeSummary = Omit<RuntimeSummary, "trigger"> & {
  trigger?: RuntimeSummary["trigger"];
};

type RawPackageSummary = Omit<PackageSummary, "runtimes"> & {
  runtimes?: RawRuntimeSummary[];
};

function normalizePackageSummary(pkg: RawPackageSummary): PackageSummary {
  return {
    ...pkg,
    runtimes: (pkg.runtimes ?? []).map((runtime) => {
      return {
        ...runtime,
        trigger: runtime.trigger ?? { type: "auto" },
      };
    }),
  };
}

export async function listPackages(): Promise<PackagesResponse> {
  const res = await request<{
    packages: RawPackageSummary[];
    loadErrors: PluginLoadError[];
  }>("/api/packages");
  return {
    packages: res.packages.map(normalizePackageSummary),
    loadErrors: res.loadErrors,
  };
}

// -- Plugin Flows & Docs -------------------------------------

export interface PluginFlowStep {
  pluginId: string;
  runtimeId: string;
  label: string;
  /** Named stage; absent for event/manual runtimes. */
  stage?: Stage;
  /** Segment this step groups under (stage or "event-manual"). */
  segmentId: FlowSegmentId;
  priority: number;
  trigger: { type: string };
  runtimeType?: string;
  outputKind?: string;
  model?: string;
}

export interface PluginFlowSegment {
  id: FlowSegmentId;
  label: string;
  labelText?: I18nText;
  range: [number, number];
}

export interface PluginFlowResponse {
  steps: PluginFlowStep[];
  segments: PluginFlowSegment[];
}

export async function fetchPluginFlows(): Promise<PluginFlowResponse> {
  // Server endpoint is `/api/plugin-flows` (not `/api/plugins/flows`, which
  // falls into `/api/plugins/:id` and 404s with `Plugin "flows" not found`).
  // The server response also uses `runtimeName` / `trigger.type` /
  // `minPriority`+`maxPriority`; adapt to the UI-facing shape here.
  type RawStep = {
    pluginId: string;
    runtimeId: string;
    runtimeName?: string;
    stage?: Stage;
    segmentId: FlowSegmentId;
    priority: number;
    trigger?: { type?: string };
    runtimeType?: string;
    outputKind?: string;
    model?: string;
  };
  type RawSegment = {
    id: FlowSegmentId;
    label: string;
    labelText?: I18nText;
    minPriority: number;
    maxPriority: number;
  };
  const raw = await request<{ steps: RawStep[]; segments: RawSegment[] }>(
    "/api/plugin-flows",
  );
  return {
    steps: raw.steps.map((s) => ({
      pluginId: s.pluginId,
      runtimeId: s.runtimeId,
      label: s.runtimeName ?? s.runtimeId,
      ...(s.stage !== undefined ? { stage: s.stage } : {}),
      segmentId: s.segmentId,
      priority: s.priority,
      trigger: { type: s.trigger?.type ?? "auto" },
      runtimeType: s.runtimeType,
      outputKind: s.outputKind,
      model: s.model,
    })),
    segments: raw.segments.map((seg) => ({
      id: seg.id,
      label: seg.label,
      labelText: seg.labelText,
      range: [seg.minPriority, seg.maxPriority],
    })),
  };
}
