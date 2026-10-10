import { compareText } from "@covel/shared";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { WorldDataDiagnostic } from "./types.js";
import type { ParsedWorldDataTarget } from "./target-uri.js";

export interface ResolvedPluginDataTarget {
  readonly kind: "plugin-data";
  readonly pluginId: string;
  readonly namespace: string;
  readonly lorebook: boolean;
}
export type ResolvedWorldDataTarget =
  | Exclude<ParsedWorldDataTarget, { kind: "contract-data" }>
  | ResolvedPluginDataTarget;

/** Resolve only declared, active receivers; a contract may fan out to many layouts. */
export function resolveWorldDataTargets(
  target: ParsedWorldDataTarget,
  deps:
    | {
        readonly registry?: Pick<PluginRegistry, "get" | "getAll">;
        readonly activePlugins?: readonly string[];
      }
    | undefined,
  sourceId: string,
  diagnostics: WorldDataDiagnostic[],
): readonly ResolvedWorldDataTarget[] {
  if (target.kind !== "contract-data") return [target];
  const receivers: ResolvedPluginDataTarget[] = [];
  let registered = false;
  for (const [pluginId, entry] of deps?.registry?.getAll() ?? []) {
    const data = entry.packageManifest?.plugin?.contributes?.data ?? {};
    for (const [namespace, declaration] of Object.entries(data)) {
      if (!declaration.accepts?.includes(target.contract)) continue;
      registered = true;
      if (
        entry.status === "error" ||
        (deps?.activePlugins && !deps.activePlugins.includes(pluginId))
      )
        continue;
      receivers.push({
        kind: "plugin-data",
        pluginId,
        namespace,
        lorebook: target.lorebook,
      });
    }
  }
  if (!registered || !receivers.length)
    diagnostics.push({
      level: registered ? "warning" : "error",
      sourceId,
      message: registered
        ? `No active receiver for data contract "${target.contract}"; source skipped`
        : `No registered receiver for data contract "${target.contract}"`,
    });
  return receivers.sort(
    (a, b) =>
      compareText(a.pluginId, b.pluginId) ||
      compareText(a.namespace, b.namespace),
  );
}
