import type { ContextBuildParams } from "@covel/context";
import { datasetToolName, type RuntimeManifest } from "@covel/shared";
import {
  contentBasisOf,
  type ReadBaselineRecorder,
} from "../read-baselines.js";
import type { ToolCallContext, ToolExecutor } from "./tool-executor.js";

/** Only namespaces this agent can write need prompt-read evidence. */
export function selfDataReadObserver(
  manifest: RuntimeManifest,
  executor: ToolExecutor | undefined,
  context: ToolCallContext,
  recorder: ReadBaselineRecorder,
): ContextBuildParams["onSelfDataRead"] {
  if (!executor) return undefined;
  const writable = new Set<string>();
  for (const { dataset, tools } of manifest.tools?.datasets ?? []) {
    const declaration =
      manifest.datasets && Object.hasOwn(manifest.datasets, dataset)
        ? manifest.datasets[dataset]
        : undefined;
    if (!declaration) continue;
    if (
      tools.some(
        (kind) =>
          ((kind === "upsert" && declaration.ops.includes("set")) ||
            (kind === "update" &&
              declaration.ops.some((op) => op !== "set"))) &&
          executor.getToolInfo(datasetToolName(dataset, kind), context)
            ?.annotations.stagesWrites,
      )
    )
      writable.add(declaration.namespace);
  }
  // Entry tools that stage proposals can write any own namespace. Read-only
  // tools and unavailable/declarative-filtered tools grant no write access.
  const ownWriteTool = (manifest.tools?.plugin ?? []).some(
    (name) => executor.getToolInfo(name, context)?.annotations.stagesWrites,
  );
  if (!ownWriteTool && writable.size === 0) return undefined;
  return (namespace, entries) => {
    if (!ownWriteTool && !writable.has(namespace)) return;
    for (const { key, value } of entries) {
      recorder.observe({
        kind: "plugin-data",
        pluginId: manifest.pluginId,
        namespace,
        key,
        basis: contentBasisOf({
          exists: true,
          value: value as import("@covel/shared").JsonValue,
        }),
      });
    }
  };
}
