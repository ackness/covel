import type * as api from "@/services/api.js";

export function isLockedCorePackage(
  pkg: Pick<api.PluginSummary, "kind" | "source">,
): boolean {
  return pkg.kind === "core" && pkg.source === "builtin";
}

export function requiredPluginIdsForWorld(
  plan: api.WorldPluginPlan | null,
): Set<string> {
  return new Set(plan?.policy.requested ?? []);
}
