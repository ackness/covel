/**
 * Integration test for direct-generate trace emission paths in turn-executor.
 *
 * Specifically covers the malformed-tool-arguments fallback path where
 * `deps.llm.generate` is called directly (bypassing the retry helper) — the
 * Q1 fix ensures this path pairs every `llm.calling` with an `llm.responded`
 * on both success AND error branches.
 *
 * Setup: two sequential LLM failures classified as malformed-tool-args:
 *   1st (retry-helper path): throws the specific error string that
 *      `shouldRetryMalformedToolArguments` recognises → retry helper throws
 *      LLMRetryError with that cause.
 *   2nd (direct-generate fallback): throws another classified error →
 *      exercises the Q1 try/catch and emits llm.responded with
 *      finishReason=error.
 */

import { describe, it, expect } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import { createMemoryStore } from '@covel/store';
import { tool } from '@covel/tools';
import { z } from 'zod';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter } from '../src/llm-adapter.js';
import type { TurnEmitter } from '../src/turn-emitter.js';
import { createToolExecutor } from '../src/tool-executor.js';

function makeEmitterSpy(): TurnEmitter & { events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sessionId: 'sess',
    turnId: 'turn',
    async emit(type, payload) { events.push({ type, payload }); },
    events,
  } as TurnEmitter & { events: Array<{ type: string; payload: Record<string, unknown> }> };
}

async function createMainLoopStore(sessionId = 'sess-1') {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: 'prior-player-0',
    sessionId,
    turnId: 'prior-turn',
    sourceType: 'player',
    role: 'user',
    content: 'prior turn',
    order: 0,
    createdAt: '2024-01-01T00:00:00Z',
  });
  return store;
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'go',
    ...overrides,
  };
}

describe('turn-executor direct-generate error trace pairing (Q1)', () => {
  it('emits llm.responded with finishReason=error when malformed-args fallback also throws', async () => {
    const fallbackTool = tool({
      name: 'fallback-tool',
      description: 'x',
      parameters: z.object({ topic: z.string() }),
      execute: async ({ topic }) => ({ topic }),
    });

    const manifest: RuntimeManifest = {
      name: 'trace-fallback',
      pluginId: 'trace-fallback',
      description: 'Runtime exercising the malformed-args fallback error path.',
      priority: 550,
      tools: { local: ['./tools/fallback-tool.js'] },
    };
    const loaded: LoadedRuntime = {
      manifest,
      promptTemplate: 'Exercise fallback trace.',
      references: [],
    };

    // Error text that matches shouldRetryMalformedToolArguments and causes
    // the retry helper to throw with that classified cause, triggering the
    // direct-generate fallback path.
    const malformedArgsError = () => new Error(
      '[openai-chat] HTTP 400 — <400> InternalError.Algo.InvalidParameter: The "function.arguments" parameter of the code model must be in JSON format.',
    );

    let callCount = 0;
    const llm: LLMAdapter = {
      async generate() {
        callCount++;
        // Every attempt throws a malformed-args-classified error.
        // Helper path: throws → LLMRetryError with classified cause.
        // Fallback direct call: throws → Q1 catch block runs here.
        throw malformedArgsError();
      },
    };

    const emitter = makeEmitterSpy();
    const store = await createMainLoopStore('sess-1');
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => loaded,
      llm,
      getConfig: () => ({}),
      store,
      emitter,
      toolExecutor: createToolExecutor({
        findTool: (name) => (name === 'fallback-tool' ? fallbackTool : undefined),
        store,
      }),
    };

    await executeTurn(makeTurnInput(), [manifest], deps, { maxSteps: 2 });
    // At least 2 calls: retry helper (1 attempt with maxRetries=0 by default, plus the fallback).
    expect(callCount).toBeGreaterThanOrEqual(2);

    // Every llm.calling must have a paired llm.responded — even on the
    // direct-generate fallback error path (Q1 fix).
    const callingEvents = emitter.events.filter(e => e.type === 'llm.calling');
    const respondedEvents = emitter.events.filter(e => e.type === 'llm.responded');
    expect(callingEvents.length).toBeGreaterThan(0);
    expect(respondedEvents.length).toBe(callingEvents.length);

    // At least one llm.responded carries finishReason:error, usage, durationMs.
    const errorResponded = respondedEvents.find(e => e.payload.finishReason === 'error');
    expect(errorResponded).toBeDefined();
    expect(errorResponded!.payload).toMatchObject({
      finishReason: 'error',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(typeof errorResponded!.payload.durationMs).toBe('number');
    expect(errorResponded!.payload.durationMs as number).toBeGreaterThanOrEqual(0);
    expect(typeof errorResponded!.payload.error).toBe('string');
  });
});
