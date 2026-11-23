import type { Context } from "hono";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import { isCapabilityKey } from "@covel/shared/permissions";
import { errorBody } from "../../api-error.js";
import type { PermissionService } from "../../trust/permission-service.js";
import type { TrustedSourceService } from "../../trust/trusted-source-service.js";
import {
  checkInstancePluginAllowed,
  isPluginCapabilityEffectivelyAllowed,
} from "./bootstrap/instance-plugins.js";
import type { ProviderSourceHost } from "./bootstrap/provider-sources.js";

export interface InstancePluginRouteAccessDeps {
  readonly registry: PluginRegistry;
  readonly permissionService: PermissionService;
  readonly trustedSources: TrustedSourceService;
}

export type InstanceEntryResolution =
  | { readonly ok: true; readonly entry: PluginRegistryEntry }
  | { readonly ok: false; readonly response: Response };

export function resolveInstancePluginEntry(
  c: Context,
  registry: PluginRegistry,
  pluginId: string,
  options: {
    readonly notInstanceCode: string;
    readonly notInstanceMessage: string;
  },
): InstanceEntryResolution {
  const entry = registry.getCurrent(pluginId);
  if (!entry) {
    return {
      ok: false,
      response: c.json(
        errorBody(`Plugin "${pluginId}" not found`, {
          code: "plugin_not_found",
        }),
        404,
      ),
    };
  }

  const scope = entry.packageManifest?.plugin.scope ?? "session";
  if (scope !== "instance" && scope !== "both") {
    return {
      ok: false,
      response: c.json(
        errorBody(options.notInstanceMessage, {
          code: options.notInstanceCode,
        }),
        403,
      ),
    };
  }

  return { ok: true, entry };
}

export async function requireInstancePluginAccess(
  c: Context,
  deps: InstancePluginRouteAccessDeps,
  pluginId: string,
  deniedMessage = `Plugin "${pluginId}" is not permitted to run at instance scope`,
): Promise<Response | undefined> {
  const allowed = await checkInstancePluginAllowed(deps, pluginId);
  if (allowed) return undefined;
  return c.json(errorBody(deniedMessage, { code: "capability_denied" }), 403);
}

export function requireDeclaredCapabilities(
  c: Context,
  deps: Pick<InstancePluginRouteAccessDeps, "registry" | "permissionService">,
  pluginId: string,
  capabilities: readonly string[] | undefined,
  subjectLabel: string,
): Response | undefined {
  for (const cap of capabilities ?? []) {
    if (
      !isCapabilityKey(cap) ||
      !isPluginCapabilityEffectivelyAllowed(
        deps.permissionService,
        deps.registry,
        cap,
        pluginId,
      )
    ) {
      return c.json(
        errorBody(`Capability "${cap}" is required by ${subjectLabel}`, {
          code: "capability_denied",
        }),
        403,
      );
    }
  }
  return undefined;
}

export async function invalidateAndRefreshProviderSources(
  providerSources: ProviderSourceHost | undefined,
  entry: PluginRegistryEntry | undefined,
  pluginId: string,
  logPrefix: string,
  contextDesc: string,
): Promise<void> {
  if (
    !providerSources ||
    !entry?.packageManifest?.plugin.contributes?.providerSources?.length
  ) {
    return;
  }
  providerSources.invalidatePlugin(pluginId);
  await providerSources.refreshPluginStatus(pluginId).catch((error) => {
    console.warn(
      `[${logPrefix}] Failed to refresh provider sources after ${contextDesc}:`,
      error,
    );
  });
}
