import { Hono } from "hono";
import type { PluginHost } from "@covel/plugin-runtime";

/**
 * Frontend-compatible GET /packages
 * Returns PackageSummary[] = [{ name, enabled }]
 */
export function createCompatPackagesRoute(pluginHost: PluginHost) {
  const route = new Hono();

  route.get("/", (c) => {
    const packages = pluginHost.pluginRegistry.list().map((p) => ({
      name: p.manifest.id,
      enabled: p.enabled,
    }));
    return c.json(packages);
  });

  return route;
}
