/**
 * Covel V2 Server — Hono application entry point.
 *
 * Boots the V2 plugin system with:
 * - DataStore (SQLite by default, configurable via STORE_BACKEND)
 * - AI gateway (multi-provider LLM via llm.toml)
 * - Plugin discovery from plugins-v2/
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
  ?? resolve(import.meta.dirname, '../../../plugins-v2');

const v2 = await bootstrapV2({
  pluginsDir,
  llmAdapter,
  store,
});

// Mount V2 API
app.route('/', v2.app);

// ── Static file serving (production) ─────────────────────────────
if (process.env.SERVE_STATIC === 'true') {
  const root = process.env.STATIC_DIR ?? './web-dist';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: '/index.html' }));
}

export { app };
