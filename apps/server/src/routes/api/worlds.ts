/**
 * API World routes — list, get, create/update worlds.
 */

import { Hono } from 'hono';
import type { DataStore, WorldRecord } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const worldRoutes = new Hono<Env>();

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
  const record: WorldRecord = {
    id: body.id,
    name: body.name,
    description: typeof body.description === 'string' ? body.description : '',
    lore: typeof body.lore === 'string' ? body.lore : undefined,
    tags: Array.isArray(body.tags) ? body.tags as string[] : undefined,
    locale: typeof body.locale === 'string' ? body.locale : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined,
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

  const updated: WorldRecord = {
    ...existing,
    name: typeof body.name === 'string' ? body.name : existing.name,
    description: typeof body.description === 'string' ? body.description : existing.description,
    lore: typeof body.lore === 'string' ? body.lore : existing.lore,
    tags: Array.isArray(body.tags) ? body.tags as string[] : existing.tags,
    locale: typeof body.locale === 'string' ? body.locale : existing.locale,
    metadata: body.metadata && typeof body.metadata === 'object'
      ? body.metadata as Record<string, unknown>
      : existing.metadata,
    updatedAt: now,
  };

  await store.upsertWorld(updated);
  return c.json(updated);
});
