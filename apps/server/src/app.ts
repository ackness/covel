/**
 * Covel V2 Server — Hono application entry point.
 *
 * Boots the V2 plugin system with:
 * - DataStore (SQLite by default, configurable via STORE_BACKEND)
 * - AI gateway (multi-provider LLM via llm.toml)
 * - Plugin discovery from plugins/
 * - V2 API routes
 */

import { resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAiStack } from './ai-setup.js';
import { createStoreFromEnv } from '@covel/store';
import { createGatewayAdapter } from '@covel/runtime';
import { bootstrapV2 } from './routes/v2/bootstrap.js';

const app = new Hono();

// ── Middleware ────────────────────────────────────────────────────
app.use('*', logger());
app.use('*', secureHeaders());

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

// Build API keys map for gateway (restrict to known providers)
const KNOWN_PROVIDERS = ['DEEPSEEK', 'DASHSCOPE', 'OPENAI', 'ANTHROPIC', 'OPENROUTER'] as const;
const apiKeys: Record<string, string> = {};
for (const provider of KNOWN_PROVIDERS) {
  const key = `${provider}_API_KEY`;
  const value = process.env[key];
  if (value) {
    apiKeys[provider.toLowerCase()] = value;
  }
}

const llmAdapter = createGatewayAdapter(ai.gateway, { apiKeys });

// ── Bootstrap V2 ─────────────────────────────────────────────────
const pluginsDir = process.env.COVEL_PLUGINS_DIR
  ?? resolve(import.meta.dirname, '../../../plugins');

const v2 = await bootstrapV2({
  pluginsDir,
  llmAdapter,
  store,
});

// Mount V2 API
app.route('/', v2.app);

// ── V1 compatibility routes ──────────────────────────────────────
// Frontend uses v1-style paths; mount V2 handlers at v1 paths.
app.get('/api/health', async (c) => {
  const res = await v2.app.request('/v2/health');
  return new Response(res.body, { status: res.status, headers: res.headers });
});
app.get('/worlds', async (c) => {
  const res = await v2.app.request('/v2/worlds');
  return new Response(res.body, { status: res.status, headers: res.headers });
});
app.get('/worlds/:id', async (c) => {
  const res = await v2.app.request(`/v2/worlds/${c.req.param('id')}`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});
app.get('/sessions', async (c) => {
  const res = await v2.app.request('/v2/sessions');
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// V1 POST session create → proxy to V2 with auto-activated plugins
app.post('/sessions', async (c) => {
  const rawBody = await c.req.json<Record<string, unknown>>();
  // Auto-activate all available plugins if none specified
  const allPluginIds = [...v2.registry.getAll().keys()];
  const enriched = {
    ...rawBody,
    plugins: rawBody.plugins ?? allPluginIds,
    locale: rawBody.locale ?? 'zh-CN',
  };
  const res = await v2.app.request('/v2/session/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(enriched),
  });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// V1 session sub-routes → proxy to V2
app.get('/sessions/:id', async (c) => {
  const res = await v2.app.request(`/v2/session/${c.req.param('id')}`);
  return new Response(res.body, { status: res.status, headers: res.headers });
});
app.delete('/sessions/:id', async (c) => {
  const res = await v2.app.request(`/v2/session/${c.req.param('id')}`, { method: 'DELETE' });
  return new Response(res.body, { status: res.status, headers: res.headers });
});
app.patch('/sessions/:id', async (c) => {
  const body = await c.req.text();
  const res = await v2.app.request(`/v2/session/${c.req.param('id')}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// V1 endpoints with no V2 equivalent — return empty stubs
app.get('/presets', (c) => c.json([]));
app.get('/packages', (c) => c.json([]));
app.get('/commands', (c) => c.json([]));
app.get('/api/llm-config', (c) => c.json({ slots: {} }));
app.get('/api/provider-keys', (c) => c.json({}));
app.post('/api/provider-keys', (c) => c.json({ ok: true }));
app.get('/sessions/:id/state-patches', (c) => c.json([]));
app.get('/sessions/:id/state-snapshot', (c) => c.json(null));
app.put('/sessions/:id/state-snapshot', (c) => c.json({ ok: true }));

// ── Static file serving (production) ─────────────────────────────
if (process.env.SERVE_STATIC === 'true') {
  const root = process.env.STATIC_DIR ?? './web-dist';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: '/index.html' }));
}

export { app };
