import type { Transport } from "../transport/transport.js";

// ── Package summary ──────────────────────────────────────────────

export interface PluginRuntimeSummary {
  id: string;
  kind: string;
  priority: number;
  trigger: Record<string, unknown>;
}

export interface PluginToolSummary {
  id: string;
  kind: "builtin" | "local";
}

export interface PluginPackage {
  name: string;
  displayName?: string | Record<string, string>;
  description?: string | Record<string, string>;
  pluginType?: string;
  enabled?: boolean;
  runtimes?: PluginRuntimeSummary[];
  tools?: PluginToolSummary[];
}

export interface PluginPackagesResponse {
  packages: PluginPackage[];
  loadErrors: Array<{ pluginId: string; errors: string[] }>;
}

// ── Plugin flows ─────────────────────────────────────────────────

export type PluginFlowSegmentId =
  | "start"
  | "pre-game"
  | "pre-narrator"
  | "narrator"
  | "post-narrator";

export interface PluginFlowSegment {
  id: PluginFlowSegmentId;
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
  segmentId: PluginFlowSegmentId;
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

export interface PluginFlowsResponse {
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

// ── Plugin docs ──────────────────────────────────────────────────

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

// ── Resource ─────────────────────────────────────────────────────

export class PluginsResource {
  constructor(private readonly transport: Transport) {}

  /** GET /api/packages — list all installed plugin packages. */
  async listPackages(): Promise<PluginPackagesResponse> {
    return this.transport.request<PluginPackagesResponse>({
      method: "GET",
      path: "/api/packages",
    });
  }

  /** GET /api/plugin-flows — framework-built orchestration preview. */
  async getFlows(): Promise<PluginFlowsResponse> {
    return this.transport.request<PluginFlowsResponse>({
      method: "GET",
      path: "/api/plugin-flows",
    });
  }

  /** GET /api/plugin-docs/:pluginId — raw PLUGIN.md content for a plugin. */
  async getDocs(pluginId: string): Promise<PluginDocsResponse> {
    return this.transport.request<PluginDocsResponse>({
      method: "GET",
      path: "/api/plugin-docs/:pluginId",
      params: { pluginId },
    });
  }
}
