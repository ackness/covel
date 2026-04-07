import { Hono } from "hono";
import type { KernelSession } from "@covel/kernel";
import type { PluginHost } from "@covel/plugin-runtime";

/**
 * Plugins that are essential for every turn and must never be disabled.
 * core-narrator: always-trigger story runtime — without it there is no narrative output.
 * core-persona: always-trigger plugin runtime — without it the AI has no persona config.
 */
const LOCKED_PLUGINS = new Set(["core-narrator", "core-persona"]);

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
        locked: LOCKED_PLUGINS.has(p.manifest.id),
      })),
    });
  });

  route.post("/:sessionId/plugins/enable", async (c) => {
    const sessionId = c.req.param("sessionId");
    let parsed: { pluginId: string };
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    const { pluginId } = parsed;

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
    let parsed: { pluginId: string };
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ code: "INVALID_JSON", message: "Malformed JSON body" }, 400);
    }
    const { pluginId } = parsed;

    if (!pluginId) {
      return c.json({ code: "INVALID_REQUEST", message: "pluginId is required" }, 400);
    }

    if (LOCKED_PLUGINS.has(pluginId)) {
      return c.json({ code: "PLUGIN_LOCKED", message: `Plugin "${pluginId}" is a core plugin and cannot be disabled` }, 403);
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
