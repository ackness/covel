/**
 * V2 Session routes — create, get, delete game sessions.
 *
 * Dependencies are injected via Hono context variables:
 *   - store: DataStore
 *   - pluginRegistry: PluginRegistry
 */

import { Hono } from 'hono';
import type { PluginRegistry } from '@covel/plugin-loader';
import type { DataStore, SessionRecord } from '@covel/store';

// ── Env type for DI ─────────────────────────────────────────────────

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
  };
};

export const sessionRoutes = new Hono<Env>();

// GET /v2/sessions — List all sessions
sessionRoutes.get('/', async (c) => {
  const store = c.get('store');
  const sessions = await store.listSessions();
  return c.json({ items: sessions });
});

// POST /v2/session/start — Start a new game session
sessionRoutes.post('/start', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');

  const body = await c.req.json<Record<string, unknown>>();

  // Validate plugins field
  if (body.plugins !== undefined && !Array.isArray(body.plugins)) {
    return c.json({ error: 'plugins must be an array of strings' }, 400);
  }

  const id = crypto.randomUUID();
  const plugins = (Array.isArray(body.plugins) ? body.plugins : []) as string[];

  // Activate requested plugins in registry (skip unknown IDs)
  for (const pluginId of plugins) {
    if (typeof pluginId === 'string' && pluginRegistry.get(pluginId)) {
      pluginRegistry.activate(pluginId, id);
    }
  }

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id,
    worldId: typeof body.worldId === 'string' ? body.worldId : undefined,
    locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
    phase: 'pre-game',
    turnCount: 0,
    activePlugins: plugins,
    createdAt: now,
    updatedAt: now,
  };

  await store.createSession(session);

  return c.json({
    sessionId: id,
    phase: session.phase,
    activePlugins: [...session.activePlugins],
  });
});

// GET /v2/session/:id — Get session info
sessionRoutes.get('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const session = await store.getSession(id);

  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  return c.json(session);
});

// DELETE /v2/session/:id — End a session
sessionRoutes.delete('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const session = await store.getSession(id);

  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  await store.deleteSession(id);

  return c.json({ deleted: true });
});
