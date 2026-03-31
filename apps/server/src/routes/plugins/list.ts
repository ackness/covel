import { Hono } from "hono";
import type { PluginHost } from "@covel/plugin-runtime";

export function createPluginsRoute(pluginHost: PluginHost) {
  const route = new Hono();

  /**
   * GET /api/plugins
   *
   * Returns the list of loaded plugins with their metadata.
   */
  route.get("/", (c) => {
    const plugins = pluginHost.pluginRegistry.list().map((p) => ({
      id: p.manifest.id,
      displayName: p.manifest.displayName,
      version: p.manifest.version,
      author: p.manifest.author,
      description: p.manifest.description,
      enabled: p.enabled,
      runtimes: p.manifest.runtimes?.length ?? 0,
      tools: p.manifest.tools?.length ?? 0,
      hooks: p.manifest.hooks?.length ?? 0,
    }));

    return c.json({ plugins });
  });

  return route;
}
