import {
  getPluginTrustInfo,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { RpcApprovalGate } from "@covel/approval";
import type { SessionRecord } from "@covel/store";
import {
  disabledDependents,
  resolveConfirmedSessionPlugins,
  resolveSessionPlugins,
  type PluginResolutionRejection,
  type SessionPlugin,
  type SnapshotPluginStatus,
  type SessionPluginResolution,
  type UnmetWorldRequirement,
} from "@covel/shared";
import {
  buildPluginSummary,
  pluginContractFacts,
} from "../../../lib/plugin-descriptor.js";
import { hasServerCodeGrant } from "../approval-verdict.js";

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
  registry: Pick<PluginRegistry, "getAll">,
  gate?: RpcApprovalGate,
  session?: SessionRecord,
): string[] {
  return [...registry.getAll().values()]
    .filter(
      (entry) =>
        getPluginTrustInfo(entry.id, entry.source).autoLoad ||
        Boolean(session && gate && hasServerCodeGrant(gate, session, entry.id)),
    )
    .map((entry) => entry.id);
}
export function resolveSessionPluginPlan(
  requested: readonly string[],
  registry: Pick<PluginRegistry, "getAll">,
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
    plugins: resolvablePlugins(registry.getAll().values()).map((facts) => ({
      ...facts,
      authorized: authorized.has(facts.id),
    })),
  });
}

/**
 * The set a session confirms from a plan: the plugins that run, plus the
 * requested and `core` ones turned off for a missing dependency
 * (`disabledDependents`). The session's set resolution keeps those off and
 * lists them in `unavailable` until the dependency is back.
 */
export function confirmedPluginIds(
  plan: SessionPluginResolution,
  requested: readonly string[],
  registry: Pick<PluginRegistry, "getAll">,
): string[] {
  const dependents = disabledDependents(plan, {
    requested,
    plugins: resolvablePlugins(registry.getAll().values()),
  }).map((item) => item.pluginId);
  return [...new Set([...plan.active, ...dependents])];
}

/** Installed entries that can join a session; a package that failed to load cannot. */
function resolvablePlugins(entries: Iterable<PluginRegistryEntry>) {
  return [...entries]
    .filter((entry) => entry.status !== "error")
    .map(pluginContractFacts);
}

/**
 * The one authority for a session's plugin set: the plugins the player
 * confirmed (`session.activePlugins`), checked against the installed
 * versions. The plugin list, slash commands and the executor (through the
 * registry's `resolveSessionSet`) all read it; nothing joins on its own.
 */
export function resolveSessionPluginSet(
  confirmed: readonly string[],
  entries: ReadonlyMap<string, PluginRegistryEntry>,
  requiredContracts?: readonly string[],
): SessionPluginResolution {
  const set = resolveConfirmedSessionPlugins({
    confirmed,
    plugins: resolvablePlugins(entries.values()),
    ...(requiredContracts ? { requiredContracts } : {}),
  });
  return {
    ...set,
    rejected: set.rejected.map((item) =>
      item.code === "unknown-plugin" && entries.has(item.pluginId)
        ? { ...item, reason: `Plugin ${item.pluginId} failed to load` }
        : item,
    ),
  };
}

/**
 * The confirmed plugins that can run now (`resolveSessionPluginSet`). Every
 * execution gate reads this, never the stored IDs: a member whose
 * requirement is gone, that conflicts or that failed to load is disabled
 * everywhere, and the plugin list's `unavailable` tells the player why.
 */
export function runnablePluginIds(
  confirmed: readonly string[],
  registry: Pick<PluginRegistry, "getAll">,
): string[] {
  return resolveSessionPluginSet(confirmed, registry.getAll()).active;
}

/** IDs of the session's plugin set; see `runnablePluginIds`. */
export function sessionPluginIds(
  session: Pick<SessionRecord, "activePlugins">,
  registry: Pick<PluginRegistry, "getAll">,
): string[] {
  return runnablePluginIds(session.activePlugins ?? [], registry);
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
    trustedSources?: import("../../../trust/trusted-source-service.js").TrustedSourceService;
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
      ...buildPluginSummary(
        entry,
        options.isEntryPublished,
        options.trustedSources,
      ),
      serverCodeApproved: authorized.has(entry.id),
      ...(authorized.has(entry.id) && entry.source !== "builtin"
        ? {
            serverCodeApprovedBy: options.trustedSources?.implicitGrant({
              pluginId: entry.id,
            })
              ? ("trusted-source" as const)
              : ("session" as const),
          }
        : {}),
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

/**
 * Shared read-only projection for session lists and diagnostics. It shows the
 * session's plugin set (`resolveSessionPluginSet`); members and requested
 * plugins whose server code awaits approval are marked so the player can
 * approve them, and `unavailable` lists the members that cannot run now.
 */
export function buildSessionPluginView(
  session: SessionRecord,
  registry: PluginRegistry,
  options: {
    authorized: readonly string[];
    trustedSources?: import("../../../trust/trusted-source-service.js").TrustedSourceService;
    isEntryPublished?: (pluginId: string) => boolean;
  },
): {
  items: SessionPlugin[];
  resolution: SessionPluginResolution;
  unavailable: PluginResolutionRejection[];
} {
  const selection = readSessionPluginSelection(session);
  const set = resolveSessionPluginSet(
    session.activePlugins ?? [],
    registry.getAll(),
    selection.requiredContracts,
  );
  const authorized = new Set(options.authorized);
  const awaitingApproval = [
    ...new Set([...set.active, ...selection.requested]),
  ].filter((id) => {
    const entry = registry.get(id);
    return (
      entry !== undefined &&
      entry.status !== "error" &&
      !selection.excluded.includes(id) &&
      getPluginTrustInfo(id, entry.source).source === "community" &&
      !authorized.has(id)
    );
  });
  const resolution: SessionPluginResolution = {
    ...set,
    active: set.active.filter((id) => !awaitingApproval.includes(id)),
    rejected: [
      ...set.rejected,
      ...awaitingApproval.map((pluginId): PluginResolutionRejection => ({
        pluginId,
        code: "approval-required",
        reason: `Plugin ${pluginId} requires approval`,
      })),
    ],
  };
  return {
    items: buildAvailablePluginList(
      resolution.active,
      registry,
      resolution,
      options,
    ),
    resolution,
    unavailable: set.rejected,
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
