/**
 * API Create routes — LLM-driven world generation.
 *
 * POST /api/create/world — Generate a world package from a one-line concept.
 * The LLM autonomously decides all details (id, name, tags, dimensions, lore).
 */

import { resolve } from 'node:path';
import { Hono } from 'hono';
import { createWorld } from '@covel/create';
import type { LLMAdapter } from '@covel/runtime';

type Env = {
  Variables: {
    llmAdapter: LLMAdapter;
  };
};

export const createRoutes = new Hono<Env>();

// POST /create/world
createRoutes.post('/world', async (c) => {
  const llm = c.get('llmAdapter');
  const body = await c.req.json<Record<string, unknown>>();

  const concept = body.concept;
  if (typeof concept !== 'string' || !concept.trim()) {
    return c.json({ error: 'concept (string) is required' }, 400);
  }
  if (concept.length > 2000) {
    return c.json({ error: 'concept must be 2000 characters or fewer' }, 400);
  }

  const worldsDir = process.env.COVEL_USER_WORLDS_DIR
    ?? process.env.COVEL_WORLDS_DIR
    ?? resolve(import.meta.dirname, '../../../../../worlds');

  console.log(`[create/world] outputDir=${worldsDir}, concept="${concept.trim().slice(0, 40)}..."`);

  const result = await createWorld({
    llm,
    concept: concept.trim(),
    outputDir: worldsDir,
    model: typeof body.model === 'string' ? body.model : undefined,
    locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
    logger: {
      info: (...args: unknown[]) => console.log('[createWorld]', ...args),
      warn: (...args: unknown[]) => console.warn('[createWorld]', ...args),
      error: (...args: unknown[]) => console.error('[createWorld]', ...args),
    },
  });

  console.log(`[create/world] result success=${result.success} id=${result.id} files=[${result.files.join(', ')}]`);

  if (!result.success) {
    return c.json({ error: 'World generation failed', details: result.errors }, 422);
  }

  return c.json(result);
});
