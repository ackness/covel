/**
 * Framework discovery routes for developer tooling and AI agents.
 */

import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { DEFAULT_LOCALE } from "@covel/shared";
import { describeAuthoringSurface } from "../../authoring/describe.js";
import { normalizeLocale } from "../../lib/validators.js";
import { buildFrameworkCapabilities } from "./discovery.js";

type Env = {
  Variables: {
    builtinToolNames?: readonly string[];
    pluginRegistry?: PluginRegistry;
  };
};

export const frameworkRoutes = new Hono<Env>();

frameworkRoutes.get("/capabilities", (c) => {
  return c.json(buildFrameworkCapabilities(c.get("builtinToolNames")));
});

/**
 * What a world may contain for the plugins loaded on this server: world
 * files, kernel destinations, each data contract with its authoring notes,
 * and the plugin catalogue. The world creation UI and coding agents read it.
 */
frameworkRoutes.get("/authoring", async (c) => {
  const registry = c.get("pluginRegistry");
  if (!registry)
    return c.json({ files: [], destinations: [], contracts: [], plugins: [] });
  return c.json(
    await describeAuthoringSurface(registry, {
      locale: normalizeLocale(c.req.query("locale"), DEFAULT_LOCALE),
    }),
  );
});
