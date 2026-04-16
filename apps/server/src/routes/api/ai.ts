/**
 * API AI routes — LLM-driven generation endpoints.
 *
 * POST /ai/generate-world — Generate a world package from a one-line concept.
 * The LLM autonomously decides all details (id, name, tags, dimensions, lore).
 */

import { resolve } from 'node:path';
import { Hono } from 'hono';
import { createWorld } from '@covel/create';
import type { LLMAdapter } from '@covel/runtime';
import { rateLimiter, singleFlight } from '../../middleware/rate-limit.js';

type Env = {
  Variables: {
    llmAdapter: LLMAdapter;
  };
};

export const aiRoutes = new Hono<Env>();

// POST /ai/generate-world
aiRoutes.post('/generate-world', rateLimiter({ max: 10 }), singleFlight(), async (c) => {
  const llm = c.get('llmAdapter');
  const body = await c.req.json<Record<string, unknown>>();

  const concept = body.concept ?? body.prompt;
  if (typeof concept !== 'string' || !concept.trim()) {
    return c.json({ error: 'concept (string) is required' }, 400);
  }
  if (concept.length > 2000) {
    return c.json({ error: 'concept must be 2000 characters or fewer' }, 400);
  }

  const worldsDir = process.env.COVEL_WORLDS_DIR
    ?? resolve(import.meta.dirname, '../../../../../worlds');

  const result = await createWorld({
    llm,
    concept: concept.trim(),
    outputDir: worldsDir,
    model: typeof body.model === 'string' ? body.model : undefined,
    locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
  });

  if (!result.success) {
    return c.json({ error: 'World generation failed', details: result.errors }, 422);
  }

  return c.json(result);
});
