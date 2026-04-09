/**
 * V2 World routes — list, get, create/update worlds.
 */

import { Hono } from 'hono';
import type { DataStore, WorldRecord } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const worldRoutes = new Hono<Env>();

// GET /v2/worlds
worldRoutes.get('/', async (c) => {
  const store = c.get('store');
  const worlds = await store.listWorlds();
  return c.json({ items: worlds });
});

// GET /v2/worlds/:id
worldRoutes.get('/:id', async (c) => {
  const store = c.get('store');
  const id = c.req.param('id');
  const world = await store.getWorld(id);
  if (!world) {
    return c.json({ error: 'World not found' }, 404);
  }
  return c.json(world);
});

// POST /v2/worlds
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
    locale: typeof body.locale === 'string' ? body.locale : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : undefined,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : now,
    updatedAt: now,
  };

  await store.upsertWorld(record);
  return c.json(record);
});
