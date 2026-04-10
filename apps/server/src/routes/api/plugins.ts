/**
 * API Plugin routes — list, configure, enable/disable plugins.
 */

import { Hono } from 'hono';
import type { PluginRegistry, SessionPluginScope } from '@covel/plugin-loader';

type Env = {
  Variables: {
    pluginRegistry: PluginRegistry;
    sessionScopes: Map<string, SessionPluginScope>;
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

// GET /plugins/:id/config — Get plugin config schema + values
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

// PATCH /plugins/:id/config — Update plugin config
pluginRoutes.patch('/:id/config', async (c) => {
  const registry = c.get('pluginRegistry');
  const sessionScopes = c.get('sessionScopes');
  const id = c.req.param('id');

  const entry = registry.get(id);
  if (!entry) {
    return c.json({ error: `Plugin "${id}" not found` }, 404);
  }

  const body = await c.req.json<{ sessionId: string; config: Record<string, unknown> }>();
  const scope = sessionScopes.get(body.sessionId);
  if (!scope) {
    return c.json({ error: `Session "${body.sessionId}" not found` }, 404);
  }

  scope.setConfigOverride(id, body.config);
  return c.json({ updated: true });
});
