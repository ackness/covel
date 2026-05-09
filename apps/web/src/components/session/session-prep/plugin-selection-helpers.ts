import type * as api from "@/services/api.js";
import {
  defaultSelectedPluginIdsForWorld as computeDefaultSelectedPluginIdsForWorld,
  readWorldPluginPolicy,
} from "@/lib/session-plugin-selection.js";

export function isLockedCorePackage(
  pkg: Pick<api.PackageSummary, "pluginType" | "source">,
): boolean {
  return (
    pkg.pluginType === "core-plugin" &&
    (pkg.source === undefined || pkg.source === "builtin")
  );
}

export function defaultSelectedPluginIdsForWorld(
  world: api.WorldRecord,
  packages: readonly api.PackageSummary[],
): Set<string> {
  return computeDefaultSelectedPluginIdsForWorld(
    world,
    packages,
    isLockedCorePackage,
  );
}

export function requiredPluginIdsForWorld(world: api.WorldRecord): Set<string> {
  return new Set(readWorldPluginPolicy(world).requiredPlugins);
}

export function excludedPluginIdsForWorld(world: api.WorldRecord): Set<string> {
  return new Set(readWorldPluginPolicy(world).excludedPlugins);
}
