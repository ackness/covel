/**
 * V2 Health check route.
 */

import { Hono } from 'hono';

export const healthRoutes = new Hono();

// GET /v2/health — Health check
healthRoutes.get('/', (c) => {
  return c.json({
    status: 'ok',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});
