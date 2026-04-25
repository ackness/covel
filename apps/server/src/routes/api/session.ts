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
import { getPluginTrustInfo } from '@covel/plugin-loader';
import type { PluginRegistry, PluginRegistryEntry } from '@covel/plugin-loader';
import type { DataStore, SessionRecord } from '@covel/store';
import { supportsVector } from '@covel/store';
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

function isRequiredCorePlugin(entry: PluginRegistryEntry): boolean {
  const trust = getPluginTrustInfo(entry.id, entry.source);
  return entry.summary.pluginType === 'core-plugin' && trust.source === 'builtin';
}

function requiredCorePluginIds(pluginRegistry: PluginRegistry): string[] {
  return [...pluginRegistry.getAll().values()]
    .filter(isRequiredCorePlugin)
    .map((entry) => entry.id);
}

/**
 * Decorate a SessionRecord with the embedding model lock metadata.
 *
 * The session row only stores the registry id (`embeddingModelId`); the
 * UI needs the full identity to render a "session locked to model X"
 * indicator. We resolve the lazy join here rather than denormalising
 * into the sessions table to keep the storage model simple.
 *
 * Returns the session unchanged when the store has no vector capability
 * or the session has not yet been locked.
 */
async function withEmbeddingMetadata(
  store: DataStore,
  session: SessionRecord,
): Promise<SessionRecord & { embedding?: SessionEmbeddingInfo | null }> {
  if (!supportsVector(store) || session.embeddingModelId == null) {
    return session;
  }
  try {
    const models = await store.listVectorModels();
    const match = models.find((m) => m.id === session.embeddingModelId);
    if (!match) return session;
    return {
      ...session,
      embedding: {
        modelId: match.modelId,
        provider: match.provider,
        modelName: match.modelName,
        dim: match.dim,
        lockedAt: session.embeddingLockedAt ?? null,
      },
    };
  } catch {
    return session;
  }
}

interface SessionEmbeddingInfo {
  modelId: string;
  provider: string;
  modelName: string;
  dim: number;
  lockedAt: string | null;
}

/**
 * Bulk-decorate a session list with embedding metadata.
 *
 * Resolves all `vector_models` rows once and joins in memory, so a list
 * of N sessions costs one extra DB call instead of N. Sessions without a
 * lock pass through untouched.
 */
async function decorateSessionList(
  store: DataStore,
  sessions: readonly SessionRecord[],
): Promise<SessionRecord[]> {
  if (!supportsVector(store) || sessions.length === 0) {
    return sessions.slice();
  }
  const anyLocked = sessions.some((s) => s.embeddingModelId != null);
  if (!anyLocked) return sessions.slice();
  let models: Awaited<ReturnType<typeof store.listVectorModels>>;
  try {
    models = await store.listVectorModels();
  } catch {
    return sessions.slice();
  }
  const byId = new Map(models.map((m) => [m.id, m]));
  return sessions.map((session) => {
    if (session.embeddingModelId == null) return session;
    const match = byId.get(session.embeddingModelId);
    if (!match) return session;
    return {
      ...session,
      embedding: {
        modelId: match.modelId,
        provider: match.provider,
        modelName: match.modelName,
        dim: match.dim,
        lockedAt: session.embeddingLockedAt ?? null,
      } satisfies SessionEmbeddingInfo,
    };
  });
}

// ── Collection endpoints ────────────────────────────────────────

// GET /sessions(?worldId=xxx)
sessionRoutes.get('/', async (c) => {
  const store = c.get('store');
  const worldId = c.req.query('worldId');
  const sessions = await store.listSessions();
  const filtered = worldId
    ? sessions.filter((s) => s.worldId === worldId)
    : sessions;
  // Decorate each session with embedding metadata so the archive list
  // can show RAG status badges without an extra round-trip per row.
  // listVectorModels is called once and shared across all sessions.
  const decorated = await decorateSessionList(store, filtered);
  return c.json({ items: decorated });
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

  const requestedPlugins = Array.isArray(body.plugins)
    ? body.plugins.filter((pluginId): pluginId is string => typeof pluginId === 'string')
    : [];

  // Validate that every requested plugin ID exists in the global registry
  const unknownPlugins = requestedPlugins.filter((pid) => !pluginRegistry.get(pid));
  if (unknownPlugins.length > 0) {
    return c.json({ error: `Unknown plugin IDs: ${unknownPlugins.join(', ')}` }, 400);
  }

  const plugins = [...new Set([...requestedPlugins, ...requiredCorePluginIds(pluginRegistry)])];

  const now = new Date().toISOString();
  const session: SessionRecord = {
    id,
    worldId: rawWorldId,
    locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
    status: 'active',
    turnCount: 0,
    preGameCompleted: [],
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
  return c.json(await withEmbeddingMetadata(store, session));
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

  // Validate status against the SessionStatus union. Pre-existing code
  // previously accepted phase strings; the turn-band refactor replaced
  // phase with a coarser status (`active`/`paused`/`ended`).
  const VALID_STATUSES = new Set(['active', 'paused', 'ended']);
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !VALID_STATUSES.has(body.status)) {
      return c.json(
        {
          error: `status must be one of: ${[...VALID_STATUSES].join(', ')}`,
        },
        400,
      );
    }
    updates.status = body.status;
  }

  // PR-6: per-runtime model slot overrides. Validates shape (object of
  // string→string) before applying. Empty object clears existing overrides.
  // MEDIUM-3: cap entry count and validate each key shape.
  const MAX_OVERRIDE_ENTRIES = 64;
  const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/;
  if (body.runtimeModelOverrides !== undefined) {
    if (
      body.runtimeModelOverrides === null
      || typeof body.runtimeModelOverrides !== 'object'
      || Array.isArray(body.runtimeModelOverrides)
    ) {
      return c.json({ error: 'runtimeModelOverrides must be an object' }, 400);
    }
    const raw = body.runtimeModelOverrides as Record<string, unknown>;
    const rawEntries = Object.entries(raw);
    if (rawEntries.length > MAX_OVERRIDE_ENTRIES) {
      return c.json(
        {
          error: `runtimeModelOverrides must have at most ${MAX_OVERRIDE_ENTRIES} entries (got ${rawEntries.length})`,
        },
        400,
      );
    }
    const cleaned: Record<string, string> = {};
    for (const [key, value] of rawEntries) {
      if (typeof key !== 'string' || !RUNTIME_ID_PATTERN.test(key)) continue;
      if (typeof value !== 'string' || value.length === 0) continue;
      cleaned[key] = value;
    }
    updates.runtimeModelOverrides = cleaned;
  }

  await store.updateSession(id, updates as Partial<Pick<SessionRecord, 'status' | 'turnCount' | 'preGameCompleted' | 'activePlugins' | 'updatedAt' | 'runtimeModelOverrides'>>);
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
    // Aggregated capabilities (plugin-level + runtime-level union) keep the
    // existing UI surface working — `isImageGenActive` and similar gates only
    // need to know "does this plugin do X".
    const caps: string[] = [];
    if (entry.manifest?.manifest.capabilities) {
      caps.push(...entry.manifest.manifest.capabilities);
    }
    // Per-runtime breakdown lets framework code discover the *right* entry
    // runtime without hardcoding plugin/runtime names. Inline buttons (e.g.
    // the narrative "generate illustration" affordance) match by capability +
    // trigger to find which runtime to invoke through plugin-rpc.
    const runtimes: Array<{
      id: string;
      runtimeType?: string;
      trigger?: { type: string; topic?: string };
      capabilities?: string[];
    }> = [];
    for (const [, loaded] of entry.loadedRuntimes) {
      const m = loaded.manifest;
      if (m.capabilities) {
        for (const c of m.capabilities) {
          if (!caps.includes(c)) caps.push(c);
        }
      }
      runtimes.push({
        id: m.name,
        ...(m.runtimeType ? { runtimeType: m.runtimeType } : {}),
        ...(m.trigger
          ? {
              trigger: {
                type: m.trigger.type,
                ...(m.trigger.topic ? { topic: m.trigger.topic } : {}),
              },
            }
          : {}),
        ...(m.capabilities && m.capabilities.length > 0
          ? { capabilities: [...m.capabilities] }
          : {}),
      });
    }
    // Authoritative trust source — derived from the discovery directory,
    // not the plugin's own `pluginType` field (which third-party authors
    // can forge by declaring `pluginType: core-plugin`). When the registry
    // didn't stamp a source (older entries), fall back to the same prefix
    // heuristic the trust gate uses, so the UI sees the value the kernel
    // would enforce.
    const trust = getPluginTrustInfo(entry.id, entry.source);
    return {
      id: entry.id,
      name: entry.summary.name,
      description: entry.summary.description,
      pluginType: entry.summary.pluginType,
      source: trust.source,
      active: active.includes(entry.id),
      ...(caps.length > 0 ? { capabilities: caps } : {}),
      ...(runtimes.length > 0 ? { runtimes } : {}),
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

  // Core plugin protection combines framework-owned trust source metadata
  // with manifest.pluginType. Keep IDs data-driven per the framework-plugin
  // isolation rule.
  const entry = pluginRegistry.get(body.pluginId);
  if (entry && isRequiredCorePlugin(entry)) {
    return c.json({ error: `Cannot disable core plugin "${body.pluginId}"` }, 403);
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
