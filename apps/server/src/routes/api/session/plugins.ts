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
import {
  resolveSessionPlugins,
  sessionWorldContextV1,
  historyCompactV1,
  mediaImageFlowV1,
  type SessionPlugin,
  type SnapshotPluginStatus,
  type SessionPluginResolution,
} from "@covel/shared";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import { sessionApprovalScope } from "./session-guard.js";

const singlePoints = new Set([
  sessionWorldContextV1.id,
  historyCompactV1.id,
  mediaImageFlowV1.id,
]);
export function readSessionPluginSelection(session: SessionRecord): {
  requested: string[];
  excluded: string[];
} {
  const raw = session.metadata?.pluginSelection;
  const selection =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
  return {
    requested: strings(selection.requested),
    excluded: strings(selection.excluded),
  };
}
export function authorizedSessionPluginIds(
  registry: PluginRegistry,
  gate?: RpcApprovalGate,
  session?: SessionRecord,
): string[] {
  return [...registry.getAll().values()]
    .filter(
      (entry) =>
        getPluginTrustInfo(entry.id, entry.source).autoLoad ||
        Boolean(
          session &&
          gate?.hasGrant(
            session.id,
            entry.id,
            COMMUNITY_SERVER_CODE_ACTION,
            sessionApprovalScope(session, entry.id),
          ),
        ),
    )
    .map((entry) => entry.id);
}
export function resolveSessionPluginPlan(
  requested: readonly string[],
  registry: PluginRegistry,
  options: {
    excluded?: readonly string[];
    authorized?: readonly string[];
  } = {},
): SessionPluginResolution {
  const authorized = new Set(
    options.authorized ?? authorizedSessionPluginIds(registry),
  );
  return resolveSessionPlugins({
    requested,
    excluded: options.excluded,
    plugins: [...registry.getAll().values()]
      .filter((entry) => entry.status !== "error")
      .map((entry) => {
        const summary = buildPluginSummary(entry);
        return {
          id: entry.id,
          kind: summary.kind,
          source: summary.source,
          authorized: authorized.has(entry.id),
          provides: summary.provides,
          requires: summary.requires,
          optional: summary.optional,
          conflicts: summary.conflicts,
          singlePoints: summary.extensions
            .filter((extension) => singlePoints.has(extension.point))
            .map((extension) => extension.point),
        };
      }),
  });
}
/** Resolve the entire authorized graph rather than filtering its providers afterward. */
export function approvedActivePlugins(
  pluginIds: readonly string[],
  registry: PluginRegistry,
  gate: RpcApprovalGate | undefined,
  session?: SessionRecord,
): string[] {
  return resolveSessionPluginPlan(pluginIds, registry, {
    authorized: authorizedSessionPluginIds(registry, gate, session),
    ...(session
      ? { excluded: readSessionPluginSelection(session).excluded }
      : {}),
  }).active;
}
export function isRequiredCorePlugin(entry: PluginRegistryEntry): boolean {
  return entry.packageManifest?.plugin?.kind === "core";
}
export function unknownPluginIds(
  requestedPlugins: readonly string[],
  registry: PluginRegistry,
): string[] {
  return requestedPlugins.filter((id) => !registry.get(id));
}
export function buildAvailablePluginList(
  active: readonly string[],
  registry: PluginRegistry,
  plan?: SessionPluginResolution,
): SessionPlugin[] {
  return [...registry.getAll().values()].map((entry) => {
    const rejection = plan?.rejected.find((item) => item.pluginId === entry.id);
    const isActive = active.includes(entry.id);
    return {
      ...buildPluginSummary(entry),
      active: isActive,
      locked: false,
      sessionState: isActive
        ? "active"
        : rejection?.code === "approval-required"
          ? "approval-required"
          : rejection
            ? "rejected"
            : "inactive",
      ...(plan?.autoAdded.includes(entry.id) ? { autoAdded: true } : {}),
      ...(rejection ? { rejection } : {}),
      ...(rejection?.code === "approval-required"
        ? { approvalRequired: true }
        : {}),
    };
  });
}
export function buildSnapshotPluginList(
  registry: PluginRegistry,
  activeIds: ReadonlySet<string>,
): SnapshotPluginStatus[] {
  return [...registry.getAll().values()].map((entry) => {
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
