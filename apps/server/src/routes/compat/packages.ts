import { Hono } from "hono";
import type { PluginHost } from "@covel/plugin-runtime";

/**
 * Frontend-compatible GET /packages
 * Returns PackageSummary[] with runtime info including priority.
 */
export function createCompatPackagesRoute(pluginHost: PluginHost) {
  const route = new Hono();

  route.get("/", (c) => {
    const allRuntimes = pluginHost.runtimeRegistry.listAll();

    const packages = pluginHost.pluginRegistry.list().map((p) => {
      const pluginRuntimes = allRuntimes
        .filter((r) => r.pluginId === p.manifest.id)
        .map((r) => ({
          id: r.spec.id,
          kind: r.spec.kind,
          priority: r.spec.priority ?? 500,
          trigger: r.spec.trigger,
          providerBinding: r.spec.providerBinding,
        }));

      return {
        name: p.manifest.id,
        displayName: p.manifest.displayName,
        description: p.manifest.description,
        enabled: p.enabled,
        runtimes: pluginRuntimes,
      };
    });
    return c.json(packages);
  });

  return route;
}
