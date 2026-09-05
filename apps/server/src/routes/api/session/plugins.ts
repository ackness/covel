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
import { FrameworkCapability, resolvePluginSelection } from "@covel/shared";
import type { SessionPlugin, SnapshotPluginStatus } from "@covel/shared";
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
  return resolvePluginSelection({
    activePluginIds: requestedPlugins,
    requestedPluginIds: requestedPlugins,
    plugins: [...pluginRegistry.getAll().values()].map(buildPluginSummary),
  });
}

export function resolveEnabledSessionPlugins(
  currentPlugins: readonly string[],
  pluginId: string,
  pluginRegistry: PluginRegistry,
): string[] {
  return resolvePluginSelection({
    activePluginIds: [...currentPlugins, pluginId],
    requestedPluginIds: [pluginId],
    plugins: [...pluginRegistry.getAll().values()].map(buildPluginSummary),
  });
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
