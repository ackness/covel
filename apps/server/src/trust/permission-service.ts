import type { Context } from "hono";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  type ImplicitGrantQuery,
  type PolicyDecisionResult,
  type RpcApprovalGate,
} from "@covel/approval";
import {
  computePluginCapabilities,
  getPluginTrustInfo,
  packageHasServerCode,
  pluginRuntimeManifests,
  unknownExecutionAssessment,
  type PluginExecutionAssessment,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  compareText,
  describeServerSetting,
  readEnvString,
  type I18nText,
  type PluginCapabilities,
  type ServerSettingSource,
} from "@covel/shared";
import {
  CAPABILITY_CATALOG,
  CAPABILITY_KEYS,
  PERMISSIONS_POLICY_SERVER_SETTING,
  PERMISSIONS_POLICY_SETTING_KEY,
  evaluatePluginGrantValidity,
  permissionsPolicyFromEnv,
  permissionsPolicySchema,
  pluginGrantDecisionFor,
  resolveEffectiveCapability,
  resolvePermissionsPolicy,
  type CapabilityCeiling,
  type CapabilityDefinition,
  type CapabilityKey,
  type CapabilityPolicyMode,
  type EffectiveCapabilityState,
  type PermissionsPolicyOverrides,
  type PluginGrantDecisions,
  type PluginGrantRecord,
  type PluginGrantStatus,
} from "@covel/shared/permissions";
import type { DataStore } from "@covel/store";
import { errorBody } from "../api-error.js";
import {
  hostProfileOf,
  isOperatorRequest,
  type HostForm,
  type HostProfile,
} from "../host-profile.js";
import type { ServerSettings } from "../lib/server-settings.js";
import type { TrustedSourceService } from "./trusted-source-service.js";

const REFRESH_AFTER_MS = 30_000;

export class PermissionServiceError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code:
      | "plugin_not_found"
      | "builtin_plugin_immutable"
      | "plugin_package_unverified"
      | "plugin_digest_mismatch"
      | "capability_disabled",
    message: string,
  ) {
    super(message);
    this.name = "PermissionServiceError";
  }
}

export interface PermissionsSnapshot {
  readonly deploymentForm: HostForm;
  readonly capabilities: Readonly<Record<CapabilityKey, CapabilityCeiling>>;
  readonly policy: {
    readonly overrides: PermissionsPolicyOverrides;
    readonly effective: Readonly<
      Record<CapabilityKey, EffectiveCapabilityState>
    >;
    readonly source: ServerSettingSource;
    readonly settable: boolean;
  };
  readonly catalog: Readonly<Record<CapabilityKey, CapabilityDefinition>>;
}

export interface PermissionPluginSummary {
  readonly pluginId: string;
  readonly name: I18nText;
  readonly version: string;
  readonly source: "builtin" | "community";
  readonly executionMode: PluginExecutionAssessment["mode"];
  readonly tier: 0 | 3;
  readonly contentDigest: string | null;
  readonly integrity:
    "builtin" | "verified" | "modified" | "no-receipt" | "unreadable";
  readonly trustedSource: boolean;
  readonly sourceAutoApproved: boolean;
  readonly capabilities: PluginCapabilities | null;
  readonly grantStatus: PluginGrantStatus | "builtin";
  readonly grant: PluginGrantRecord | null;
  readonly effectiveCapabilities: Readonly<
    Record<CapabilityKey, EffectiveCapabilityState>
  >;
}

type PermissionGrantBackend = Pick<
  DataStore,
  | "listPluginGrants"
  | "getPluginGrant"
  | "upsertPluginGrant"
  | "deletePluginGrant"
>;

export interface PermissionServiceDeps {
  readonly hostProfile: HostProfile;
  readonly serverSettings: ServerSettings;
  readonly store: PermissionGrantBackend;
  readonly registry: PluginRegistry;
  readonly trustedSources: TrustedSourceService;
  readonly rpcApprovalGate: RpcApprovalGate;
  readonly now?: () => number;
}

export type PermissionService = ReturnType<typeof createPermissionService>;

const capabilityDenials = {
  ceiling: {
    code: "capability_disabled",
    message: "is disabled on this host",
  },
  policy: {
    code: "capability_denied_by_policy",
    message: "is denied by instance policy",
  },
  grant: {
    code: "capability_denied_by_grant",
    message: "is denied by persistent plugin grant",
  },
} as const;

export function capabilityDenialResponse(
  c: Context,
  reason: keyof typeof capabilityDenials,
  key?: string,
  ceiling?: CapabilityCeiling,
): Response {
  const subject = key ? `Capability "${key}"` : "Operation";
  if (reason === "ceiling" && ceiling === "operator-only") {
    return c.json(
      errorBody(`Operator token required for capability "${key}"`, {
        code: "operator_token_required",
      }),
      401,
    );
  }
  const { code, message } = capabilityDenials[reason];
  return c.json(errorBody(`${subject} ${message}`, { code }), 403);
}

export function createPermissionService({
  hostProfile,
  serverSettings,
  store,
  registry,
  trustedSources,
  rpcApprovalGate,
  now = Date.now,
}: PermissionServiceDeps) {
  let grantsCache = new Map<string, PluginGrantRecord>();
  let loadedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | null = null;
  const changeListeners = new Set<(pluginId?: string) => void>();

  function notifyChanged(pluginId?: string): void {
    for (const listener of changeListeners) {
      try {
        listener(pluginId);
      } catch {
        // Cache invalidation listeners must never fail a permission update.
      }
    }
  }

  if (
    readEnvString("COVEL_PERMISSIONS_POLICY") !== undefined &&
    permissionsPolicyFromEnv() === undefined
  ) {
    console.warn(
      "[permissions] Invalid COVEL_PERMISSIONS_POLICY; ignoring the whole value",
    );
  }

  async function load(): Promise<void> {
    const records = await store.listPluginGrants();
    grantsCache = new Map(records.map((record) => [record.pluginId, record]));
    loadedAt = now();
  }

  function refreshWhenStale(): void {
    if (refreshing || now() - loadedAt < REFRESH_AFTER_MS) return;
    refreshing = load()
      .catch((error: unknown) => {
        loadedAt = now();
        console.warn("[permissions] plugin grant refresh failed:", error);
      })
      .finally(() => {
        refreshing = null;
      });
  }

  function policyInfo() {
    const info = describeServerSetting(
      PERMISSIONS_POLICY_SERVER_SETTING,
      serverSettings.stored(PERMISSIONS_POLICY_SETTING_KEY),
      serverSettings.playerWritable,
    );
    const parsed = permissionsPolicySchema.safeParse(info.value);
    return {
      overrides: (parsed.success
        ? parsed.data
        : {}) as PermissionsPolicyOverrides,
      source: info.source,
      settable: info.settable,
    };
  }

  function policy(): Record<CapabilityKey, CapabilityPolicyMode> {
    return resolvePermissionsPolicy(policyInfo().overrides);
  }

  function effectiveCapabilitiesFor(
    profile: HostProfile,
    policyMap: Readonly<Record<CapabilityKey, CapabilityPolicyMode>>,
    grantStatus: PluginGrantStatus | "builtin",
    grant: PluginGrantRecord | null,
    isOperator = false,
  ): Record<CapabilityKey, EffectiveCapabilityState> {
    const out = {} as Record<CapabilityKey, EffectiveCapabilityState>;
    for (const key of CAPABILITY_KEYS) {
      out[key] = resolveEffectiveCapability({
        ceiling: profile.capabilities[key],
        policy: policyMap[key],
        grant: pluginGrantDecisionFor(grantStatus, grant, key),
        isOperator,
      });
    }
    return out;
  }

  function summarizeEntry(
    entry: PluginRegistryEntry,
    profile: HostProfile,
    policyMap: Readonly<Record<CapabilityKey, CapabilityPolicyMode>>,
  ): PermissionPluginSummary {
    const trustSource = getPluginTrustInfo(entry.id, entry.source).source;
    const manifests = pluginRuntimeManifests(entry).map(
      ({ manifest }) => manifest,
    );
    const version =
      (entry.packageManifest?.manifest ?? manifests[0])?.version ?? "0.0.0";
    const name = entry.summary.displayName ?? entry.summary.name ?? entry.id;

    if (trustSource === "builtin") {
      const assessment =
        entry.executionAssessment ?? unknownExecutionAssessment();
      const capabilities = entry.packageManifest
        ? computePluginCapabilities({
            root: entry.packageManifest,
            runtimes: entry.manifests ?? [],
            hasServerCode: packageHasServerCode(assessment),
          })
        : null;
      return {
        pluginId: entry.id,
        name,
        version,
        source: "builtin",
        executionMode: assessment.mode,
        tier: assessment.mode === "declarative" ? 0 : 3,
        contentDigest: null,
        integrity: "builtin",
        trustedSource: false,
        sourceAutoApproved: false,
        capabilities,
        grantStatus: "builtin",
        grant: null,
        effectiveCapabilities: effectiveCapabilitiesFor(
          profile,
          policyMap,
          "builtin",
          null,
        ),
      };
    }

    const inspected = trustedSources.inspect(entry.id);
    const trustSummary = trustedSources.summary(entry.id);
    const executionMode = inspected?.assessment.mode ?? "unknown";
    const grant = grantsCache.get(entry.id) ?? null;
    const grantStatus = evaluatePluginGrantValidity({
      grant,
      currentDigest: inspected?.contentDigest,
      currentCapabilities: inspected?.capabilities,
    });
    return {
      pluginId: entry.id,
      name,
      version,
      source: "community",
      executionMode,
      tier: executionMode === "declarative" ? 0 : 3,
      contentDigest: inspected?.contentDigest ?? null,
      integrity: trustSummary.integrity,
      trustedSource: trustSummary.trustedSource,
      sourceAutoApproved: trustSummary.autoApproved,
      capabilities: inspected?.capabilities ?? null,
      grantStatus,
      grant,
      effectiveCapabilities: effectiveCapabilitiesFor(
        profile,
        policyMap,
        grantStatus,
        grant,
      ),
    };
  }

  function snapshot(profile: HostProfile = hostProfile): PermissionsSnapshot {
    const { overrides, source, settable } = policyInfo();
    const policyMap = resolvePermissionsPolicy(overrides);
    return {
      deploymentForm: profile.form,
      capabilities: profile.capabilities,
      policy: {
        overrides,
        effective: effectiveCapabilitiesFor(profile, policyMap, "none", null),
        source,
        settable,
      },
      catalog: CAPABILITY_CATALOG,
    };
  }

  function communityGrantState(pluginId: string): {
    readonly grant: PluginGrantRecord | null;
    readonly status: PluginGrantStatus | "builtin";
  } {
    const entry = registry.getCurrent(pluginId);
    if (
      !entry ||
      getPluginTrustInfo(pluginId, entry.source).source === "builtin"
    ) {
      return { grant: null, status: "builtin" };
    }
    const grant = grantsCache.get(pluginId) ?? null;
    const inspected = trustedSources.inspect(pluginId);
    const status = evaluatePluginGrantValidity({
      grant,
      currentDigest: inspected?.contentDigest,
      currentCapabilities: inspected?.capabilities,
    });
    return { grant, status };
  }

  function evaluateCapabilityForPlugin(
    key: CapabilityKey,
    pluginId: string,
    profile: HostProfile = hostProfile,
    isOperator = false,
  ): EffectiveCapabilityState {
    refreshWhenStale();
    const policyMap = policy();
    const { grant, status } = communityGrantState(pluginId);
    return resolveEffectiveCapability({
      ceiling: profile.capabilities[key],
      policy: policyMap[key],
      grant: pluginGrantDecisionFor(status, grant, key),
      isOperator,
    });
  }

  function requirePluginEntry(pluginId: string): PluginRegistryEntry {
    const entry = registry.getCurrent(pluginId);
    if (!entry) {
      throw new PermissionServiceError(
        404,
        "plugin_not_found",
        `Plugin "${pluginId}" not found`,
      );
    }
    return entry;
  }

  return {
    load,

    onChange(listener: (pluginId?: string) => void): () => void {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },

    async refresh(): Promise<void> {
      await Promise.all([serverSettings.load(), load()]);
    },

    policyInfo,
    policy,
    snapshot,
    evaluateCapabilityForPlugin,

    async updatePolicy(
      overrides: PermissionsPolicyOverrides | null,
      profile: HostProfile = hostProfile,
    ): Promise<PermissionsSnapshot> {
      await serverSettings.load();
      const patch = serverSettings.parsePatch({
        entries: { [PERMISSIONS_POLICY_SETTING_KEY]: overrides },
      });
      await serverSettings.write(patch);
      notifyChanged();
      return snapshot(profile);
    },

    async listPlugins(
      profile: HostProfile = hostProfile,
    ): Promise<PermissionPluginSummary[]> {
      await Promise.all([
        serverSettings.load(),
        load(),
        trustedSources.verifyAll(),
      ]);
      const policyMap = policy();
      return [...registry.getAll().values()]
        .sort((a, b) => compareText(a.id, b.id))
        .map((entry) => summarizeEntry(entry, profile, policyMap));
    },

    async inspectPlugin(
      pluginId: string,
      profile: HostProfile = hostProfile,
    ): Promise<PermissionPluginSummary> {
      const entry = requirePluginEntry(pluginId);
      await Promise.all([
        serverSettings.load(),
        load(),
        trustedSources.ensureFresh(pluginId),
      ]);
      const policyMap = policy();
      return summarizeEntry(entry, profile, policyMap);
    },

    async setPluginGrant(
      pluginId: string,
      input: {
        readonly decisions: PluginGrantDecisions;
        readonly expectedDigest?: string;
      },
      profile: HostProfile = hostProfile,
    ): Promise<PermissionPluginSummary> {
      const entry = requirePluginEntry(pluginId);
      if (getPluginTrustInfo(pluginId, entry.source).source === "builtin") {
        throw new PermissionServiceError(
          409,
          "builtin_plugin_immutable",
          `Builtin plugin "${pluginId}" cannot be assigned persistent grants`,
        );
      }
      await Promise.all([
        serverSettings.load(),
        trustedSources.ensureFresh(pluginId),
      ]);
      const inspected = trustedSources.inspect(pluginId);
      if (!inspected?.contentDigest || !inspected.capabilities) {
        throw new PermissionServiceError(
          409,
          "plugin_package_unverified",
          `Plugin "${pluginId}" package integrity or declarations are not bound`,
        );
      }
      if (
        input.expectedDigest !== undefined &&
        input.expectedDigest !== inspected.contentDigest
      ) {
        throw new PermissionServiceError(
          409,
          "plugin_digest_mismatch",
          `Plugin "${pluginId}" package digest changed; reload and re-review`,
        );
      }
      for (const [key, decision] of Object.entries(input.decisions) as [
        CapabilityKey,
        "allow" | "deny",
      ][]) {
        if (CAPABILITY_CATALOG[key].reserved) {
          throw new PermissionServiceError(
            403,
            "capability_disabled",
            `Capability "${key}" is reserved and cannot be assigned a plugin grant`,
          );
        }
        if (decision === "allow" && profile.capabilities[key] === "disabled") {
          throw new PermissionServiceError(
            403,
            "capability_disabled",
            `Capability "${key}" is disabled on this host`,
          );
        }
      }

      const existing = await store.getPluginGrant(pluginId);
      const timestamp = new Date(now()).toISOString();
      const manifests = pluginRuntimeManifests(entry).map(
        ({ manifest }) => manifest,
      );
      const version =
        (entry.packageManifest?.manifest ?? manifests[0])?.version ?? "0.0.0";
      const record: PluginGrantRecord = {
        pluginId,
        version,
        contentDigest: inspected.contentDigest,
        grantedCapabilities: inspected.capabilities,
        decisions: input.decisions,
        grantedAt: existing?.grantedAt ?? timestamp,
        updatedAt: timestamp,
      };
      await store.upsertPluginGrant(record);
      await load();

      const hasDeny = Object.values(input.decisions).some((d) => d === "deny");
      const removedAllow = Object.entries(existing?.decisions ?? {}).some(
        ([key, prev]) =>
          prev === "allow" && input.decisions[key as CapabilityKey] !== "allow",
      );
      if (hasDeny || removedAllow) {
        rpcApprovalGate.revokePlugin(pluginId);
      }
      notifyChanged(pluginId);

      return summarizeEntry(entry, profile, policy());
    },

    async deletePluginGrant(pluginId: string): Promise<{
      readonly pluginId: string;
      readonly revokedSessionGrants: number;
    }> {
      await store.deletePluginGrant(pluginId);
      await load();
      const revokedSessionGrants = rpcApprovalGate.revokePlugin(pluginId);
      notifyChanged(pluginId);
      return { pluginId, revokedSessionGrants };
    },

    evaluateRpcApproval(
      query: ImplicitGrantQuery,
      options?: { readonly isOperator?: boolean },
    ): PolicyDecisionResult {
      refreshWhenStale();
      const entry = registry.getCurrent(query.pluginId);
      const declarative =
        entry?.source === "community" &&
        trustedSources.isDeclarative(query.pluginId);
      const isCodeLevelAction =
        query.action === COMMUNITY_SERVER_CODE_ACTION ||
        query.action.startsWith("runtime:");
      if (declarative) {
        const declState = evaluateCapabilityForPlugin(
          "plugin.declarative",
          query.pluginId,
          hostProfile,
          options?.isOperator ?? false,
        );
        if (declState.effective === "deny") {
          return {
            decision: "deny",
            reason: declState.lockedBy ?? "grant",
            capability: "plugin.declarative",
          };
        }
        return { decision: "ask" };
      }

      const communityCeiling = hostProfile.capabilities["plugin.communityCode"];
      if (
        communityCeiling === "disabled" ||
        (communityCeiling === "operator-only" && options?.isOperator === false)
      ) {
        return {
          decision: "deny",
          reason: "ceiling",
          capability: "plugin.communityCode",
        };
      }
      if (policy()["plugin.communityCode"] === "deny") {
        return {
          decision: "deny",
          reason: "policy",
          capability: "plugin.communityCode",
        };
      }

      const { grant, status } = communityGrantState(query.pluginId);
      const decision = pluginGrantDecisionFor(
        status,
        grant,
        "plugin.communityCode",
      );
      if (decision === "deny") {
        return {
          decision: "deny",
          reason: "grant",
          capability: "plugin.communityCode",
        };
      }
      if (isCodeLevelAction) {
        if (decision === "allow") {
          return { decision: "allow", reason: "persistent-grant" };
        }
        if (trustedSources.implicitGrant(query)) {
          return { decision: "allow", reason: "trusted-source" };
        }
      }
      return { decision: "ask" };
    },

    hasPersistentServerCodeGrant(
      pluginId: string,
      options?: { readonly isOperator?: boolean },
    ): boolean {
      refreshWhenStale();
      const communityCeiling = hostProfile.capabilities["plugin.communityCode"];
      if (
        communityCeiling === "disabled" ||
        (communityCeiling === "operator-only" && options?.isOperator === false)
      ) {
        return false;
      }
      if (policy()["plugin.communityCode"] === "deny") {
        return false;
      }
      const { grant, status } = communityGrantState(pluginId);
      return (
        pluginGrantDecisionFor(status, grant, "plugin.communityCode") ===
        "allow"
      );
    },

    isCapabilityAllowedForPlugin(
      key: CapabilityKey,
      pluginId: string,
      profile: HostProfile = hostProfile,
      isOperator = false,
    ): boolean {
      return (
        evaluateCapabilityForPlugin(key, pluginId, profile, isOperator)
          .effective === "allow"
      );
    },

    requireCapabilityForPlugin(
      c: Context,
      key: CapabilityKey,
      pluginId: string,
    ): Response | undefined {
      const profile = hostProfileOf(c);
      const state = evaluateCapabilityForPlugin(
        key,
        pluginId,
        profile,
        isOperatorRequest(c, profile),
      );
      if (state.effective !== "deny") return undefined;
      return capabilityDenialResponse(
        c,
        state.lockedBy ?? "grant",
        key,
        state.ceiling,
      );
    },
  };
}
