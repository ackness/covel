/**
 * API Message routes — read-only query endpoints for message history.
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const messageRoutes = new Hono<Env>();

// GET /sessions/:id/messages
messageRoutes.get('/:id/messages', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const messages = await store.listMessages(sessionId);
  return c.json(messages);
});

// POST /sessions/:id/messages/sync — bulk upsert messages (LocalDataService)
messageRoutes.post('/:id/messages/sync', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const body = await c.req.json<{ messages: Array<Record<string, unknown>> }>();
  const msgs = body.messages ?? [];
  for (const msg of msgs) {
    await store.addMessage({
      id: (msg.id as string) ?? crypto.randomUUID(),
      sessionId,
      role: (msg.role as string) ?? 'user',
      content: (msg.content as string) ?? '',
      metadata: { turnId: msg.turnId, runtimeId: msg.runtimeId, block: msg.block },
      createdAt: (msg.createdAt as string) ?? new Date().toISOString(),
    });
  }
  return c.json({ ok: true });
});

// GET /session/:id/turn-messages
messageRoutes.get('/:id/turn-messages', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const turnMessages = await store.listTurnMessages(sessionId);
  return c.json({ items: turnMessages });
});
