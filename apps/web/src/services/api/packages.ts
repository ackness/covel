import { request } from "./request.js";
import type { I18nText } from "@covel/shared";
import type { PackageSummary, PresetSummary, RuntimeSummary } from "./types.js";

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
  priority: number;
  trigger: { type: string };
  runtimeType?: string;
  outputKind?: string;
  model?: string;
}

export interface PluginFlowSegment {
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
    priority: number;
    trigger?: { type?: string };
    runtimeType?: string;
    outputKind?: string;
    model?: string;
  };
  type RawSegment = {
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
      priority: s.priority,
      trigger: { type: s.trigger?.type ?? "auto" },
      runtimeType: s.runtimeType,
      outputKind: s.outputKind,
      model: s.model,
    })),
    segments: raw.segments.map((seg) => ({
      label: seg.label,
      labelText: seg.labelText,
      range: [seg.minPriority, seg.maxPriority],
    })),
  };
}
