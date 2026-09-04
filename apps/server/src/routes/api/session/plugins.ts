import {
  getPluginTrustInfo,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { SessionRecord } from "@covel/store";
import { FrameworkCapability } from "@covel/shared";
import type {
  PluginRelations,
  SessionPlugin,
  SnapshotPluginStatus,
} from "@covel/shared";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import { pluginManifestRecords } from "../../misc-api/registry-projection.js";
import { sessionApprovalScope } from "./session-guard.js";

/** Exclude community server code unless this session owns a live grant. */
export function approvedActivePlugins(
  pluginIds: readonly string[],
  registry: PluginRegistry,
  gate: RpcApprovalGate | undefined,
  session?: SessionRecord,
): string[] {
  return pluginIds.filter((pluginId) => {
    const entry = registry.get(pluginId);
    const trust = getPluginTrustInfo(pluginId, entry?.source);
    return (
      trust.autoLoad ||
      Boolean(
        session &&
        gate?.hasGrant(
          session.id,
          pluginId,
          COMMUNITY_SERVER_CODE_ACTION,
          sessionApprovalScope(session, pluginId),
        ),
      )
    );
  });
}

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
  if (trust.source !== "builtin") return false;

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
      ids.add(pluginIdFromRuntimeOrPlugin(relation));
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

/** `npc-graph/extractor` → `npc-graph`; a bare id passes through. */
function pluginIdFromRuntimeOrPlugin(value: string): string {
  return value.includes("/") ? value.split("/")[0]! : value;
}

export function buildAvailablePluginList(
  active: readonly string[],
  pluginRegistry: PluginRegistry,
): SessionPlugin[] {
  return [...pluginRegistry.getAll().values()].map((entry) => ({
    ...buildPluginSummary(entry),
    active: active.includes(entry.id),
    locked: isRequiredCorePlugin(entry),
  }));
}

export function buildSnapshotPluginList(
  pluginRegistry: PluginRegistry,
  activeIds: ReadonlySet<string>,
): SnapshotPluginStatus[] {
  return [...pluginRegistry.getAll().values()].map((entry) => {
    const plugin = buildPluginSummary(entry);
    const stage = plugin.runtimes[0]?.stage;
    return {
      id: plugin.id,
      displayName: plugin.displayName,
      active: activeIds.has(plugin.id),
      ...(stage !== undefined ? { stage } : {}),
    };
  });
}

export function findWorldDataProviderPluginId(
  activePlugins: readonly string[],
  pluginRegistry: PluginRegistry,
): string | undefined {
  for (const pid of activePlugins) {
    const entry = pluginRegistry.get(pid);
    if (!entry) continue;
    for (const { manifest } of pluginManifestRecords(entry)) {
      if (
        manifest.capabilities?.includes(FrameworkCapability.WorldDataProvider)
      ) {
        return pid;
      }
    }
  }
  return undefined;
}
