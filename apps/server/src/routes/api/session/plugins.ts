import {
  getPluginTrustInfo,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import { FrameworkCapability } from "@covel/shared";
import type { PluginRelation, PluginRelations } from "@covel/shared";

export function isRequiredCorePlugin(entry: PluginRegistryEntry): boolean {
  const trust = getPluginTrustInfo(entry.id, entry.source);
  return (
    entry.summary.pluginType === "core-plugin" && trust.source === "builtin"
  );
}

function requiredCorePluginIds(pluginRegistry: PluginRegistry): string[] {
  return [...pluginRegistry.getAll().values()]
    .filter(isRequiredCorePlugin)
    .map((entry) => entry.id);
}

export function unknownPluginIds(
  requestedPlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string[] {
  return requestedPlugins.filter((pid) => !pluginRegistry.get(pid));
}

export function resolveSessionPlugins(
  requestedPlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string[] {
  return resolveSessionPluginSet({
    activePluginIds: requestedPlugins,
    requestedPluginIds: requestedPlugins,
    pluginRegistry,
  });
}

export function resolveEnabledSessionPlugins(
  currentPlugins: readonly string[],
  pluginId: string,
  pluginRegistry: PluginRegistry,
): string[] {
  return resolveSessionPluginSet({
    activePluginIds: [...currentPlugins, pluginId],
    requestedPluginIds: [pluginId],
    pluginRegistry,
  });
}

function resolveSessionPluginSet(args: {
  readonly activePluginIds: readonly string[];
  readonly requestedPluginIds: readonly string[];
  readonly pluginRegistry: PluginRegistry;
}): string[] {
  const { activePluginIds, requestedPluginIds, pluginRegistry } = args;
  const requested = new Set(requestedPluginIds);
  const corePlugins = new Set(requiredCorePluginIds(pluginRegistry));
  const active = new Set([...activePluginIds, ...corePlugins]);

  expandRequiredRelations(active, pluginRegistry);
  applyConflictRelations(active, requested, pluginRegistry, corePlugins);
  pruneUnsatisfiedRelations(active, pluginRegistry, corePlugins);

  return [...active];
}

function expandRequiredRelations(
  active: Set<string>,
  pluginRegistry: PluginRegistry,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const pluginId of [...active]) {
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
  pluginRegistry: PluginRegistry,
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
  pluginRegistry: PluginRegistry,
  protectedPluginIds: ReadonlySet<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const pluginId of [...active]) {
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
        requiredPluginIds.length > 0 &&
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
  readonly sourceEntry: PluginRegistryEntry | undefined;
  readonly targetEntry: PluginRegistryEntry | undefined;
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
  sourceEntry: PluginRegistryEntry | undefined,
  targetEntry: PluginRegistryEntry | undefined,
): boolean {
  if (!sourceEntry || !targetEntry) return false;
  const trust = getPluginTrustInfo(sourceEntry.id, sourceEntry.source);
  if (trust.source !== "builtin" && trust.source !== "official") return false;

  const sourceProvides = new Set(relationPluginIds(sourceEntry, "provides"));
  if (sourceProvides.size === 0) return false;
  return relationPluginIds(targetEntry, "provides").some((provided) =>
    sourceProvides.has(provided),
  );
}

function relationPluginIds(
  entry: PluginRegistryEntry,
  kind: keyof PluginRelations,
): string[] {
  const ids = new Set<string>();
  for (const relations of entryRelations(entry)) {
    for (const relation of relations[kind] ?? []) {
      const pluginId = relationPluginId(relation);
      if (pluginId) ids.add(pluginId);
    }
  }
  return [...ids];
}

function entryRelations(entry: PluginRegistryEntry): PluginRelations[] {
  const relations: PluginRelations[] = [];
  if (entry.summary.relations) relations.push(entry.summary.relations);
  if (entry.manifest?.manifest.relations) {
    relations.push(entry.manifest.manifest.relations);
  }
  for (const parsed of entry.manifests ?? []) {
    if (parsed.manifest.relations) relations.push(parsed.manifest.relations);
  }
  return relations;
}

function relationPluginId(
  relation: string | PluginRelation,
): string | undefined {
  if (typeof relation === "string")
    return pluginIdFromRuntimeOrPlugin(relation);
  if (typeof relation.plugin === "string") return relation.plugin;
  if (typeof relation.runtime === "string") {
    return pluginIdFromRuntimeOrPlugin(relation.runtime);
  }
  const target = relation.target;
  if (typeof target === "string") return pluginIdFromRuntimeOrPlugin(target);
  if (target && typeof target.plugin === "string") return target.plugin;
  if (target && typeof target.runtime === "string") {
    return pluginIdFromRuntimeOrPlugin(target.runtime);
  }
  return undefined;
}

function pluginIdFromRuntimeOrPlugin(value: string): string {
  return value.includes("/") ? value.split("/")[0]! : value;
}

export function buildAvailablePluginList(
  active: readonly string[],
  pluginRegistry: PluginRegistry,
): Array<Record<string, unknown>> {
  const all = pluginRegistry.getAll();
  return Array.from(all.values()).map((entry) => {
    // Aggregated capabilities (plugin-level + runtime-level union) keep the
    // existing UI surface working: gates only need "does this plugin do X".
    const caps: string[] = [];
    const tags: string[] = [];
    if (entry.manifest?.manifest.capabilities) {
      caps.push(...entry.manifest.manifest.capabilities);
    }
    for (const tag of entry.summary.tags ?? []) {
      if (!tags.includes(tag)) tags.push(tag);
    }

    const runtimes: Array<{
      id: string;
      runtimeType?: string;
      model?: string;
      outputKind?: string;
      trigger?: { type: string; topic?: string };
      capabilities?: string[];
      tags?: string[];
      relations?: unknown;
    }> = [];
    for (const [, loaded] of entry.loadedRuntimes) {
      const m = loaded.manifest;
      if (m.capabilities) {
        for (const c of m.capabilities) {
          if (!caps.includes(c)) caps.push(c);
        }
      }
      for (const tag of m.tags ?? []) {
        if (!tags.includes(tag)) tags.push(tag);
      }
      runtimes.push({
        id: m.name,
        ...(m.runtimeType ? { runtimeType: m.runtimeType } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.outputKind ? { outputKind: m.outputKind } : {}),
        ...(m.trigger
          ? {
              trigger: {
                type: m.trigger.type,
                ...(m.trigger.topic ? { topic: m.trigger.topic } : {}),
              },
            }
          : {}),
        ...(m.capabilities && m.capabilities.length > 0
          ? { capabilities: [...m.capabilities] }
          : {}),
        ...(m.tags && m.tags.length > 0 ? { tags: [...m.tags] } : {}),
        ...(m.relations ? { relations: m.relations } : {}),
      });
    }

    const trust = getPluginTrustInfo(entry.id, entry.source);
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      source: trust.source,
      active: active.includes(entry.id),
      ...(caps.length > 0 ? { capabilities: caps } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(entry.summary.relations
        ? { relations: entry.summary.relations }
        : {}),
      ...(runtimes.length > 0 ? { runtimes } : {}),
    };
  });
}

export function buildSnapshotPluginList(
  pluginRegistry: PluginRegistry,
  activeIds: ReadonlySet<string>,
): Array<{
  id: string;
  name: string;
  isActive: boolean;
  priority: number;
}> {
  const pluginList: Array<{
    id: string;
    name: string;
    isActive: boolean;
    priority: number;
  }> = [];
  for (const [, entry] of pluginRegistry.getAll()) {
    const manifests =
      entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
    const primary = manifests[0]?.manifest;
    pluginList.push({
      id: entry.id,
      name:
        typeof entry.summary.name === "string" ? entry.summary.name : entry.id,
      isActive: activeIds.has(entry.id),
      priority: primary?.priority ?? 500,
    });
  }
  return pluginList;
}

export function findWorldDataProviderPluginId(
  activePlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string | undefined {
  for (const pid of activePlugins) {
    const entry = pluginRegistry.get(pid);
    if (!entry) continue;
    if (
      entry.manifest?.manifest.capabilities?.includes(
        FrameworkCapability.WorldDataProvider,
      )
    ) {
      return pid;
    }
    for (const [, loaded] of entry.loadedRuntimes) {
      if (
        loaded.manifest.capabilities?.includes(
          FrameworkCapability.WorldDataProvider,
        )
      ) {
        return pid;
      }
    }
  }
  return undefined;
}
