/**
 * Covel V2 Server — Hono application entry point.
 *
 * Composition root: middleware → init → mount routes.
 * Route logic lives in routes/ modules.
 */

import { resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAiStack } from './ai-setup.js';
import { createStoreFromEnv } from '@covel/store';
import { createGatewayAdapter } from '@covel/runtime';
import { bootstrapV2 } from './routes/v2/bootstrap.js';
import { seedWorlds } from './world-seed-loader.js';
import { createV1CompatRoutes } from './routes/v1-compat.js';
import { createModelDbRoutes } from './routes/model-db.js';

const app = new Hono();

// ── Global error handler ────────────────────────────────────────
const isDev = process.env.NODE_ENV !== 'production';
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[server] Unhandled error:`, err);
  return c.json(
    { error: isDev ? message : 'Internal server error' },
    500,
  );
});

// ── Middleware ────────────────────────────────────────────────────
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', bodyLimit({ maxSize: 1 * 1024 * 1024 }));
app.use(
  '*',
  cors({
    origin: process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
      : ['http://localhost:5173'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  }),
);

// ── Initialize AI + Store ────────────────────────────────────────
const ai = createAiStack();
const store = await createStoreFromEnv();

const KNOWN_PROVIDERS = ['DEEPSEEK', 'DASHSCOPE', 'OPENAI', 'ANTHROPIC', 'OPENROUTER'] as const;
const apiKeys: Record<string, string> = {};
for (const provider of KNOWN_PROVIDERS) {
  const key = `${provider}_API_KEY`;
  const value = process.env[key];
  if (value) apiKeys[provider.toLowerCase()] = value;
}
const llmAdapter = createGatewayAdapter(ai.gateway, { apiKeys });

// ── Bootstrap V2 ─────────────────────────────────────────────────
const pluginsDir = process.env.COVEL_PLUGINS_DIR
  ?? resolve(import.meta.dirname, '../../../plugins');
const v2 = await bootstrapV2({ pluginsDir, llmAdapter, store });

// ── Seed worlds ──────────────────────────────────────────────────
const worldsDir = process.env.COVEL_WORLDS_DIR
  ?? resolve(import.meta.dirname, '../../../worlds');
await seedWorlds(store, worldsDir);

// ── Mount routes ─────────────────────────────────────────────────
app.route('/', v2.app);                              // V2 API
app.route('/', createV1CompatRoutes(v2, ai));         // V1 compat proxies
app.route('/', createModelDbRoutes(ai));               // Model database API

// ── Static file serving (production) ─────────────────────────────
if (process.env.SERVE_STATIC === 'true') {
  const root = process.env.STATIC_DIR ?? './web-dist';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: '/index.html' }));
}

export { app };
