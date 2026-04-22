/**
 * API World routes — list, get, create/update worlds, dimension import/export.
 */

import { Hono } from 'hono';
import { stringify as stringifyYaml } from 'yaml';
import { validateDimensions } from '@covel/shared';
import type { DataStore, WorldRecord } from '@covel/store';
import type { EventBus } from '@covel/events';
import type { PluginRegistry } from '@covel/plugin-loader';

type Env = {
  Variables: {
    store: DataStore;
    eventBus: EventBus;
    pluginRegistry: PluginRegistry;
  };
};

export const worldRoutes = new Hono<Env>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatWorldEntryContent(key: string, value: unknown): string {
  let body: string;
  try {
    body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    body = String(value);
  }
  return `[${key}]\n${body}`;
}

function resolveWorldMetadata(
  body: Record<string, unknown>,
  existingMetadata?: Readonly<Record<string, unknown>>,
): { metadata?: Record<string, unknown>; changedDimensionKeys?: readonly string[]; error?: { status: 400 | 422; body: Record<string, unknown> } } {
  const hasMetadataPatch = Object.prototype.hasOwnProperty.call(body, 'metadata');
  if (hasMetadataPatch && body.metadata !== undefined && !isRecord(body.metadata)) {
    return {
      error: {
        status: 400,
        body: { error: 'metadata must be an object when provided' },
      },
    };
  }

  const metadataPatch = isRecord(body.metadata) ? body.metadata : undefined;
  const hasTopLevelDimensions = Object.prototype.hasOwnProperty.call(body, 'dimensions');
  const hasMetadataDimensions = metadataPatch !== undefined &&
    Object.prototype.hasOwnProperty.call(metadataPatch, 'dimensions');
  const rawDimensions = hasTopLevelDimensions ? body.dimensions : metadataPatch?.dimensions;

  if ((hasTopLevelDimensions || hasMetadataDimensions) && !isRecord(rawDimensions)) {
    return {
      error: {
        status: 400,
        body: { error: 'dimensions must be an object when provided' },
      },
    };
  }

  const mergedMetadata = {
    ...(existingMetadata ?? {}),
    ...(metadataPatch ?? {}),
  };

  if (hasTopLevelDimensions || hasMetadataDimensions) {
    const validation = validateDimensions(rawDimensions);
    if (!validation.valid) {
      return {
        error: {
          status: 422,
          body: { error: 'Invalid dimensions', details: validation.errors },
        },
      };
    }
    const normalizedDimensions = validation.data as Record<string, unknown>;
    mergedMetadata.dimensions = normalizedDimensions;
    return {
      metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
      changedDimensionKeys: Object.keys(normalizedDimensions),
    };
  }

  return {
    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
  };
}

// GET /worlds
worldRoutes.get('/', async (c) => {
  const store = c.get('store');
  const worlds = await store.listWorlds();
  return c.json({ items: worlds });
});

// GET /worlds/:id
worldRoutes.get('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const world = await store.getWorld(id);
  if (!world) {
    return c.json({ error: 'World not found' }, 404);
  }
  return c.json(world);
});

// POST /worlds
worldRoutes.post('/', async (c) => {
  const store = c.get('store');
  const body = await c.req.json<Record<string, unknown>>();

  if (!body.id || typeof body.id !== 'string') {
    return c.json({ error: 'id (string) is required' }, 400);
  }
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name (string) is required' }, 400);
  }

  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }
  const record: WorldRecord = {
    id: body.id,
    name: body.name,
    description: typeof body.description === 'string' ? body.description : '',
    lore: typeof body.lore === 'string' ? body.lore : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    locale: typeof body.locale === 'string' ? body.locale : undefined,
    metadata: metadataResult.metadata,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : now,
    updatedAt: now,
  };

  await store.upsertWorld(record);
  return c.json(record);
});

// PATCH /worlds/:id — partial update (overlay lore, tags, etc.)
worldRoutes.patch('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const existing = await store.getWorld(id);
  if (!existing) {
    return c.json({ error: 'World not found' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const now = new Date().toISOString();
  const metadataResult = resolveWorldMetadata(body, existing.metadata);
  if (metadataResult.error) {
    return c.json(metadataResult.error.body, metadataResult.error.status);
  }

  const updated: WorldRecord = {
    ...existing,
    name: typeof body.name === 'string' ? body.name : existing.name,
    description: typeof body.description === 'string' ? body.description : existing.description,
    lore: typeof body.lore === 'string' ? body.lore : existing.lore,
    tags: Array.isArray(body.tags) ? body.tags as string[] : existing.tags,
    locale: typeof body.locale === 'string' ? body.locale : existing.locale,
    metadata: metadataResult.metadata,
    updatedAt: now,
  };

  await store.upsertWorld(updated);
  return c.json(updated);
});

// ── Dimension Export/Import ─────────────────────────────────────

// GET /worlds/:id/dimensions/export — download dimensions as YAML
worldRoutes.get('/:id/dimensions/export', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const world = await store.getWorld(id);
  if (!world) {
    return c.json({ error: 'World not found' }, 404);
  }

  const meta = world.metadata as Record<string, unknown> | undefined;
  const dimensions = meta?.dimensions ?? {};

  const format = c.req.query('format') ?? 'yaml';

  if (format !== 'yaml' && format !== 'json') {
    return c.json({ error: 'Invalid format. Use "yaml" or "json".' }, 400);
  }

  if (format === 'json') {
    return c.json(dimensions, 200, {
      'Content-Disposition': `attachment; filename="${id}-dimensions.json"`,
    });
  }

  // Default: YAML
  const yaml = stringifyYaml(dimensions, { lineWidth: 120 });
  return c.text(yaml, 200, {
    'Content-Type': 'application/x-yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename="${id}-dimensions.yaml"`,
  });
});

// POST /worlds/:id/dimensions/import — import dimensions from JSON body
worldRoutes.post('/:id/dimensions/import', async (c) => {
  const store = c.get('store');
  const eventBus = c.get('eventBus');
  const id = c.req.param('id');

  const existing = await store.getWorld(id);
  if (!existing) {
    return c.json({ error: 'World not found' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();
  const dimensions = body.dimensions;

  if (!dimensions || typeof dimensions !== 'object') {
    return c.json({ error: 'dimensions (object) is required' }, 400);
  }

  // Validate against worldDimensionsSchema
  const validation = validateDimensions(dimensions);
  if (!validation.valid) {
    return c.json({ error: 'Invalid dimensions', details: validation.errors }, 422);
  }

  const now = new Date().toISOString();
  const meta = (existing.metadata as Record<string, unknown>) ?? {};
  const updated: WorldRecord = {
    ...existing,
    metadata: { ...meta, dimensions: validation.data },
    updatedAt: now,
  };

  await store.upsertWorld(updated);

  // Notify active sessions
  const sessions = await store.listSessions();
  const affected = sessions.filter((s) => s.worldId === id);
  for (const session of affected) {
    eventBus.emit({
      id: crypto.randomUUID(),
      type: 'event',
      topic: 'system',
      payload: {
        _subTopic: 'system',
        _subType: 'world.dimensions.changed',
        worldId: id,
        changedKeys: Object.keys(dimensions),
      },
      sessionId: session.id,
      timestamp: now,
    });
  }

  return c.json(updated);
});

// ── Session Dimension Sync ──────────────────────────────────────

// POST /worlds/:id/sync-dimensions — re-import world dimensions into a session's
// plugin_data and lorebook canonical entries.
worldRoutes.post('/:id/sync-dimensions', async (c) => {
  const store = c.get('store');
  const pluginRegistry = c.get('pluginRegistry');
  const id = c.req.param('id');

  const body = await c.req.json<Record<string, unknown>>();
  const sessionId = body.sessionId;
  if (typeof sessionId !== 'string') {
    return c.json({ error: 'sessionId (string) is required' }, 400);
  }

  const world = await store.getWorld(id);
  if (!world) {
    return c.json({ error: 'World not found' }, 404);
  }

  const session = await store.getSession(sessionId);
  if (!session || session.worldId !== id) {
    return c.json({ error: 'Session not found or world mismatch' }, 404);
  }

  // Discover world-data-provider plugin by capability (not hardcoded ID)
  const worldDataPluginId = pluginRegistry.findPluginByCapability(sessionId, 'world-data-provider');
  if (!worldDataPluginId) {
    return c.json({ error: 'No world-data-provider plugin active in session' }, 422);
  }

  const meta = world.metadata as Record<string, unknown> | undefined;
  const dimensions = (meta?.dimensions ?? {}) as Record<string, unknown>;

  if (Object.keys(dimensions).length === 0) {
    return c.json({ error: 'World has no dimensions to sync' }, 422);
  }

  const now = new Date().toISOString();
  const nextKeys = new Set(Object.keys(dimensions));
  const existingRecords = await store.listPluginData(sessionId, worldDataPluginId, 'entries');
  const stalePluginDataKeys = existingRecords
    .filter((record) => !nextKeys.has(record.key))
    .map((record) => record.key);
  const records = Object.entries(dimensions).map(([key, value]) => ({
    id: crypto.randomUUID(),
    sessionId,
    pluginId: worldDataPluginId,
    namespace: 'entries',
    key,
    value,
    createdAt: now,
    updatedAt: now,
  }));

  for (const key of stalePluginDataKeys) {
    await store.deletePluginData(sessionId, worldDataPluginId, 'entries', key);
  }
  await store.setPluginDataBatch(records);

  if (typeof store.upsertLorebookEntries === 'function') {
    const lorebookRecords = Object.entries(dimensions).map(([key, value], idx) => ({
      id: `world-entry:${key}`,
      sessionId,
      pluginId: worldDataPluginId,
      keys: [key],
      content: formatWorldEntryContent(key, value),
      strategy: 'constant' as const,
      position: 'after_char_defs',
      insertionOrder: 100 + idx * 100,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }));
    await store.upsertLorebookEntries(lorebookRecords);

    if (typeof store.listSessionLorebookEntries === 'function' && typeof store.deleteLorebookEntry === 'function') {
      const staleLorebookEntries = (await store.listSessionLorebookEntries(sessionId)).filter((entry) => {
        if (entry.pluginId !== worldDataPluginId || entry.strategy !== 'constant') return false;
        if (!entry.id.startsWith('world-entry:')) return false;
        const key = entry.keys[0] ?? entry.id.slice('world-entry:'.length);
        return !nextKeys.has(key);
      });
      for (const entry of staleLorebookEntries) {
        await store.deleteLorebookEntry(sessionId, entry.id);
      }
    }
  }

  return c.json({
    success: true,
    syncedKeys: Object.keys(dimensions),
    entryCount: records.length,
  });
});
