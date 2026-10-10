import { getPluginTrustInfo, type PluginRegistry } from "@covel/plugin-loader";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type RpcApprovalGate,
} from "@covel/approval";
import type { SessionRecord } from "@covel/store";
import {
  resolveSessionPlugins,
  type SessionPlugin,
  type SnapshotPluginStatus,
  type SessionPluginResolution,
  type UnmetWorldRequirement,
} from "@covel/shared";
import { buildPluginSummary } from "../../../lib/plugin-descriptor.js";
import { sessionApprovalScope } from "./session-guard.js";

/**
 * A session's stored plugin selection. `requiredContracts` is the world's
 * `pluginPolicy.requires` as of session creation, kept with the session so
 * every later resolution treats the world as a requirer without reloading it.
 */
export interface SessionPluginSelection {
  requested: string[];
  excluded: string[];
  requiredContracts: string[];
}

/** The shape persisted under `session.metadata.pluginSelection`. */
export function storedPluginSelection(selection: SessionPluginSelection) {
  return {
    requested: selection.requested,
    excluded: selection.excluded,
    ...(selection.requiredContracts.length > 0
      ? { requiredContracts: selection.requiredContracts }
      : {}),
  };
}

export function readSessionPluginSelection(
  session: SessionRecord,
): SessionPluginSelection {
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
    requiredContracts: strings(selection.requiredContracts),
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
    requiredContracts?: readonly string[];
  } = {},
): SessionPluginResolution {
  const authorized = new Set(
    options.authorized ?? authorizedSessionPluginIds(registry),
  );
  return resolveSessionPlugins({
    requested,
    excluded: options.excluded,
    requiredContracts: options.requiredContracts,
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
          extensions: summary.extensions,
          eventTopics: summary.eventTopics,
        };
      }),
  });
}
/** A world record's `pluginPolicy.requires`: contracts it needs a provider for. */
export function worldRequiredContracts(
  world: { metadata?: Readonly<Record<string, unknown>> } | null | undefined,
): string[] {
  const policy = world?.metadata?.pluginPolicy;
  const requires =
    policy && typeof policy === "object" && !Array.isArray(policy)
      ? (policy as Record<string, unknown>).requires
      : undefined;
  return Array.isArray(requires)
    ? requires.filter((item): item is string => typeof item === "string")
    : [];
}

export function unmetRequirementMessage(item: UnmetWorldRequirement): string {
  const candidates = item.candidates?.join(", ");
  switch (item.code) {
    case "ambiguous-provider":
      return `This world requires ${item.contract}, which several installed plugins provide (${candidates}). Request one of them.`;
    case "approval-required":
      return `This world requires ${item.contract}; its provider (${candidates}) awaits approval.`;
    case "excluded":
      return `This world requires ${item.contract}, but every provider (${candidates}) is disabled.`;
    case "missing-provider":
      return candidates
        ? `This world requires ${item.contract}, but its provider (${candidates}) cannot be activated.`
        : `This world requires ${item.contract}, and no installed plugin provides it.`;
  }
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
  options: {
    authorized?: readonly string[];
    isEntryPublished?: (pluginId: string) => boolean;
  } = {},
): SessionPlugin[] {
  const authorized = new Set(
    options.authorized ?? authorizedSessionPluginIds(registry),
  );
  return [...registry.getAll().values()].map((entry) => {
    const rejection = plan?.rejected.find((item) => item.pluginId === entry.id);
    const isActive = active.includes(entry.id);
    return {
      ...buildPluginSummary(entry, options.isEntryPublished),
      serverCodeApproved: authorized.has(entry.id),
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

/** Shared read-only projection for session lists and diagnostics. */
export function buildSessionPluginView(
  session: SessionRecord,
  registry: PluginRegistry,
  options: {
    authorized: readonly string[];
    isEntryPublished?: (pluginId: string) => boolean;
  },
): { items: SessionPlugin[]; resolution: SessionPluginResolution } {
  const selection = readSessionPluginSelection(session);
  const resolution = resolveSessionPluginPlan(selection.requested, registry, {
    excluded: selection.excluded,
    authorized: options.authorized,
    requiredContracts: selection.requiredContracts,
  });
  return {
    items: buildAvailablePluginList(
      resolution.active,
      registry,
      resolution,
      options,
    ),
    resolution,
  };
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
