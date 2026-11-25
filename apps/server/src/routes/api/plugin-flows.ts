/**
 * Declarative Config Flow HTTP routes (`/api/plugins/:pluginId/flows/*`).
 *
 * All routes enforce `accessGuard("host.config")`, L1–L3 instance permission
 * governance, lazy `onFlow:<flowId>` activation, and bounded execution context.
 */

import { Hono, type Context } from "hono";
import type { PluginRegistry, PluginRegistryEntry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import { isCapabilityKey } from "@covel/shared/permissions";
import { z } from "zod";
import { errorBody } from "../../api-error.js";
import { accessGuard } from "../../host-profile.js";
import {
  startLoopbackCallbackSession,
  type LoopbackCallbackSession,
} from "../../trust/loopback-callback.js";
import type { PermissionService } from "../../trust/permission-service.js";
import type { SecretVault } from "../../trust/secret-vault.js";
import type { TrustedSourceService } from "../../trust/trusted-source-service.js";
import {
  ConfigFlowError,
  type ConfigFlowContextFactory,
  type ConfigFlowDefinitionEntry,
  type ConfigFlowEngine,
} from "./bootstrap/config-flows.js";
import { withCallSignal } from "./bootstrap/entry-http.js";
import {
  isInstancePluginAllowed,
  isPluginCapabilityEffectivelyAllowed,
  type InstancePluginRegistry,
} from "./bootstrap/instance-plugins.js";
import {
  buildPluginInstanceSurface,
  packageHttpPermissions,
  pickPluginInstanceSurfaceFields,
} from "./bootstrap/plugin-entry-api.js";
import type { ProviderSourceHost } from "./bootstrap/provider-sources.js";
import {
  invalidateAndRefreshProviderSources,
  requireDeclaredCapabilities,
  requireInstancePluginAccess,
  resolveInstancePluginEntry,
} from "./instance-plugin-route-helpers.js";

export interface PluginFlowRoutesDeps {
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly hostId: string;
  readonly secretVault: SecretVault;
  readonly configFlows: ConfigFlowEngine;
  readonly instancePlugins: InstancePluginRegistry;
  readonly permissionService: PermissionService;
  readonly trustedSources: TrustedSourceService;
  readonly providerSources?: ProviderSourceHost;
}

const startBodySchema = z
  .strictObject({
    initial: z.unknown().optional(),
  })
  .optional();

const stepBodySchema = z.strictObject({
  stepId: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  callbackUrl: z.string().optional(),
  cancelled: z.boolean().optional(),
});

export function createPluginFlowRoutes(deps: PluginFlowRoutesDeps): Hono {
  const {
    registry,
    store,
    hostId,
    secretVault,
    configFlows,
    instancePlugins,
    permissionService,
    trustedSources,
    providerSources,
  } = deps;

  async function refreshSourcesIfCompleted(
    pluginId: string,
    snapshot: { readonly status: string },
  ): Promise<void> {
    if (snapshot.status !== "completed") return;
    await invalidateAndRefreshProviderSources(
      providerSources,
      registry.getCurrent(pluginId),
      pluginId,
      "plugin-flows",
      `flow for "${pluginId}"`,
    );
  }

  const app = new Hono();
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  async function resolveFlowAccess(
    c: Context,
    pluginId: string,
    flowId: string,
    activateIfNeeded: boolean,
  ): Promise<
    | {
        readonly ok: true;
        readonly entry: PluginRegistryEntry;
        readonly flow: ConfigFlowDefinitionEntry;
      }
    | { readonly ok: false; readonly response: Response }
  > {
    const resolved = resolveInstancePluginEntry(c, registry, pluginId, {
      notInstanceCode: "instance_scope_required",
      notInstanceMessage: `Plugin "${pluginId}" does not expose instance-scoped config flows`,
    });
    if (!resolved.ok) return resolved;
    const { entry } = resolved;

    const declared = entry.packageManifest?.plugin.contributes?.flows ?? [];
    if (!declared.includes(flowId)) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            `Config flow "${flowId}" is not declared by plugin "${pluginId}"`,
            { code: "flow_not_found" },
          ),
          404,
        ),
      };
    }

    const accessError = await requireInstancePluginAccess(
      c,
      { registry, permissionService, trustedSources },
      pluginId,
    );
    if (accessError) return { ok: false, response: accessError };

    if (activateIfNeeded && !instancePlugins.isActivated(pluginId)) {
      await instancePlugins.activate(pluginId);
    }

    const flow = configFlows.get(pluginId, flowId);
    if (!flow) {
      return {
        ok: false,
        response: c.json(
          errorBody(
            `Config flow "${flowId}" is not registered by plugin "${pluginId}"`,
            { code: "flow_not_found" },
          ),
          404,
        ),
      };
    }

    const capabilityError = requireDeclaredCapabilities(
      c,
      { registry, permissionService },
      pluginId,
      flow.definition.requiredCapabilities,
      `flow "${pluginId}/${flowId}"`,
    );
    if (capabilityError) return { ok: false, response: capabilityError };

    return { ok: true, entry, flow };
  }

  function makeContextFactory(
    pluginId: string,
    entry: PluginRegistryEntry,
  ): ConfigFlowContextFactory {
    const httpPermissions = packageHttpPermissions(entry);
    const loopbackDecl =
      entry.packageManifest?.plugin.permissions?.loopbackCallback;
    const canAcceptLoopback = (flowId: string): boolean => {
      const flow = configFlows.get(pluginId, flowId);
      if (!flow) return false;
      return (
        isInstancePluginAllowed(
          { registry, permissionService, trustedSources },
          pluginId,
        ) &&
        [
          "net.loopbackCallback" as const,
          ...(flow.definition.requiredCapabilities ?? []),
        ].every(
          (capability) =>
            isCapabilityKey(capability) &&
            isPluginCapabilityEffectivelyAllowed(
              permissionService,
              registry,
              capability,
              pluginId,
            ),
        )
      );
    };

    return ({
      pluginId: pId,
      flowId,
      runId,
      signal,
      runSignal,
      onLoopbackStarted,
      onLoopbackClosed,
    }) => {
      const surface = buildPluginInstanceSurface({
        pluginId: pId,
        pluginRegistry: registry,
        store,
        hostId,
        secretVault,
        getPermissionService: () => permissionService,
        httpPermissions,
      });

      return {
        signal,
        pluginId: pId,
        flowId,
        runId,
        ...pickPluginInstanceSurfaceFields(surface),
        http: withCallSignal(surface.http, signal),
        ...(loopbackDecl
          ? {
              async startLoopbackCallback() {
                if (!canAcceptLoopback(flowId)) {
                  throw new ConfigFlowError(
                    403,
                    "capability_denied",
                    `Capability "net.loopbackCallback" is not allowed for plugin "${pluginId}"`,
                  );
                }
                const session = await startLoopbackCallbackSession({
                  path: loopbackDecl.path,
                  ports: loopbackDecl.ports,
                  signal: runSignal,
                  canAccept: () => canAcceptLoopback(flowId),
                });
                const managedSession: LoopbackCallbackSession = {
                  ...session,
                  async close() {
                    onLoopbackClosed(managedSession);
                    await session.close();
                  },
                };
                onLoopbackStarted(managedSession);
                return managedSession;
              },
            }
          : {}),
      };
    };
  }

  function mapError(c: Context, error: unknown): Response {
    if (error instanceof ConfigFlowError) {
      return c.json(
        errorBody(error.message, { code: error.code }),
        error.status,
      );
    }
    throw error;
  }

  app.post(
    "/:pluginId/flows/:flowId/start",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const flowId = c.req.param("flowId");
      const resolved = await resolveFlowAccess(c, pluginId, flowId, true);
      if (!resolved.ok) return resolved.response;

      let rawBody: unknown = undefined;
      const rawText = await c.req.text();
      if (rawText.trim().length > 0) {
        try {
          rawBody = JSON.parse(rawText);
        } catch {
          return c.json(
            errorBody("Request body must be valid JSON", {
              code: "invalid_json",
            }),
            400,
          );
        }
      }
      const parsedBody = startBodySchema.safeParse(rawBody);
      if (!parsedBody.success) {
        return c.json(
          errorBody("Invalid flow start payload", { code: "invalid_input" }),
          400,
        );
      }

      try {
        const snapshot = await configFlows.start(
          pluginId,
          flowId,
          parsedBody.data?.initial !== undefined
            ? { initial: parsedBody.data.initial as never }
            : {},
          makeContextFactory(pluginId, resolved.entry),
          c.req.raw.signal,
        );
        await refreshSourcesIfCompleted(pluginId, snapshot);
        return c.json({ ok: true, run: snapshot });
      } catch (error) {
        return mapError(c, error);
      }
    },
  );

  app.get(
    "/:pluginId/flows/:flowId/runs/:runId",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const flowId = c.req.param("flowId");
      const runId = c.req.param("runId");
      const resolved = await resolveFlowAccess(c, pluginId, flowId, false);
      if (!resolved.ok) return resolved.response;

      try {
        const snapshot = await configFlows.getRun(
          pluginId,
          flowId,
          runId,
          makeContextFactory(pluginId, resolved.entry),
          c.req.raw.signal,
        );
        await refreshSourcesIfCompleted(pluginId, snapshot);
        return c.json({ ok: true, run: snapshot });
      } catch (error) {
        return mapError(c, error);
      }
    },
  );

  app.post(
    "/:pluginId/flows/:flowId/runs/:runId/step",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const flowId = c.req.param("flowId");
      const runId = c.req.param("runId");
      const resolved = await resolveFlowAccess(c, pluginId, flowId, false);
      if (!resolved.ok) return resolved.response;

      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json(
          errorBody("Request body must be valid JSON", {
            code: "invalid_json",
          }),
          400,
        );
      }
      const parsedBody = stepBodySchema.safeParse(rawBody);
      if (!parsedBody.success) {
        return c.json(
          errorBody(
            parsedBody.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "body"}: ${issue.message}`,
              )
              .join("; "),
            { code: "invalid_input" },
          ),
          400,
        );
      }

      try {
        const snapshot = await configFlows.step(
          pluginId,
          flowId,
          runId,
          parsedBody.data,
          makeContextFactory(pluginId, resolved.entry),
          c.req.raw.signal,
        );
        await refreshSourcesIfCompleted(pluginId, snapshot);
        return c.json({ ok: true, run: snapshot });
      } catch (error) {
        return mapError(c, error);
      }
    },
  );

  app.delete(
    "/:pluginId/flows/:flowId/runs/:runId",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const flowId = c.req.param("flowId");
      const runId = c.req.param("runId");
      const resolved = await resolveFlowAccess(c, pluginId, flowId, false);
      if (!resolved.ok) return resolved.response;

      try {
        const snapshot = await configFlows.cancel(
          pluginId,
          flowId,
          runId,
          makeContextFactory(pluginId, resolved.entry),
        );
        return c.json({ ok: true, run: snapshot });
      } catch (error) {
        return mapError(c, error);
      }
    },
  );

  return app;
}
