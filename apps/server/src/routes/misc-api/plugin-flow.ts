import {
  discoverPluginsMulti,
  loadPluginManifest,
  loadPluginSummary,
} from "@covel/plugin-loader";
import { resolve } from "node:path";
import {
  docPathFromAbsolute,
  isStoryRuntime,
  resolvePluginsDirs,
  segmentForPriority,
  textValue,
  uiSlotsOf,
  type FlowSegmentId,
} from "./shared.js";

export async function buildPluginFlowResponse() {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());

  const plugins: Array<{
    id: string;
    name: string;
    description: string;
    pluginType: string;
    runtimeIds: string[];
  }> = [];

  const steps: Array<{
    id: string;
    pluginId: string;
    pluginName: string;
    runtimeId: string;
    runtimeName: string;
    description: string;
    pluginType: string;
    priority: number;
    segmentId: FlowSegmentId;
    runtimeType: string;
    outputKind: string;
    model?: string;
    trigger: {
      type: string;
      interval?: number;
      cooldownTurns?: number;
      maxTriggerCount?: number;
      startTurn?: number;
    };
    injects: Array<{
      kind: string;
      as: string;
      from?: string;
      field?: string;
      namespace?: string;
      format?: string;
    }>;
    tools: { builtin: string[]; local: string[] };
    uiSlots: string[];
    docPath: string;
    isStoryRuntime: boolean;
  }> = [];

  for (const discovery of discoveries) {
    const [summary, manifests] = await Promise.all([
      loadPluginSummary(discovery),
      loadPluginManifest(discovery),
    ]);

    const pluginName = textValue(summary.name) || discovery.id;
    const pluginDescription = textValue(summary.description);

    plugins.push({
      id: discovery.id,
      name: pluginName,
      description: pluginDescription,
      pluginType: summary.pluginType,
      runtimeIds: manifests.map((item) => item.manifest.name),
    });

    for (const [index, parsed] of manifests.entries()) {
      const manifest = parsed.manifest;
      const runtimeId = manifest.name;
      const runtimeName = runtimeId.includes("/")
        ? (runtimeId.split("/").at(-1) ?? runtimeId)
        : runtimeId;
      const priority = manifest.priority ?? 500;
      const mdPath =
        discovery.pluginMdPaths[index] ?? discovery.pluginMdPaths[0];
      const discoveryRoot = resolve(discovery.rootPath, "..");
      const docPath = mdPath ? docPathFromAbsolute(discoveryRoot, mdPath) : "";

      steps.push({
        id: runtimeId,
        pluginId: discovery.id,
        pluginName,
        runtimeId,
        runtimeName,
        description: textValue(manifest.description),
        pluginType: summary.pluginType,
        priority,
        segmentId: segmentForPriority(priority),
        runtimeType: manifest.runtimeType ?? "agent",
        outputKind: manifest.outputKind ?? "plugin",
        model: manifest.model,
        trigger: {
          type: manifest.trigger?.type ?? "auto",
          interval: manifest.trigger?.interval,
          cooldownTurns: manifest.trigger?.cooldownTurns,
          maxTriggerCount: manifest.trigger?.maxTriggerCount,
          startTurn: manifest.trigger?.startTurn,
        },
        injects: (manifest.input?.inject ?? []).map((inject) => ({
          kind: inject.kind,
          ...(inject.kind === "runtime"
            ? { from: inject.from, field: inject.field }
            : { namespace: inject.namespace, format: inject.format }),
          as: inject.as,
        })),
        tools: {
          builtin: [...(manifest.tools?.builtin ?? [])],
          local: [...(manifest.tools?.local ?? [])].map((toolPath) => {
            const fileName = toolPath.split("/").at(-1) ?? toolPath;
            return fileName.replace(/\.[^.]+$/, "");
          }),
        },
        uiSlots: uiSlotsOf(manifest),
        docPath,
        isStoryRuntime: isStoryRuntime(manifest),
      });
    }
  }

  steps.sort(
    (a, b) => a.priority - b.priority || a.runtimeId.localeCompare(b.runtimeId),
  );
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    segments: [
      {
        id: "start",
        label: "开始游戏",
        rangeLabel: "0",
        minPriority: 0,
        maxPriority: 0,
      },
      {
        id: "pre-game",
        label: "Pre-Game",
        rangeLabel: "1-99",
        minPriority: 1,
        maxPriority: 99,
      },
      {
        id: "pre-narrator",
        label: "Pre-Narrator",
        rangeLabel: "100-499",
        minPriority: 100,
        maxPriority: 499,
      },
      {
        id: "narrator",
        label: "Narrator",
        rangeLabel: "500",
        minPriority: 500,
        maxPriority: 500,
      },
      {
        id: "post-narrator",
        label: "Post-Narrator",
        rangeLabel: "501-1000",
        minPriority: 501,
        maxPriority: 1000,
      },
    ],
    plugins,
    steps,
  };
}
