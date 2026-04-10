/**
 * API Character routes — list and upsert characters for a session.
 */

import { Hono } from 'hono';
import type { DataStore, CharacterRecord } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const characterRoutes = new Hono<Env>();

// GET /session/:id/characters
characterRoutes.get('/:id/characters', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const characters = await store.listCharacters(sessionId);
  return c.json({ items: characters });
});

// POST /session/:id/characters
characterRoutes.post('/:id/characters', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');

  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const body = await c.req.json<Record<string, unknown>>();

  if (!body.id || typeof body.id !== 'string') {
    return c.json({ error: 'id (string) is required' }, 400);
  }
  if (!body.name || typeof body.name !== 'string') {
    return c.json({ error: 'name (string) is required' }, 400);
  }

  const now = new Date().toISOString();
  const record: CharacterRecord = {
    id: body.id,
    sessionId,
    name: body.name,
    type: typeof body.type === 'string' ? body.type : 'npc',
    description: typeof body.description === 'string' ? body.description : undefined,
    fields: body.fields && typeof body.fields === 'object' ? body.fields : undefined,
    version: typeof body.version === 'number' ? body.version : 1,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : now,
    updatedAt: now,
  };

  await store.upsertCharacter(record);
  return c.json(record);
});
