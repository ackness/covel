/**
 * Session routes — RESTful CRUD + session-scoped plugin management.
 *
 * All routes are mounted at `/api/sessions` by bootstrap.ts.
 *
 *   GET    /api/sessions                      — list sessions (optional ?worldId= filter)
 *   POST   /api/sessions                      — create a new session
 *   GET    /api/sessions/:id                  — get session by ID
 *   PATCH  /api/sessions/:id                  — update session fields
 *   DELETE /api/sessions/:id                  — delete session
 *   GET    /api/sessions/:id/plugins          — list active + available plugins
 *   POST   /api/sessions/:id/plugins/enable   — enable a plugin
 *   POST   /api/sessions/:id/plugins/disable  — disable a plugin
 */

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { PluginRegistry } from '@covel/plugin-loader';
import type { DataStore, SessionRecord } from '@covel/store';
import { buildSessionSnapshot } from '@covel/runtime';

const SAFE_WORLD_ID_RE = /^[a-z0-9_-]{1,64}$/i;
const SAFE_SESSION_ID_RE = /^[a-z0-9_-]{1,128}$/i;

type Env = {
  Variables: {
    store: DataStore;
    pluginRegistry: PluginRegistry;
  };
};

export const sessionRoutes = new Hono<Env>();

// ── Collection endpoints ────────────────────────────────────────

// GET /sessions(?worldId=xxx)
sessionRoutes.get('/', async (c) => {
  const store = c.get('store');
  const worldId = c.req.query('worldId');
  const sessions = await store.listSessions();
  const filtered = worldId
    ? sessions.filter((s) => s.worldId === worldId)
    : sessions;
  return c.json({ items: filtered });
});

// POST /sessions
sessionRoutes.post('/', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const body = await c.req.json<Record<string, unknown>>();

  const rawWorldId = typeof body.worldId === 'string' ? body.worldId : undefined;
  if (rawWorldId !== undefined && !SAFE_WORLD_ID_RE.test(rawWorldId)) {
    return c.json({ error: 'Invalid worldId: must match /^[a-z0-9_-]{1,64}$/i' }, 400);
  }

  // Validate client-supplied session ID
  const rawId = typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined;
  if (rawId !== undefined && !SAFE_SESSION_ID_RE.test(rawId)) {
    return c.json({ error: 'Invalid session id: must match /^[a-z0-9_-]{1,128}$/i' }, 400);
  }

  const prefix = rawWorldId ?? 'session';
  const suffix = randomUUID().slice(0, 8);
  const id = rawId ?? `${prefix}-${suffix}`;

  const plugins = (Array.isArray(body.plugins) ? body.plugins : []) as string[];

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id,
    worldId: rawWorldId,
    locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
    phase: 'pre-game',
    turnCount: 0,
    activePlugins: plugins,
    createdAt: now,
    updatedAt: now,
  };

  // Persist BEFORE activating plugins to avoid registry/store inconsistency
  await store.createSession(session);

  for (const pluginId of plugins) {
    if (typeof pluginId === 'string' && pluginRegistry.get(pluginId)) {
      pluginRegistry.activate(pluginId, id);
    }
  }

  return c.json(session);
});

// ── Instance endpoints ──────────────────────────────────────────

// GET /sessions/:id
sessionRoutes.get('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }
  return c.json(session);
});

// PATCH /sessions/:id
sessionRoutes.patch('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const now = new Date().toISOString();
  const updates: Record<string, unknown> = { updatedAt: now };
  if (typeof body.phase === 'string') updates.phase = body.phase;

  await store.updateSession(id, updates as Partial<Pick<SessionRecord, 'phase' | 'turnCount' | 'activePlugins' | 'updatedAt'>>);
  // Return merged result to avoid a second DB read
  return c.json({ ...session, ...updates });
});

// DELETE /sessions/:id
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

// ── Session plugin management ───────────────────────────────────

// GET /sessions/:id/plugins
sessionRoutes.get('/:id/plugins', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const id = c.req.param('id');
  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const active = [...(session.activePlugins ?? [])];
  const all = pluginRegistry.getAll();
  const available = Array.from(all.values()).map((entry) => {
    // Collect capabilities from all loaded runtimes (multi-runtime plugins have sub-entries)
    const caps: string[] = [];
    if (entry.manifest?.manifest.capabilities) {
      caps.push(...entry.manifest.manifest.capabilities);
    }
    for (const [, loaded] of entry.loadedRuntimes) {
      if (loaded.manifest.capabilities) {
        for (const c of loaded.manifest.capabilities) {
          if (!caps.includes(c)) caps.push(c);
        }
      }
    }
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      active: active.includes(entry.id),
      ...(caps.length > 0 ? { capabilities: caps } : {}),
    };
  });

  return c.json({ active, available });
});

// POST /sessions/:id/plugins/enable
sessionRoutes.post('/:id/plugins/enable', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const id = c.req.param('id');
  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const body = await c.req.json<{ pluginId: string }>();
  if (!body.pluginId || !pluginRegistry.get(body.pluginId)) {
    return c.json({ error: `Plugin "${body.pluginId}" not found` }, 404);
  }

  pluginRegistry.activate(body.pluginId, id);
  const active = [...new Set([...(session.activePlugins ?? []), body.pluginId])];
  await store.updateSession(id, { activePlugins: active, updatedAt: new Date().toISOString() });
  return c.json({ ok: true, active });
});

// POST /sessions/:id/plugins/disable
sessionRoutes.post('/:id/plugins/disable', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const id = c.req.param('id');
  const session = await store.getSession(id);
  if (!session) {
    return c.json({ error: `Session not found: ${id}` }, 404);
  }

  const body = await c.req.json<{ pluginId: string }>();
  if (!body.pluginId || typeof body.pluginId !== 'string') {
    return c.json({ error: 'pluginId is required' }, 400);
  }
  pluginRegistry.deactivate(body.pluginId, id);
  const active = (session.activePlugins ?? []).filter((p) => p !== body.pluginId);
  await store.updateSession(id, { activePlugins: active, updatedAt: new Date().toISOString() });
  return c.json({ ok: true, active });
});

// ── Session Snapshot (restore/reconnection) ────────────────────

// GET /sessions/:id/snapshot — complete session state for client restore
sessionRoutes.get('/:id/snapshot', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const id = c.req.param('id');

  const snapshot = await buildSessionSnapshot(store, id);
  if (!snapshot) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Populate plugins from registry + session activePlugins
  const session2 = await store.getSession(id);
  const activeIds = new Set(session2?.activePlugins ?? []);
  const allPlugins = pluginRegistry.getAll();
  const pluginList: Array<{ id: string; name: string; isActive: boolean; priority: number }> = [];
  for (const [, entry] of allPlugins) {
    const manifests = entry.manifests ?? (entry.manifest ? [entry.manifest] : []);
    const primary = manifests[0]?.manifest;
    pluginList.push({
      id: entry.id,
      name: typeof entry.summary.name === 'string' ? entry.summary.name : entry.id,
      isActive: activeIds.has(entry.id),
      priority: primary?.priority ?? 500,
    });
  }
  (snapshot as unknown as Record<string, unknown>).plugins = pluginList;

  // Attach character attribute schema if a world-data-provider plugin exists.
  // Use session.activePlugins from DB + global registry (not in-memory activation map)
  // to survive server restarts / hot-reloads.
  const session = await store.getSession(id);
  const activePlugins = session?.activePlugins ?? [];
  let worldDataPluginId: string | undefined;
  for (const pid of activePlugins) {
    const entry = pluginRegistry.get(pid);
    if (!entry) continue;
    if (entry.manifest?.manifest.capabilities?.includes('world-data-provider')) {
      worldDataPluginId = pid;
      break;
    }
    for (const [, loaded] of entry.loadedRuntimes) {
      if (loaded.manifest.capabilities?.includes('world-data-provider')) {
        worldDataPluginId = pid;
        break;
      }
    }
    if (worldDataPluginId) break;
  }
  if (worldDataPluginId) {
    try {
      const schemaRecord = await store.getPluginData(id, worldDataPluginId, 'schema', 'character-attributes');
      if (schemaRecord?.value) {
        return c.json({ ...snapshot, characterSchema: schemaRecord.value });
      }
    } catch {
      // Non-critical: proceed without schema
    }
  }

  return c.json(snapshot);
});
