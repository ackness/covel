/**
 * API Plugin routes — list loaded plugins and expose manifest-derived
 * contracts for developer tooling and AI agents.
 *
 * NOTE: The PATCH /:id/config route was removed in 2026-04-12 because the
 * `sessionScopes` map it depended on was never populated by any production
 * code path. See audits/2026-04-12-backend-webv2-framework-audit Finding 2.
 * Real per-session config lives in `loadSessionConfig()` + plugin_data.
 */

import { Hono } from "hono";
import type { PluginRegistry } from "@covel/plugin-loader";
import { buildPluginContract, summarizePluginManifests } from "./discovery.js";

type Env = {
  Variables: {
    pluginRegistry: PluginRegistry;
  };
};

export const pluginRoutes = new Hono<Env>();

// GET /plugins — List all loaded plugins
pluginRoutes.get("/", async (c) => {
  const registry = c.get("pluginRegistry");
  const all = registry.getAll();
  const plugins = Array.from(all.values()).map((entry) => {
    const { capabilities, outputKind } = summarizePluginManifests(entry);
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      runtimeCount: entry.summary.runtimeCount,
      status: entry.status,
      source: entry.source,
      capabilities,
      outputKind,
    };
  });
  return c.json({ plugins });
});

// GET /plugins/:id/contract — Manifest-derived plugin contract.
pluginRoutes.get("/:id/contract", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json({ error: `Plugin "${id}" not found` }, 404);
  }
  return c.json(buildPluginContract(entry));
});

// GET /plugins/:id/plugin-data-contract — Focused plugin data contract alias.
pluginRoutes.get("/:id/plugin-data-contract", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json({ error: `Plugin "${id}" not found` }, 404);
  }
  const contract = buildPluginContract(entry);
  return c.json({
    pluginId: id,
    dataSchemas: contract.dataSchemas,
    declaredPluginDataNamespaces: contract.declaredPluginDataNamespaces,
    writablePluginDataNamespaces: contract.declaredPluginDataNamespaces,
    readablePluginDataNamespaces: [
      ...new Set(
        contract.runtimes.flatMap(
          (runtime) => runtime.readablePluginDataNamespaces,
        ),
      ),
    ].sort((a, b) => a.localeCompare(b)),
  });
});

// GET /plugins/:id — Get plugin details
pluginRoutes.get("/:id", async (c) => {
  const registry = c.get("pluginRegistry");
  const id = c.req.param("id");
  const entry = registry.get(id);
  if (!entry) {
    return c.json({ error: `Plugin "${id}" not found` }, 404);
  }
  const { capabilities, outputKind } = summarizePluginManifests(entry);
  return c.json({
    id: entry.id,
    name: entry.summary.name,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    runtimeCount: entry.summary.runtimeCount,
    status: entry.status,
    source: entry.source,
    capabilities,
    outputKind,
  });
});
