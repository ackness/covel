/**
 * API Health check route.
 */

import { Hono } from 'hono';

const bootId = crypto.randomUUID();

export const healthRoutes = new Hono();

// GET /health — Health check
healthRoutes.get('/', (c) => {
  return c.json({
    status: 'ok',
    version: '1.0.0',
    storeBackend: process.env.STORE_BACKEND ?? 'pg',
    bootId,
    timestamp: new Date().toISOString(),
  });
});
