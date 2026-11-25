/**
 * Instance-scope plugin activation registry and capability gate.
 *
 * Instance-scoped plugins (`scope: "instance" | "both"`) provide host-level
 * infrastructure (such as credential/account bridges, provider sources, or
 * scheduled background jobs) without belonging to a single RPG session.
 *
 * Activation is fail-closed across all governance tiers:
 * - L1 Deployment ceiling (`hostProfile.capabilities`): hard-disables
 *   `plugin.instanceScope` on `browser-private` and `hosted` profiles.
 * - L2 Instance policy (`permissions.policy`).
 * - L3 Persistent per-plugin grant + community server-code authorization for
 *   non-builtin, non-declarative packages.
 */

import { COMMUNITY_SERVER_CODE_ACTION } from "@covel/approval";
import { getPluginTrustInfo, type PluginRegistry } from "@covel/plugin-loader";
import { compareText } from "@covel/shared";
import type { CapabilityKey } from "@covel/shared/permissions";
import type { HostProfile } from "../../../host-profile.js";
import type { PermissionService } from "../../../trust/permission-service.js";
import { isDeclarativeCapabilityAllowed } from "../../../trust/plugin-admission.js";
import type { TrustedSourceService } from "../../../trust/trusted-source-service.js";
import type { BootstrapPluginEntries } from "./plugin-entry.js";

const INSTANCE_QUERY_SESSION_ID = "__instance__";

export interface InstancePluginSummary {
  readonly pluginId: string;
  readonly scope: "instance" | "both";
  readonly activationEvents: readonly string[];
  readonly activated: boolean;
  readonly allowed: boolean;
}

export interface InstancePluginRegistry {
  /**
   * Lazily activate all allowed instance-capable plugins whose
   * `activationEvents` include `event`. Disallowed plugins are skipped without
   * throwing; per-plugin activation failures are logged and isolated.
   */
  activateForEvent(event: string): Promise<readonly string[]>;
  /**
   * Explicitly activate one instance-capable plugin, throwing if it is not
   * instance-scoped or is denied by L1/L2/L3 permissions.
   */
  activate(pluginId: string): Promise<void>;
  /** True when the plugin's entry scope is currently published. */
  isActivated(pluginId: string): boolean;
  /** Read-only summary of all discovered `scope: "instance" | "both"` plugins. */
  listInstancePlugins(): readonly InstancePluginSummary[];
}

export function isPluginCapabilityEffectivelyAllowed(
  permissionService: PermissionService | undefined,
  registry: PluginRegistry | undefined,
  key: CapabilityKey,
  pluginId: string,
  options?: {
    readonly profile?: HostProfile;
    readonly isOperator?: boolean;
  },
): boolean {
  if (!permissionService || !registry) return false;
  const entry = registry.getCurrent(pluginId);
  if (!entry) return false;

  const state = permissionService.evaluateCapabilityForPlugin(
    key,
    pluginId,
    options?.profile,
    options?.isOperator ?? false,
  );
  const trustSource = getPluginTrustInfo(pluginId, entry.source).source;
  return trustSource === "builtin"
    ? state.effective !== "deny"
    : state.effective === "allow";
}

export interface InstancePluginEligibilityDeps {
  readonly registry: PluginRegistry;
  readonly permissionService: PermissionService | undefined;
  readonly trustedSources: TrustedSourceService | undefined;
}

export function isInstancePluginAllowed(
  deps: InstancePluginEligibilityDeps,
  pluginId: string,
): boolean {
  const { registry, permissionService, trustedSources } = deps;
  if (!permissionService) return false;
  const entry = registry.getCurrent(pluginId);
  const scope = entry?.packageManifest?.plugin.scope ?? "session";
  if (!entry || (scope !== "instance" && scope !== "both")) {
    return false;
  }

  if (
    !isPluginCapabilityEffectivelyAllowed(
      permissionService,
      registry,
      "plugin.instanceScope",
      pluginId,
    )
  ) {
    return false;
  }

  const trustSource = getPluginTrustInfo(pluginId, entry.source).source;
  if (trustSource === "builtin") {
    return true;
  }

  if (trustedSources?.isDeclarative(pluginId)) {
    return isDeclarativeCapabilityAllowed(permissionService, pluginId);
  }

  const verdict = permissionService.evaluateRpcApproval(
    {
      sessionId: INSTANCE_QUERY_SESSION_ID,
      pluginId,
      action: COMMUNITY_SERVER_CODE_ACTION,
    },
    { isOperator: false },
  );
  return verdict.decision === "allow";
}

export async function checkInstancePluginAllowed(
  deps: InstancePluginEligibilityDeps,
  pluginId: string,
): Promise<boolean> {
  const entry = deps.registry.getCurrent(pluginId);
  if (!entry) return false;
  const trustSource = getPluginTrustInfo(pluginId, entry.source).source;
  if (trustSource === "community") {
    await deps.trustedSources?.ensureFresh(pluginId);
  }
  return isInstancePluginAllowed(deps, pluginId);
}

export function createInstancePluginRegistry(deps: {
  readonly registry: PluginRegistry;
  readonly pluginEntries: BootstrapPluginEntries;
  readonly permissionService: PermissionService;
  readonly trustedSources: TrustedSourceService;
}): InstancePluginRegistry {
  const { registry, pluginEntries, permissionService, trustedSources } = deps;

  const instanceEntries = () =>
    [...registry.getAll().values()]
      .filter((entry) => {
        const scope = entry.packageManifest?.plugin.scope ?? "session";
        return scope === "instance" || scope === "both";
      })
      .sort((a, b) => compareText(a.id, b.id));

  return {
    async activateForEvent(event: string): Promise<readonly string[]> {
      const activated: string[] = [];
      for (const entry of instanceEntries()) {
        const activationEvents =
          entry.packageManifest?.plugin.activationEvents ?? [];
        if (!activationEvents.includes(event)) {
          continue;
        }
        const allowed = await checkInstancePluginAllowed(
          { registry, permissionService, trustedSources },
          entry.id,
        );
        if (!allowed) {
          continue;
        }
        try {
          await pluginEntries.ensureInstancePluginEntry(entry.id);
          activated.push(entry.id);
        } catch (error) {
          console.warn(
            `[instance-plugins] Failed to activate "${entry.id}" for event "${event}":`,
            error,
          );
        }
      }
      return activated;
    },

    async activate(pluginId: string): Promise<void> {
      const entry = registry.getCurrent(pluginId);
      if (!entry) {
        throw new Error(`Instance plugin "${pluginId}" is not installed`);
      }
      const scope = entry.packageManifest?.plugin.scope ?? "session";
      if (scope !== "instance" && scope !== "both") {
        throw new Error(
          `Plugin "${pluginId}" has scope "${scope}" and cannot activate at instance scope`,
        );
      }
      const allowed = await checkInstancePluginAllowed(
        { registry, permissionService, trustedSources },
        pluginId,
      );
      if (!allowed) {
        throw new Error(
          `Plugin "${pluginId}" is not permitted to activate at instance scope`,
        );
      }
      await pluginEntries.ensureInstancePluginEntry(pluginId);
    },

    isActivated(pluginId: string): boolean {
      return pluginEntries.isEntryPublished(pluginId);
    },

    listInstancePlugins(): readonly InstancePluginSummary[] {
      return instanceEntries().map((entry) => {
        const scope = entry.packageManifest?.plugin.scope as
          "instance" | "both";
        return {
          pluginId: entry.id,
          scope,
          activationEvents: [
            ...(entry.packageManifest?.plugin.activationEvents ?? []),
          ],
          activated: pluginEntries.isEntryPublished(entry.id),
          allowed: isInstancePluginAllowed(
            { registry, permissionService, trustedSources },
            entry.id,
          ),
        };
      });
    },
  };
}
