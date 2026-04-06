import { Hono } from "hono";
import type { PluginHost } from "@covel/plugin-runtime";

/**
 * Frontend-compatible GET /packages
 * Returns { packages: PackageSummary[], loadErrors: PluginLoadError[] }
 *
 * For backward compatibility the response is still a plain array when there are
 * no errors; when errors exist the shape becomes `{ packages, loadErrors }`.
 * Update: always returns `{ packages, loadErrors }` for consistency.
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
          providerTag: r.spec.providerTag,
        }));

      const pluginTools = (p.manifest.tools ?? []).map((t) => ({
        id: t.id,
        kind: t.kind,
      }));

      return {
        name: p.manifest.id,
        displayName: p.manifest.displayName,
        description: p.manifest.description,
        enabled: p.enabled,
        runtimes: pluginRuntimes,
        tools: pluginTools,
        requires: p.manifest.requires,
        version: p.manifest.version,
        author: p.manifest.author,
      };
    });

    return c.json({
      packages,
      loadErrors: pluginHost.loadErrors,
    });
  });

  return route;
}
