/**
 * Instance-scoped plugin application actions (`POST /api/plugins/:pluginId/actions/:action`).
 *
 * Security & lazy-activation order:
 * 1. Host access guard (`host.config`).
 * 2. Package exists, has `scope: "instance" | "both"`, and declares `action` in
 *    `contributes.appActions`.
 * 3. L1–L3 instance permission gate (`checkInstancePluginAllowed`) passes.
 * 4. Lazily activates `onAppAction:<action>` (or `activate(pluginId)`).
 * 5. Enforces `options.requiredCapabilities` dynamically.
 * 6. Validates JSON input/output via declared Zod schemas and passes the live
 *    capability-checked `PluginAppActionContext`.
 */

import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import type { DataStore } from "@covel/store";
import { errorBody } from "../../api-error.js";
import { accessGuard } from "../../host-profile.js";
import type { PermissionService } from "../../trust/permission-service.js";
import type { SecretVault } from "../../trust/secret-vault.js";
import type { TrustedSourceService } from "../../trust/trusted-source-service.js";
import type { AppActionRegistry } from "./bootstrap/app-actions.js";
import type { AppScheduler } from "./bootstrap/app-scheduler.js";
import { withCallSignal } from "./bootstrap/entry-http.js";
import type { InstancePluginRegistry } from "./bootstrap/instance-plugins.js";
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

export interface PluginAppActionRoutesDeps {
  readonly registry: PluginRegistry;
  readonly store: DataStore;
  readonly hostId: string;
  readonly secretVault: SecretVault;
  readonly appActions: AppActionRegistry;
  readonly appScheduler?: AppScheduler;
  readonly instancePlugins: InstancePluginRegistry;
  readonly permissionService: PermissionService;
  readonly trustedSources: TrustedSourceService;
  readonly providerSources?: ProviderSourceHost;
  readonly actionTimeoutMs?: number;
}

const DEFAULT_APP_ACTION_TIMEOUT_MS = 30_000;

export function createPluginAppActionRoutes(
  deps: PluginAppActionRoutesDeps,
): Hono {
  const {
    registry,
    store,
    hostId,
    secretVault,
    appActions,
    appScheduler,
    instancePlugins,
    permissionService,
    trustedSources,
    providerSources,
    actionTimeoutMs = DEFAULT_APP_ACTION_TIMEOUT_MS,
  } = deps;

  const app = new Hono();

  app.post(
    "/:pluginId/actions/:action",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const action = c.req.param("action");

      const resolved = resolveInstancePluginEntry(c, registry, pluginId, {
        notInstanceCode: "instance_scope_required",
        notInstanceMessage: `Plugin "${pluginId}" does not expose instance-scoped app actions`,
      });
      if (!resolved.ok) return resolved.response;
      const { entry } = resolved;

      const declared =
        entry.packageManifest?.plugin.contributes?.appActions ?? [];
      if (!declared.includes(action)) {
        return c.json(
          errorBody(
            `App action "${action}" is not declared by plugin "${pluginId}"`,
            { code: "app_action_not_found" },
          ),
          404,
        );
      }

      const accessError = await requireInstancePluginAccess(
        c,
        { registry, permissionService, trustedSources },
        pluginId,
      );
      if (accessError) return accessError;

      if (!instancePlugins.isActivated(pluginId)) {
        await instancePlugins.activate(pluginId);
      }

      const registered = appActions.get(pluginId, action);
      if (!registered) {
        return c.json(
          errorBody(
            `App action "${action}" is not registered by plugin "${pluginId}"`,
            { code: "app_action_not_found" },
          ),
          404,
        );
      }

      const capabilityError = requireDeclaredCapabilities(
        c,
        { registry, permissionService },
        pluginId,
        registered.options.requiredCapabilities,
        `"${pluginId}/${action}"`,
      );
      if (capabilityError) return capabilityError;

      let rawInput: unknown = {};
      const rawText = await c.req.text();
      if (rawText.trim().length > 0) {
        try {
          rawInput = JSON.parse(rawText);
        } catch {
          return c.json(
            errorBody("Request body must be valid JSON", {
              code: "invalid_json",
            }),
            400,
          );
        }
      }

      let parsedInput = rawInput;
      if (registered.options.inputSchema) {
        const check = registered.options.inputSchema.safeParse(rawInput);
        if (!check.success) {
          return c.json(
            errorBody(
              check.error.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "input"}: ${issue.message}`,
                )
                .join("; "),
              { code: "invalid_input" },
            ),
            400,
          );
        }
        parsedInput = check.data;
      }

      const surface = buildPluginInstanceSurface({
        pluginId,
        pluginRegistry: registry,
        store,
        hostId,
        secretVault,
        getPermissionService: () => permissionService,
        httpPermissions: packageHttpPermissions(entry),
      });

      const timeoutAc = new AbortController();
      let timedOut = false;
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        timeoutAc.abort(
          new DOMException(
            `App action "${action}" timed out after ${actionTimeoutMs}ms`,
            "TimeoutError",
          ),
        );
      }, actionTimeoutMs);
      timeoutHandle.unref?.();
      const signal = AbortSignal.any([c.req.raw.signal, timeoutAc.signal]);

      let result: unknown;
      try {
        const task = Promise.resolve().then(() =>
          registered.handler(parsedInput, {
            signal,
            pluginId,
            action,
            ...pickPluginInstanceSurfaceFields(surface),
            ...(appScheduler
              ? {
                  scheduler: {
                    scheduleOnce: (taskId, delayMs) =>
                      appScheduler.scheduleOnce(pluginId, taskId, delayMs),
                  },
                }
              : {}),
            http: withCallSignal(surface.http, signal),
          }),
        );
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(signal.reason);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
        // Prevent late unhandled rejections when the timeout/request abort wins the race.
        void task.catch(() => {});
        result = await Promise.race([task, aborted]);
      } catch (error) {
        if (timedOut) {
          return c.json(
            errorBody(
              `App action "${action}" timed out after ${actionTimeoutMs}ms`,
              { code: "app_action_timeout" },
            ),
            504,
          );
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }

      let validatedOutput = result;
      if (registered.options.outputSchema) {
        const outCheck = registered.options.outputSchema.safeParse(result);
        if (!outCheck.success) {
          return c.json(
            errorBody(
              `App action "${action}" returned output failing its outputSchema`,
              { code: "invalid_output" },
            ),
            500,
          );
        }
        validatedOutput = outCheck.data;
      }

      await invalidateAndRefreshProviderSources(
        providerSources,
        entry,
        pluginId,
        "plugin-app-actions",
        `"${pluginId}/${action}"`,
      );

      return c.json({ ok: true, result: validatedOutput });
    },
  );

  app.get(
    "/:pluginId/instance-data/:namespace",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      const namespace = c.req.param("namespace");

      if (
        !namespace ||
        namespace.trim().length === 0 ||
        namespace.startsWith("_")
      ) {
        return c.json(
          errorBody(
            'Instance data namespace must be non-empty and cannot start with "_"',
            { code: "invalid_namespace" },
          ),
          400,
        );
      }

      const resolved = resolveInstancePluginEntry(c, registry, pluginId, {
        notInstanceCode: "not_instance_plugin",
        notInstanceMessage: `Plugin "${pluginId}" is session-scoped and has no instance data`,
      });
      if (!resolved.ok) return resolved.response;

      const accessError = await requireInstancePluginAccess(
        c,
        { registry, permissionService, trustedSources },
        pluginId,
        `Instance scope for plugin "${pluginId}" is denied by host or player permissions`,
      );
      if (accessError) return accessError;

      const records = await store.listInstanceData(pluginId, namespace);
      c.header("Cache-Control", "no-store");
      return c.json({
        ok: true,
        entries: records.map((record) => ({
          key: record.key,
          value: record.value,
          updatedAt: record.updatedAt,
        })),
      });
    },
  );

  return app;
}
