import type * as api from "@/services/api.js";
import { defaultSelectedPluginIds as computeDefaultSelectedPluginIds } from "@/lib/session-plugin-selection.js";

export function isLockedCorePackage(
  pkg: Pick<api.PluginSummary, "pluginType" | "source">,
): boolean {
  return pkg.pluginType === "core-plugin" && pkg.source === "builtin";
}

export function defaultSelectedPluginIdsForWorld(
  plan: api.WorldPluginPlan | null,
): Set<string> {
  return computeDefaultSelectedPluginIds(plan);
}

export function requiredPluginIdsForWorld(
  plan: api.WorldPluginPlan | null,
): Set<string> {
  return new Set(plan?.policy.requiredPluginIds ?? []);
}

export function excludedPluginIdsForWorld(
  plan: api.WorldPluginPlan | null,
): Set<string> {
  return new Set(plan?.policy.excludedPluginIds ?? []);
}
