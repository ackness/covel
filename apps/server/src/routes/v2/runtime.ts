/**
 * V2 Runtime routes — independent runtime invocation for testing.
 */

import { Hono } from 'hono';

export const runtimeRoutes = new Hono();

// POST /v2/runtime/invoke — Invoke a single runtime (testing)
runtimeRoutes.post('/invoke', async (c) => {
  return c.json({ error: 'Not implemented' }, 501);
});
