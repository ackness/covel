/**
 * API AI routes — LLM-driven generation endpoints.
 *
 * POST /ai/generate-world — Generate a world package from a one-line concept.
 * Streams Server-Sent Events so the UI can show phase progress
 * (generating → validating → saving) and receive the final WorldRecord.
 */

import path, { resolve } from 'node:path';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createWorld } from '@covel/create';
import type { LLMAdapter } from '@covel/runtime';
import type { DataStore } from '@covel/store';
import { rateLimiter, singleFlight } from '../../middleware/rate-limit.js';
import { loadSingleWorld } from '../../world-seed-loader.js';

type Env = {
  Variables: {
    llmAdapter: LLMAdapter;
    store: DataStore;
  };
};

export const aiRoutes = new Hono<Env>();

interface ProgressEvent {
  type: 'progress';
  phase: 'generating' | 'validating' | 'saving';
}
interface DoneEvent {
  type: 'done';
  world: unknown;
}
interface ErrorEvent {
  type: 'error';
  message: string;
}
type GenerateEvent = ProgressEvent | DoneEvent | ErrorEvent;

// POST /ai/generate-world
aiRoutes.post('/generate-world', rateLimiter({ max: 10 }), singleFlight(), async (c) => {
  const llm = c.get('llmAdapter');
  const store = c.get('store');
  const body = await c.req.json<Record<string, unknown>>();

  const concept = body.concept ?? body.prompt;
  if (typeof concept !== 'string' || !concept.trim()) {
    return c.json({ error: 'concept (string) is required' }, 400);
  }
  if (concept.length > 4000) {
    return c.json({ error: 'concept must be 4000 characters or fewer' }, 400);
  }

  const worldsDir = process.env.COVEL_USER_WORLDS_DIR
    ?? process.env.COVEL_WORLDS_DIR
    ?? resolve(import.meta.dirname, '../../../../../worlds');

  console.log(`[ai/generate-world] outputDir=${worldsDir}, concept="${(concept as string).trim().slice(0, 40)}..."`);

  return streamSSE(c, async (stream) => {
    const send = async (event: GenerateEvent) => {
      await stream.writeSSE({ data: JSON.stringify(event) });
    };

    try {
      await send({ type: 'progress', phase: 'generating' });

      const createOpts = {
        llm,
        concept: (concept as string).trim(),
        outputDir: worldsDir,
        model: typeof body.model === 'string' ? body.model : undefined,
        locale: typeof body.locale === 'string' ? body.locale : 'zh-CN',
        logger: {
          info: (...args: unknown[]) => console.log('[createWorld]', ...args),
          warn: (...args: unknown[]) => console.warn('[createWorld]', ...args),
          error: (...args: unknown[]) => console.error('[createWorld]', ...args),
        },
      };

      const startMs = Date.now();
      const result = await createWorld(createOpts);
      const elapsedMs = Date.now() - startMs;

      console.log(`[ai/generate-world] createWorld finished in ${elapsedMs}ms success=${result.success} id=${result.id}`);

      if (!result.success) {
        console.error(`[ai/generate-world] generation failed after ${elapsedMs}ms:`, result.errors);
        await send({
          type: 'error',
          message: result.errors?.join('\n') ?? 'World generation failed',
        });
        return;
      }

      await send({ type: 'progress', phase: 'validating' });

      // Reload the freshly written world.yaml into a WorldRecord and upsert
      // into the store so the listing endpoint immediately reflects it.
      const worldDir = path.join(worldsDir, result.id);
      const record = await loadSingleWorld(worldDir);

      if (!record) {
        await send({
          type: 'error',
          message: `Generated world "${result.id}" failed post-write validation`,
        });
        return;
      }

      await send({ type: 'progress', phase: 'saving' });
      await store.upsertWorld(record);

      console.log(`[ai/generate-world] world saved to store: id=${record.id}`);
      await send({ type: 'done', world: record });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ai/generate-world] unexpected error:', msg);
      await send({
        type: 'error',
        message: msg,
      });
    }
  });
});
