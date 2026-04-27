/**
 * API Plugin routes — list and inspect loaded plugins.
 *
 * NOTE: The PATCH /:id/config route was removed in 2026-04-12 because the
 * `sessionScopes` map it depended on was never populated by any production
 * code path. See audits/2026-04-12-backend-webv2-framework-audit Finding 2.
 * Real per-session config lives in `loadSessionConfig()` + plugin_data.
 */

import { Hono } from 'hono';
import type { PluginRegistry, PluginRegistryEntry } from '@covel/plugin-loader';

type Env = {
  Variables: {
    pluginRegistry: PluginRegistry;
  };
};

export const pluginRoutes = new Hono<Env>();

// Aggregate manifest-derived fields the framework UI needs to discover plugins
// by capability instead of hardcoding plugin IDs (framework/plugin isolation rule).
//
// `capabilities` is the union across all runtimes of a multi-runtime plugin.
// `outputKind` reports the primary runtime's output kind (story | plugin | system),
// matching how `summary` already collapses multi-runtime plugins down to one row.
function summarizePluginManifests(entry: PluginRegistryEntry) {
  const manifests = entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
  const capabilities = Array.from(
    new Set(manifests.flatMap((m) => m.manifest.capabilities ?? [])),
  );
  const outputKind = entry.manifest?.manifest.outputKind;
  return { capabilities, outputKind };
}

// GET /plugins — List all loaded plugins
pluginRoutes.get('/', async (c) => {
  const registry = c.get('pluginRegistry');
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

// GET /plugins/:id — Get plugin details
pluginRoutes.get('/:id', async (c) => {
  const registry = c.get('pluginRegistry');
  const id = c.req.param('id');
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

// GET /plugins/:id/config — Get plugin config schema (read-only)
pluginRoutes.get('/:id/config', async (c) => {
  const registry = c.get('pluginRegistry');
  const id = c.req.param('id');
  const entry = registry.get(id);
  if (!entry) {
    return c.json({ error: `Plugin "${id}" not found` }, 404);
  }
  const config = entry.manifest?.manifest.config ?? {};
  return c.json({ pluginId: id, config });
});
