/**
 * Bootstrap stage 10: server settings and the trusted-source policy built on
 * them.
 *
 * The trusted-source service needs loaded settings, which come last, yet the
 * plugin host built in earlier stages consults it. Those stages read it
 * through a {@link TrustedSourcesRef} at call time: until this stage fills
 * it, every check sees no trusted source.
 */

import type { Hono } from "hono";
import type { RpcApprovalGate } from "@covel/approval";
import type { DataStore } from "@covel/store";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { readRuntimeEnv } from "@covel/shared";
import { createServerSettings } from "../../../lib/server-settings.js";
import { installTraceRetentionSource } from "../../../lib/trace-retention-source.js";
import { resolveUserResourceDirs } from "../../../lib/user-resource-dirs.js";
import { deriveHostProfile } from "../../../host-profile.js";
import {
  createPermissionService,
  type PermissionService,
} from "../../../trust/permission-service.js";
import {
  createTrustedSourceService,
  type TrustedSourceService,
} from "../../../trust/trusted-source-service.js";
import { createPermissionsRoutes } from "../permissions.js";
import { createServerSettingsRoutes } from "../server-settings.js";
import type { ApiBootstrapConfig } from "./config.js";

/** Late-bound trust & permission services, read at call time by earlier stages. */
export interface TrustedSourcesRef {
  current: TrustedSourceService | undefined;
  permissions?: PermissionService;
}

export async function loadServerTrust(args: {
  readonly config: Pick<ApiBootstrapConfig, "hostProfile" | "storeBackend">;
  readonly runtimeEnv: ReturnType<typeof readRuntimeEnv>;
  readonly store: DataStore;
  readonly registry: PluginRegistry;
  readonly app: Hono;
  readonly trust: TrustedSourcesRef;
  readonly rpcApprovalGate: RpcApprovalGate;
}): Promise<{
  readonly trustedSources: TrustedSourceService;
  readonly permissionService: PermissionService;
}> {
  const { config, runtimeEnv, store, registry, app, trust, rpcApprovalGate } =
    args;
  // The settings the server acts on. Loaded before the first sweep or commit
  // reads one, so a stored choice is in force from the start. Whether a
  // player's stored values count is the host profile's decision.
  const hostProfile =
    config.hostProfile ??
    deriveHostProfile(runtimeEnv, { storeBackend: config.storeBackend });
  const serverSettings = createServerSettings(store, {
    playerWritable: hostProfile.retention.playerServerSettings,
  });
  await serverSettings.load();
  installTraceRetentionSource(serverSettings);
  const trustedSources = createTrustedSourceService({
    settings: serverSettings,
    registry,
    pluginsRoot: resolveUserResourceDirs().plugins,
  });
  const permissionService = createPermissionService({
    hostProfile,
    serverSettings,
    store,
    registry,
    trustedSources,
    rpcApprovalGate,
  });
  await permissionService.load();
  trust.current = trustedSources;
  trust.permissions = permissionService;
  app.route(
    "/api/config/server-settings",
    createServerSettingsRoutes(serverSettings),
  );
  app.route("/api/permissions", createPermissionsRoutes(permissionService));
  return { trustedSources, permissionService };
}
