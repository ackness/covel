import { Hono } from "hono";
import type { PluginHost } from "@covel/plugin-runtime";

export function createBlockSchemasRoute(pluginHost: PluginHost) {
  const route = new Hono();

  /**
   * GET /api/block-schemas
   *
   * Returns all registered block schemas keyed by block type.
   */
  route.get("/", (c) => {
    const schemas: Record<string, unknown> = {};
    for (const [type, schema] of pluginHost.blockSchemas) {
      schemas[type] = schema;
    }
    return c.json({ schemas });
  });

  return route;
}
