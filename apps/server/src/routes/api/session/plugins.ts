import { resolveWorldPluginSelection } from "@covel/shared";
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
import type { HostProfile } from "../../../host-profile.js";
import type { PermissionService } from "../../../trust/permission-service.js";
import {
  declarativeAdmissionDecision,
  isDeclarativeAdmitted,
} from "../../../trust/plugin-admission.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import { hasServerCodeGrant } from "../approval-verdict.js";

/**
 * A session's stored plugin selection. `requiredContracts` is the world's
 * explicit contract references as of session creation, kept with the session so
 * every later resolution treats the world as a requirer without reloading it.
 */
export interface SessionPluginSelection {
  requested: string[];
  excluded: string[];
  requiredContracts: string[];
  requiredDataContracts: string[];
}

/** The shape persisted under `session.metadata.pluginSelection`. */
export function storedPluginSelection(selection: SessionPluginSelection) {
  return {
    requiredDataContracts: selection.requiredDataContracts,
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
    requiredDataContracts: strings(selection.requiredDataContracts),
  };
}
export function authorizedSessionPluginIds(
  registry: Pick<PluginRegistry, "getAll">,
  gate?: RpcApprovalGate,
  session?: SessionRecord,
  trustedSources?: TrustedSourceService,
  permissionOptions?: {
    readonly permissionService?: PermissionService;
    readonly allowCommunityCode?: boolean;
  },
): string[] {
  const permissionService = permissionOptions?.permissionService;
  const communityCodeAllowed =
    permissionOptions?.allowCommunityCode ??
    (permissionService
      ? permissionService.snapshot().capabilities["plugin.communityCode"] ===
        "enabled"
      : true);
  return [...registry.getAll().values()]
    .filter((entry) => {
      if (getPluginTrustInfo(entry.id, entry.source).autoLoad) return true;
      const declDecision = declarativeAdmissionDecision(
        trustedSources,
        permissionService,
        entry.id,
      );
      if (declDecision === "allow") return true;
      if (declDecision === "deny") return false;
      if (declDecision === "ask") {
        return Boolean(
          session && gate && hasServerCodeGrant(gate, session, entry.id),
        );
      }
      if (!communityCodeAllowed) return false;
      if (session && gate && hasServerCodeGrant(gate, session, entry.id)) {
        return true;
      }
      if (
        !session &&
        permissionService?.hasPersistentServerCodeGrant(entry.id, {
          isOperator: communityCodeAllowed,
        })
      ) {
        return true;
      }
      return false;
    })
    .map((entry) => entry.id);
}

/**
 * Helper plugins declaring `globalSessionDefault: "optional"` that are allowed
 * to join new sessions by default under L1/L2/L3 `plugin.globalAutoEnable`.
 */
export function globalDefaultSessionPluginIds(
  registry: Pick<PluginRegistry, "getAll">,
  options?: {
    readonly permissionService?: PermissionService;
    readonly profile?: HostProfile;
    readonly isOperator?: boolean;
  },
): string[] {
  const ids: string[] = [];
  for (const entry of registry.getAll().values()) {
    if (entry.status === "error") continue;
    const pluginManifest = entry.packageManifest?.plugin;
    if (pluginManifest?.globalSessionDefault !== "optional") continue;
    if ((pluginManifest.scope ?? "session") === "instance") continue;
    if (options?.permissionService) {
      const state = options.permissionService.evaluateCapabilityForPlugin(
        "plugin.globalAutoEnable",
        entry.id,
        options.profile,
        options.isOperator ?? false,
      );
      const allowed = getPluginTrustInfo(entry.id, entry.source).autoLoad
        ? state.effective !== "deny"
        : state.effective === "allow";
      if (!allowed) continue;
    }
    ids.push(entry.id);
  }
  return ids;
}

export function resolveSessionPluginPlan(
  requested: readonly string[],
  registry: Pick<PluginRegistry, "getAll">,
  options: {
    excluded?: readonly string[];
    authorized?: readonly string[];
    requiredContracts?: readonly string[];
    requiredDataContracts?: readonly string[];
    automaticPluginIds?: readonly string[];
    globalDefaults?: readonly string[];
  } = {},
): SessionPluginResolution {
  const authorized = new Set(
    options.authorized ?? authorizedSessionPluginIds(registry),
  );
  return resolveSessionPlugins({
    requested,
    excluded: options.excluded,
    requiredContracts: options.requiredContracts,
    requiredDataContracts: options.requiredDataContracts,
    automaticPluginIds: options.automaticPluginIds,
    globalDefaults: options.globalDefaults,
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
  requiredDataContracts?: readonly string[],
): SessionPluginResolution {
  const set = resolveConfirmedSessionPlugins({
    confirmed,
    plugins: resolvablePlugins(entries.values()),
    ...(requiredContracts ? { requiredContracts } : {}),
    requiredDataContracts,
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
/** Explicit world contracts, frozen into the session on creation. */
export function worldRequiredContracts(
  world: { metadata?: Readonly<Record<string, unknown>> } | null | undefined,
): string[] {
  return [
    ...resolveWorldPluginSelection(world?.metadata?.plugins, []).selection
      .requiredContracts,
  ];
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
    permissionService?: import("../../../trust/permission-service.js").PermissionService;
    isEntryPublished?: (pluginId: string) => boolean;
    isServerCodeApproved?: (pluginId: string) => boolean;
  } = {},
): SessionPlugin[] {
  const authorized = new Set(
    options.authorized ?? authorizedSessionPluginIds(registry),
  );
  return [...registry.getAll().values()].map((entry) => {
    const rejection = plan?.rejected.find((item) => item.pluginId === entry.id);
    const isActive = active.includes(entry.id);
    const declarative = isDeclarativeAdmitted(
      options.trustedSources,
      options.permissionService,
      entry.id,
    );
    const codeApproved =
      entry.source === "builtin" ||
      (options.isServerCodeApproved?.(entry.id) ??
        (!declarative && authorized.has(entry.id)));
    return {
      ...buildPluginSummary(
        entry,
        options.isEntryPublished,
        options.trustedSources,
      ),
      serverCodeApproved: codeApproved,
      ...(codeApproved && entry.source !== "builtin"
        ? {
            serverCodeApprovedBy:
              options.permissionService?.hasPersistentServerCodeGrant(entry.id)
                ? ("persistent-grant" as const)
                : options.trustedSources?.implicitGrant({
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
      approvalRequired: !declarative && rejection?.code === "approval-required",
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
    paused?: readonly import("@covel/runtime").PluginFaultState[];
    trustedSources?: import("../../../trust/trusted-source-service.js").TrustedSourceService;
    permissionService?: import("../../../trust/permission-service.js").PermissionService;
    isEntryPublished?: (pluginId: string) => boolean;
    isServerCodeApproved?: (pluginId: string) => boolean;
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
    selection.requiredDataContracts,
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
    ).map((item) => {
      const paused = options.paused?.find(
        (state) => state.pluginId === item.id,
      );
      return paused?.reason
        ? { ...item, paused: { reason: paused.reason } }
        : item;
    }),
    resolution,
    unavailable: set.rejected,
  };
}

export function buildSnapshotPluginList(
  registry: PluginRegistry,
  activeIds: ReadonlySet<string>,
  paused: readonly import("@covel/runtime").PluginFaultState[] = [],
): SnapshotPluginStatus[] {
  return [...registry.getAll().values()].map((entry) => {
    const plugin = buildPluginSummary(entry);
    const stage = plugin.runtimes[0]?.stage;
    const reason = paused.find((state) => state.pluginId === plugin.id)?.reason;
    return {
      id: plugin.id,
      ...(reason ? { paused: { reason } } : {}),
      displayName: plugin.displayName,
      active: activeIds.has(plugin.id),
      ...(stage !== undefined ? { stage } : {}),
    };
  });
}
