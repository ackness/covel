import { Hono } from "hono";
import type { KernelSession } from "@covel/kernel";
import type { PluginHost } from "@covel/plugin-runtime";

/**
 * Session-scoped plugin management API.
 *
 * GET  /:sessionId/plugins          — list active + available plugins
 * POST /:sessionId/plugins/enable   — enable a plugin for this session
 * POST /:sessionId/plugins/disable  — disable a plugin for this session
 */
export function createSessionPluginsRoute(deps: {
  pluginHost: PluginHost;
  getOrCreateSession: (sessionId: string) => KernelSession;
}) {
  const { pluginHost, getOrCreateSession } = deps;
  const route = new Hono();

  route.get("/:sessionId/plugins", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = getOrCreateSession(sessionId);

    const active = new Set(session.listActivePlugins());
    const allPlugins = pluginHost.pluginRegistry.list();

    return c.json({
      active: Array.from(active),
      available: allPlugins.map((p) => ({
        id: p.manifest.id,
        displayName: p.manifest.displayName,
        description: p.manifest.description,
        isActive: active.has(p.manifest.id),
      })),
    });
  });

  route.post("/:sessionId/plugins/enable", async (c) => {
    const sessionId = c.req.param("sessionId");
    const { pluginId } = await c.req.json<{ pluginId: string }>();

    if (!pluginId) {
      return c.json({ code: "INVALID_REQUEST", message: "pluginId is required" }, 400);
    }

    if (!pluginHost.pluginRegistry.has(pluginId)) {
      return c.json({ code: "PLUGIN_NOT_FOUND", message: `Plugin "${pluginId}" is not loaded` }, 404);
    }

    const session = getOrCreateSession(sessionId);
    session.enablePlugin(pluginId);

    return c.json({
      ok: true,
      active: Array.from(session.listActivePlugins()),
    });
  });

  route.post("/:sessionId/plugins/disable", async (c) => {
    const sessionId = c.req.param("sessionId");
    const { pluginId } = await c.req.json<{ pluginId: string }>();

    if (!pluginId) {
      return c.json({ code: "INVALID_REQUEST", message: "pluginId is required" }, 400);
    }

    const session = getOrCreateSession(sessionId);
    session.disablePlugin(pluginId);

    return c.json({
      ok: true,
      active: Array.from(session.listActivePlugins()),
    });
  });

  return route;
}
