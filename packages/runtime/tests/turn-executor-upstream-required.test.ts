/**
 * manifest.upstreamRequired — skip downstream runtimes when a declared
 * upstream failed in the same turn.
 *
 * Without this safeguard, plugins like `core-guide`/`core-codex` that inject
 * `<narrator-output>` would still run when `core-narrator` failed, feeding the
 * LLM an empty inject block and producing hallucinated guidance or codex
 * entries. The framework now short-circuits to `status: 'skipped'` before the
 * guard / LLM pipeline for any runtime whose upstream reported
 * `status !== 'success'` in `completedResults`.
 */

import { describe, it, expect } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import { createMemoryStore } from '@covel/store';
import type { DataStore } from '@covel/store';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: '{}',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function mainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  // Seed a prior player message so turnNumber >= 1 (main-loop band).
  await store.appendTurnMessage({
    id: 'seed',
    sessionId,
    turnId: 'seed-turn',
    sourceType: 'player',
    role: 'user',
    content: 'prior',
    order: 0,
    createdAt: '2024-01-01T00:00:00Z',
  });
  return store;
}

function manifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split('/')[0]!,
    description: name,
    priority: 500,
    runtimeType: 'function',
    handler: './h.js',
    trigger: { type: 'auto' },
    ...overrides,
  } as RuntimeManifest;
}

async function runTurn(
  manifests: readonly RuntimeManifest[],
  handlers: Record<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
): Promise<Awaited<ReturnType<typeof executeTurn>>> {
  const input: TurnInput = { sessionId: 'sess-1', turnId: 'turn-1', playerMessage: 'x' };
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: '',
      references: [],
      handler: handlers[m.name],
    }),
    llm: new NoopLLM(),
    getConfig: () => ({}),
    store: await mainLoopStore('sess-1'),
  };
  return executeTurn(input, manifests, deps);
}

describe('executeTurn: manifest.upstreamRequired', () => {
  it('skips a downstream runtime when its declared upstream failed', async () => {
    const upstream = manifest('core-narrator', { priority: 500 });
    const downstream = manifest('core-guide', {
      priority: 550,
      upstreamRequired: ['core-narrator'],
    });

    const result = await runTurn([upstream, downstream], {
      // Narrator handler throws → produces a failed RuntimeResult.
      'core-narrator': async () => {
        throw new Error('llm provider exploded');
      },
      // Should never be called because the framework skips first.
      'core-guide': async () => {
        throw new Error('downstream should not have executed');
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get('core-narrator')?.status).toBe('failed');
    expect(byId.get('core-guide')?.status).toBe('skipped');

    const skipOutput = byId.get('core-guide')?.output as { reason?: string; skippedBy?: string } | null;
    expect(skipOutput?.reason).toMatch(/upstream/i);
  });

  it('still runs a downstream when the upstream succeeded', async () => {
    const upstream = manifest('core-narrator', { priority: 500 });
    const downstream = manifest('core-guide', {
      priority: 550,
      upstreamRequired: ['core-narrator'],
    });

    let downstreamRan = false;
    const result = await runTurn([upstream, downstream], {
      'core-narrator': async () => ({ narrativeOutput: 'ok' }),
      'core-guide': async () => {
        downstreamRan = true;
        return { ok: true };
      },
    });

    expect(downstreamRan).toBe(true);
    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get('core-narrator')?.status).toBe('success');
    expect(byId.get('core-guide')?.status).toBe('success');
  });

  it('skips when ANY declared upstream is missing (not scheduled)', async () => {
    // core-narrator is declared as required but not in the activeRuntimes
    // list (e.g. disabled for this session). Framework must still skip
    // rather than treating "absent upstream" as success.
    const downstream = manifest('core-guide', {
      priority: 550,
      upstreamRequired: ['core-narrator'],
    });

    const result = await runTurn([downstream], {
      'core-guide': async () => {
        throw new Error('should not run');
      },
    });

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe('skipped');
  });

  it('requires ALL listed upstreams to succeed (not any)', async () => {
    const a = manifest('core-narrator', { priority: 500 });
    const b = manifest('core-npc-graph/rag-retriever', { priority: 490 });
    const downstream = manifest('core-guide', {
      priority: 550,
      upstreamRequired: ['core-narrator', 'core-npc-graph/rag-retriever'],
    });

    const result = await runTurn([a, b, downstream], {
      'core-narrator': async () => ({ narrativeOutput: 'ok' }),
      'core-npc-graph/rag-retriever': async () => {
        throw new Error('retriever blew up');
      },
      'core-guide': async () => {
        throw new Error('downstream should not have executed');
      },
    });

    const byId = new Map(result.runtimeResults.map((r) => [r.runtimeId, r]));
    expect(byId.get('core-guide')?.status).toBe('skipped');
  });
});
