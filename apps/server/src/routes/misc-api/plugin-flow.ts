import {
  discoverPluginsMulti,
  loadPluginManifest,
  loadPluginSummary,
} from "@covel/plugin-loader";
import type { I18nText, Stage } from "@covel/shared";
import { getRuntimeSpec, stageRank } from "@covel/shared";
import { resolve } from "node:path";
import {
  docPathFromAbsolute,
  isStoryRuntime,
  resolvePluginsDirs,
  textValue,
  uiSlotsOf,
  type FlowSegmentId,
} from "./shared.js";

export async function buildPluginFlowResponse() {
  const discoveries = await discoverPluginsMulti(resolvePluginsDirs());

  const plugins: Array<{
    id: string;
    name: I18nText;
    description: I18nText;
    pluginType: string;
    runtimeIds: string[];
  }> = [];

  const steps: Array<{
    id: string;
    pluginId: string;
    pluginName: I18nText;
    runtimeId: string;
    runtimeName: string;
    description: string;
    pluginType: string;
    stage?: Stage;
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
      as?: string;
      from?: string;
      field?: string;
      namespace?: string;
      format?: string;
      name?: string;
      recordAs?: string;
    }>;
    tools: { builtin: string[]; local: string[] };
    uiSlots: string[];
    docPath: string;
    isStoryRuntime: boolean;
  }> = [];
  // Stage-driven segments (player-facing plain-language labels). `rangeLabel` is
  // a cosmetic legacy-band hint; the frontend groups by `segmentId`.
  const flowSegments: Array<{
    id: FlowSegmentId;
    labelText: I18nText;
    rangeLabel: string;
  }> = [
    {
      id: "setup",
      labelText: { "zh-CN": "开场准备", "en-US": "Setup" },
      rangeLabel: "0-99",
    },
    {
      id: "pre-turn",
      labelText: { "zh-CN": "叙事前", "en-US": "Pre-Turn" },
      rangeLabel: "100-499",
    },
    {
      id: "narrative",
      labelText: { "zh-CN": "叙事", "en-US": "Narrative" },
      rangeLabel: "500",
    },
    {
      id: "post-turn",
      labelText: { "zh-CN": "叙事后", "en-US": "Post-Turn" },
      rangeLabel: "501-999",
    },
    {
      id: "audit",
      labelText: { "zh-CN": "审计", "en-US": "Audit" },
      rangeLabel: "1000",
    },
    {
      id: "event-manual",
      labelText: { "zh-CN": "事件 / 手动", "en-US": "Event & Manual" },
      rangeLabel: "—",
    },
  ];

  for (const discovery of discoveries) {
    const [summary, manifests] = await Promise.all([
      loadPluginSummary(discovery),
      loadPluginManifest(discovery),
    ]);

    // Serve raw I18nText (frontend resolves to the UI locale), matching
    // /api/packages and the segment labelText — never collapse to one locale
    // server-side. Prefer the friendly displayName, fall back to summary name
    // (an I18nText for multi-runtime packages, else the id).
    const pluginName = summary.displayName ?? summary.name ?? discovery.id;
    const pluginDescription = summary.description;

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
      const stage = getRuntimeSpec(manifest).stage;
      // Staged runtimes map 1:1 to their stage segment; stage-less ones
      // (event / manual) group under the dedicated "event-manual" bucket.
      const segmentId: FlowSegmentId = stage ?? "event-manual";
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
        ...(stage !== undefined ? { stage } : {}),
        segmentId,
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
            ? { from: inject.from, field: inject.field, as: inject.as }
            : inject.kind === "plugin-data"
              ? {
                  namespace: inject.namespace,
                  format: inject.format,
                  as: inject.as,
                }
              : { name: inject.name, recordAs: inject.recordAs }),
        })),
        tools: {
          builtin: [...(manifest.tools?.builtin ?? [])],
          local: [
            // `tools.plugin` are entry-registered tool NAMES — pass through
            // unchanged (a dotted name like `foo.v2` must not lose its suffix).
            ...(manifest.tools?.plugin ?? []),
            // `tools.local` are relative file PATHS — strip dir + extension to
            // recover the tool name (`server/tools/foo.js` → `foo`).
            ...(manifest.tools?.local ?? []).map((toolPath) => {
              const fileName = toolPath.split("/").at(-1) ?? toolPath;
              return fileName.replace(/\.[^.]+$/, "");
            }),
          ],
        },
        uiSlots: uiSlotsOf(manifest),
        docPath,
        isStoryRuntime: isStoryRuntime(manifest),
      });
    }
  }

  // Order by (stage, name): earlier stages first, stage-less runtimes last.
  steps.sort(
    (a, b) =>
      stageRank(a.stage) - stageRank(b.stage) ||
      a.runtimeId.localeCompare(b.runtimeId),
  );
  plugins.sort((a, b) => a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    segments: flowSegments.map((segment) => ({
      ...segment,
      label: textValue(segment.labelText),
    })),
    plugins,
    steps,
  };
}
