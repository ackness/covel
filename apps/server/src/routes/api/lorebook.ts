/**
 * API Lorebook routes — read + minimal mutation for session-scoped lorebook entries.
 *
 * Session-level lorebook entries live in the framework's lorebook table and are
 * written by plugins via the proposal commit pipeline. This route group exposes
 * them read-only to the player UI, plus two minimal mutations (toggle enabled,
 * delete) so players can mute or remove individual entries.
 *
 * Framework-owned: not tied to any specific plugin. The Lorebook right-panel
 * tab in apps/web consumes this endpoint.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { DataStore } from '@covel/store';

type Env = {
  Variables: {
    store: DataStore;
  };
};

export const lorebookRoutes = new Hono<Env>();

// GET /sessions/:id/lorebook
lorebookRoutes.get('/:id/lorebook', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const entries = await store.listSessionLorebookEntries(sessionId);
  return c.json({ entries });
});

// PATCH /sessions/:id/lorebook/:entryId
// Currently supports toggling `enabled`. The store has no partial-update
// method, so this re-upserts the existing record with the new flag.
lorebookRoutes.patch('/:id/lorebook/:entryId', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const entryId = c.req.param('entryId');
  const raw = await c.req.json<unknown>().catch(() => null);
  const bodySchema = z.object({ enabled: z.boolean() });
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ error: 'Invalid body: expected { enabled: boolean }' }, 400);
  }

  const existing = (await store.listSessionLorebookEntries(sessionId)).find(
    (e) => e.id === entryId,
  );
  if (!existing) {
    return c.json({ error: 'Lorebook entry not found' }, 404);
  }

  const now = new Date().toISOString();
  await store.upsertLorebookEntries([
    {
      ...existing,
      enabled: parsed.data.enabled,
      updatedAt: now,
    },
  ]);

  return c.json({ success: true, entryId, enabled: parsed.data.enabled });
});

// DELETE /sessions/:id/lorebook/:entryId
lorebookRoutes.delete('/:id/lorebook/:entryId', async (c) => {
  const store = c.get('store');
  const sessionId = c.req.param('id');
  const session = await store.getSession(sessionId);
  if (!session) return c.json({ error: 'Session not found' }, 404);

  const entryId = c.req.param('entryId');
  const existing = (await store.listSessionLorebookEntries(sessionId)).find(
    (e) => e.id === entryId,
  );
  if (!existing) {
    return c.json({ error: 'Lorebook entry not found' }, 404);
  }

  await store.deleteLorebookEntry(sessionId, entryId);
  return c.json({ success: true });
});
