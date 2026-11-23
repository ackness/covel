import { Hono } from "hono";
import { z } from "zod";
import {
  permissionsPolicySchema,
  pluginGrantDecisionsSchema,
} from "@covel/shared/permissions";
import { errorBody, listBody, okBody, parseJsonBody } from "../../api-error.js";
import {
  accessGuard,
  hostProfileOf,
  requireAccess,
} from "../../host-profile.js";
import { ServerSettingsValidationError } from "../../lib/server-settings.js";
import {
  PermissionServiceError,
  type PermissionService,
} from "../../trust/permission-service.js";

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/i;

const updatePolicyBodySchema = z.strictObject({
  policy: permissionsPolicySchema.nullable(),
});

const putPluginGrantBodySchema = z.strictObject({
  decisions: pluginGrantDecisionsSchema,
  expectedDigest: z.string().min(1).optional(),
});

/**
 * `/api/permissions`: unified L1–L3 permission snapshot, instance policy
 * management, and per-plugin persistent grants.
 */
export function createPermissionsRoutes(
  permissionService: PermissionService,
): Hono {
  const app = new Hono();

  app.get("/snapshot", async (c) => {
    await permissionService.refresh();
    return c.json(permissionService.snapshot(hostProfileOf(c)));
  });

  app.put("/policy", accessGuard("server.settings"), async (c) => {
    const parsed = await parseJsonBody(c, updatePolicyBodySchema);
    if (parsed instanceof Response) return parsed;
    try {
      const snapshot = await permissionService.updatePolicy(
        parsed.body.policy,
        hostProfileOf(c),
      );
      return c.json(snapshot);
    } catch (error) {
      if (!(error instanceof ServerSettingsValidationError)) throw error;
      return c.json(
        errorBody(error.message, {
          code: error.code,
          ...(error.key ? { details: { key: error.key } } : {}),
        }),
        error.code === "server_setting_fixed" ? 409 : 400,
      );
    }
  });

  app.get("/plugins", accessGuard("server.diagnostics"), async (c) => {
    const items = await permissionService.listPlugins(hostProfileOf(c));
    return c.json(listBody(items));
  });

  app.put(
    "/plugins/:pluginId/grants",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      if (!PLUGIN_ID_RE.test(pluginId)) {
        return c.json(
          errorBody(`invalid plugin id: ${pluginId}`, {
            code: "invalid_plugin_id",
          }),
          400,
        );
      }
      const parsed = await parseJsonBody(c, putPluginGrantBodySchema);
      if (parsed instanceof Response) return parsed;
      if (parsed.body.decisions["plugin.communityCode"] === "allow") {
        const denied = requireAccess(c, "plugin.community");
        if (denied) return denied;
      }
      try {
        const plugin = await permissionService.setPluginGrant(
          pluginId,
          parsed.body,
          hostProfileOf(c),
        );
        return c.json(okBody({ plugin }));
      } catch (error) {
        if (!(error instanceof PermissionServiceError)) throw error;
        return c.json(
          errorBody(error.message, { code: error.code }),
          error.status,
        );
      }
    },
  );

  app.delete(
    "/plugins/:pluginId/grants",
    accessGuard("host.config"),
    async (c) => {
      const pluginId = c.req.param("pluginId");
      if (!PLUGIN_ID_RE.test(pluginId)) {
        return c.json(
          errorBody(`invalid plugin id: ${pluginId}`, {
            code: "invalid_plugin_id",
          }),
          400,
        );
      }
      const result = await permissionService.deletePluginGrant(pluginId);
      return c.json(okBody(result));
    },
  );

  return app;
}
