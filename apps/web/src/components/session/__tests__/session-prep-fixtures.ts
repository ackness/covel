import type { WorldPluginPlan } from "@covel/shared";

export function worldPluginPlanFixture(
  worldId: string,
  selection: WorldPluginPlan["selection"],
  diagnostics: WorldPluginPlan["diagnostics"] = [],
): WorldPluginPlan {
  return {
    worldId,
    selection,
    packs: [],
    defaultPluginIds: selection.requestedPluginIds,
    diagnostics,
  };
}
