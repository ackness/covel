import type { PluginRelations } from "./types/plugin.js";
import type { PluginSummary } from "./types/plugin-api.js";

type SelectablePlugin = Pick<
  PluginSummary,
  "id" | "pluginType" | "source" | "relations"
>;

/** Resolve dependencies and conflicts identically in session creation and prep. */
export function resolvePluginSelection(args: {
  readonly activePluginIds: readonly string[];
  readonly requestedPluginIds: readonly string[];
  readonly plugins: readonly SelectablePlugin[];
}): string[] {
  const { activePluginIds, requestedPluginIds, plugins } = args;
  const pluginRegistry = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const requested = new Set(requestedPluginIds);
  const corePlugins = new Set(
    plugins
      .filter(
        (plugin) =>
          plugin.pluginType === "core-plugin" && plugin.source === "builtin",
      )
      .map((plugin) => plugin.id),
  );
  const active = new Set([...activePluginIds, ...corePlugins]);

  expandRequiredRelations(active, pluginRegistry);
  applyConflictRelations(active, requested, pluginRegistry, corePlugins);
  pruneUnsatisfiedRelations(active, pluginRegistry, corePlugins);

  return [...active];
}

function expandRequiredRelations(
  active: Set<string>,
  pluginRegistry: ReadonlyMap<string, SelectablePlugin>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const pluginId of active) {
      const entry = pluginRegistry.get(pluginId);
      if (!entry) continue;
      for (const requiredPluginId of relationPluginIds(entry, "requires")) {
        if (
          !pluginRegistry.get(requiredPluginId) ||
          active.has(requiredPluginId)
        ) {
          continue;
        }
        active.add(requiredPluginId);
        changed = true;
      }
    }
  }
}

function applyConflictRelations(
  active: Set<string>,
  requested: ReadonlySet<string>,
  pluginRegistry: ReadonlyMap<string, SelectablePlugin>,
  protectedPluginIds: ReadonlySet<string>,
): void {
  for (const pluginId of [...requested, ...active]) {
    if (!active.has(pluginId)) continue;
    const entry = pluginRegistry.get(pluginId);
    if (!entry) continue;
    const sourceWasRequested = requested.has(pluginId);
    for (const conflictingPluginId of relationPluginIds(entry, "conflicts")) {
      if (
        !active.has(conflictingPluginId) ||
        conflictingPluginId === pluginId
      ) {
        continue;
      }
      const conflictingEntry = pluginRegistry.get(conflictingPluginId);
      if (sourceWasRequested || !requested.has(conflictingPluginId)) {
        const deleted = deleteIfConflictAllowed({
          active,
          pluginId: conflictingPluginId,
          sourceEntry: entry,
          targetEntry: conflictingEntry,
          protectedPluginIds,
        });
        if (!deleted) {
          deleteIfConflictAllowed({
            active,
            pluginId,
            sourceEntry: conflictingEntry,
            targetEntry: entry,
            protectedPluginIds,
          });
          break;
        }
        continue;
      }
      const removedSource = deleteIfConflictAllowed({
        active,
        pluginId,
        sourceEntry: conflictingEntry,
        targetEntry: entry,
        protectedPluginIds,
      });
      if (!removedSource) {
        deleteIfConflictAllowed({
          active,
          pluginId: conflictingPluginId,
          sourceEntry: entry,
          targetEntry: conflictingEntry,
          protectedPluginIds,
        });
      }
      break;
    }
  }
}

function pruneUnsatisfiedRelations(
  active: Set<string>,
  pluginRegistry: ReadonlyMap<string, SelectablePlugin>,
  protectedPluginIds: ReadonlySet<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const pluginId of active) {
      if (protectedPluginIds.has(pluginId)) continue;
      const entry = pluginRegistry.get(pluginId);
      if (!entry) {
        active.delete(pluginId);
        changed = true;
        continue;
      }
      const requiredPluginIds = relationPluginIds(entry, "requires").filter(
        (requiredPluginId) => pluginRegistry.get(requiredPluginId),
      );
      if (
        requiredPluginIds.some(
          (requiredPluginId) => !active.has(requiredPluginId),
        )
      ) {
        active.delete(pluginId);
        changed = true;
      }
    }
  }
}

function deleteIfConflictAllowed(args: {
  readonly active: Set<string>;
  readonly pluginId: string;
  readonly sourceEntry: SelectablePlugin | undefined;
  readonly targetEntry: SelectablePlugin | undefined;
  readonly protectedPluginIds: ReadonlySet<string>;
}): boolean {
  const { active, pluginId, sourceEntry, targetEntry, protectedPluginIds } =
    args;
  if (
    !protectedPluginIds.has(pluginId) ||
    canReplaceProtectedPlugin(sourceEntry, targetEntry)
  ) {
    active.delete(pluginId);
    return true;
  }
  return false;
}

function canReplaceProtectedPlugin(
  sourceEntry: SelectablePlugin | undefined,
  targetEntry: SelectablePlugin | undefined,
): boolean {
  if (!sourceEntry || !targetEntry) return false;
  if (sourceEntry.source !== "builtin") return false;

  const sourceProvides = new Set(relationPluginIds(sourceEntry, "provides"));
  if (sourceProvides.size === 0) return false;
  return relationPluginIds(targetEntry, "provides").some((provided) =>
    sourceProvides.has(provided),
  );
}

function relationPluginIds(
  entry: SelectablePlugin,
  kind: keyof PluginRelations,
): string[] {
  const ids = new Set<string>();
  for (const relation of entry.relations?.[kind] ?? []) {
    ids.add(pluginIdFromRuntimeOrPlugin(relation));
  }
  return [...ids];
}

/** `npc-graph/extractor` → `npc-graph`; a bare id passes through. */
function pluginIdFromRuntimeOrPlugin(value: string): string {
  return value.includes("/") ? value.split("/")[0]! : value;
}
