/**
 * V2 Health check route.
 */

import { Hono } from 'hono';

const bootId = crypto.randomUUID();

export const healthRoutes = new Hono();

// GET /v2/health — Health check
healthRoutes.get('/', (c) => {
  return c.json({
    status: 'ok',
    version: '2.0.0',
    storeBackend: process.env.STORE_BACKEND ?? 'pg',
    bootId,
    timestamp: new Date().toISOString(),
  });
});
