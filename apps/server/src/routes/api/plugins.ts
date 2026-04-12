/**
 * API Plugin routes — list and inspect loaded plugins.
 *
 * NOTE: The PATCH /:id/config route was removed in 2026-04-12 because the
 * `sessionScopes` map it depended on was never populated by any production
 * code path. See audits/2026-04-12-backend-webv2-framework-audit Finding 2.
 * Real per-session config lives in `loadSessionConfig()` + plugin_data.
 */

import { Hono } from 'hono';
import type { PluginRegistry } from '@covel/plugin-loader';

type Env = {
  Variables: {
    pluginRegistry: PluginRegistry;
  };
};

export const pluginRoutes = new Hono<Env>();

// GET /plugins — List all loaded plugins
pluginRoutes.get('/', async (c) => {
  const registry = c.get('pluginRegistry');
  const all = registry.getAll();
  const plugins = Array.from(all.values()).map((entry) => ({
    id: entry.id,
    name: entry.summary.name,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    runtimeCount: entry.summary.runtimeCount,
    status: entry.status,
  }));
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
  return c.json({
    id: entry.id,
    name: entry.summary.name,
    description: entry.summary.description,
    pluginType: entry.summary.pluginType,
    runtimeCount: entry.summary.runtimeCount,
    status: entry.status,
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
