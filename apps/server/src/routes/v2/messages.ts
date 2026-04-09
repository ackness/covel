/**
 * V2 Message routes — read-only query endpoints for message history.
 */

import { Hono } from 'hono';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const messageRoutes = new Hono<Env>();

// GET /v2/session/:id/messages
messageRoutes.get('/:id/messages', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  const messages = await store.listMessages(sessionId);
  return c.json({ items: messages });
});

// GET /v2/session/:id/turn-messages
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
