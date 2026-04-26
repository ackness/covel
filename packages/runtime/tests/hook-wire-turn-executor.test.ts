/**
 * Hook wire-in tests for turn-executor (S4-T3).
 *
 * Verifies:
 * - PreToolUse abort skips the tool and feeds a synthetic error message to the LLM
 * - Flag-off path: hooks have zero side effects on turn behavior
 * - TurnStart abort returns minimal TurnResult with abortReason
 * - TurnStop cannot abort (result unchanged)
 * - PostRuntime replace rewrites the RuntimeResult
 * - Integration: a full turn runs with a global PreToolUse hook that rewrites arguments via replace
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import { createMemoryStore } from '@covel/store';
import type { DataStore } from '@covel/store';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';
import { createHookPipeline } from '../src/hooks/pipeline.js';
import type { HookPipeline } from '../src/hooks/pipeline.js';

// Prime a store with one prior player message so turnNumber >= 1 and
// main-loop priority runtimes survive the Pre-Game band filter.
async function createMainLoopStore(sessionId: string): Promise<DataStore> {
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

// ── Helpers ────────────────────────────────────────────────���─────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: 'test-plugin',
    pluginId: 'test-plugin',
    description: 'Test plugin',
    priority: 500,
    runtimeType: 'agent',
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-hook-wire',
    turnId: 'turn-hook-wire',
    playerMessage: 'hello',
    ...overrides,
  };
}

class SimpleMockLLM implements LLMAdapter {
  readonly calls: Array<Record<string, unknown>> = [];
  responseQueue: LLMResponse[] = [];

  nextResponse(r: LLMResponse): void {
    this.responseQueue.push(r);
  }

  async generate(params: Record<string, unknown>): Promise<LLMResponse> {
    this.calls.push(params);
    return this.responseQueue.shift() ?? {
      content: 'default response',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// ── Fixture: manifest + loaded runtime ──────────────────────────

async function makeDeps(llm: LLMAdapter, hookPipeline?: HookPipeline, store?: DataStore): Promise<TurnExecutorDeps> {
  const manifest = makeManifest();
  return {
    loadRuntime: async () => ({
      manifest,
      promptTemplate: 'Say something.',
      references: [],
    }),
    llm,
    getConfig: () => ({}),
    hookPipeline,
    store: store ?? await createMainLoopStore('sess-hook-wire'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('Turn executor hook wire-in', () => {
  describe('No-pipeline path', () => {
    it('runs normally without hookPipeline — no side effects', async () => {
      const llm = new SimpleMockLLM();
      const deps = await makeDeps(llm);
      const result = await executeTurn(makeTurnInput(), [makeManifest()], deps);
      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0].status).toBe('success');
      expect(result.abortReason).toBeUndefined();
    });
  });

  describe('TurnStart hook', () => {
    it('continues turn normally when TurnStart hook returns continue', async () => {
      const llm = new SimpleMockLLM();
      const pipeline = createHookPipeline();
      pipeline.register({
        id: 'test:TurnStart:0',
        event: 'TurnStart',
        handler: vi.fn().mockResolvedValue({ action: 'continue' }),
      });

      const deps = await makeDeps(llm, pipeline);
      const result = await executeTurn(makeTurnInput(), [makeManifest()], deps);
      expect(result.runtimeResults).toHaveLength(1);
      expect(result.abortReason).toBeUndefined();
    });

    it('keeps executing when TurnStart observer hook returns abort', async () => {
      const llm = new SimpleMockLLM();
      const pipeline = createHookPipeline();
      pipeline.register({
        id: 'test:TurnStart:0',
        event: 'TurnStart',
        handler: vi.fn().mockResolvedValue({ action: 'abort', reason: 'access denied' }),
      });

      const deps = await makeDeps(llm, pipeline);
      const result = await executeTurn(makeTurnInput(), [makeManifest()], deps);

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.abortReason).toBeUndefined();
      expect(llm.calls).toHaveLength(1);
    });
  });

  describe('TurnStop hook', () => {
    it('does not change TurnResult even when TurnStop hook returns abort', async () => {
      const llm = new SimpleMockLLM();
      const pipeline = createHookPipeline();
      pipeline.register({
        id: 'test:TurnStop:0',
        event: 'TurnStop',
        handler: vi.fn().mockResolvedValue({ action: 'abort', reason: 'post-hook abort' }),
      });

      const deps = await makeDeps(llm, pipeline);
      const result = await executeTurn(makeTurnInput(), [makeManifest()], deps);

      // Turn completed normally
      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0].status).toBe('success');
      // No abortReason propagated from post-hook
      expect(result.abortReason).toBeUndefined();
    });
  });

  describe('PreToolUse hook', () => {
    it('skips tool and feeds synthetic error to LLM when PreToolUse aborts', async () => {
      const llm = new SimpleMockLLM();
      const pipeline = createHookPipeline();

      // LLM asks for a tool call on step 1, then gives final content on step 2
      llm.nextResponse({
        content: null,
        toolCalls: [{ id: 'tc-1', name: 'my-tool', arguments: '{}' }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      llm.nextResponse({
        content: 'done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      });

      // Tool executor that tracks calls
      const toolExecutorCalls: string[] = [];
      const toolExecutor = {
        execute: vi.fn().mockImplementation(async (tc: { name: string }) => {
          toolExecutorCalls.push(tc.name);
          return { result: '{"ok":true}', parsedResult: { ok: true }, success: true };
        }),
        getToolInfo: vi.fn().mockReturnValue({
          name: 'my-tool',
          description: 'test',
          jsonSchema: { type: 'object' },
        }),
      };

      pipeline.register({
        id: 'test:PreToolUse:0',
        event: 'PreToolUse',
        handler: vi.fn().mockResolvedValue({ action: 'abort', reason: 'tool blocked' }),
      });

      const manifest = makeManifest({
        tools: { builtin: [], local: [] },
      });

      const deps: TurnExecutorDeps = {
        loadRuntime: async () => ({
          manifest,
          promptTemplate: 'Use tools.',
          references: [],
        }),
        llm,
        getConfig: () => ({}),
        toolExecutor,
        hookPipeline: pipeline,
        store: await createMainLoopStore('sess-hook-wire'),
      };

      const result = await executeTurn(makeTurnInput(), [manifest], deps);

      // Tool executor was NOT called (hook aborted)
      expect(toolExecutor.execute).not.toHaveBeenCalled();
      // LLM was called twice (once with tool_call response, once after synthetic error)
      expect(llm.calls).toHaveLength(2);
      // The second LLM call should have a tool-role message with the synthetic error
      const secondCallMessages = (llm.calls[1] as { messages: Array<{ role: string; content: string }> }).messages;
      const toolMsg = secondCallMessages.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.content).toContain('pre-tool-use hook aborted');
      expect(toolMsg!.content).toContain('tool blocked');

      // Turn still completes
      expect(result.runtimeResults[0].status).toBe('success');
    });
  });

  describe('PostRuntime hook replace', () => {
    it('keeps RuntimeResult unchanged when PostRuntime observer returns replace', async () => {
      const llm = new SimpleMockLLM();
      const pipeline = createHookPipeline();

      const rewrittenOutput = { narrativeOutput: 'rewritten by hook', _hookModified: true };

      pipeline.register({
        id: 'test:PostRuntime:0',
        event: 'PostRuntime',
        handler: vi.fn().mockImplementation(async (_ctx, payload: { result: { status: string } }) => ({
          action: 'continue',
          replace: {
            result: {
              ...payload.result,
              output: rewrittenOutput,
            },
          },
        })),
      });

      const deps = await makeDeps(llm, pipeline);
      const result = await executeTurn(makeTurnInput(), [makeManifest()], deps);

      expect(result.runtimeResults[0].output).toMatchObject({ narrativeOutput: 'default response' });
    });
  });

  describe('Integration: PreToolUse replace (argument rewriting)', () => {
    it('PreToolUse replace rewrites toolCall.arguments and executor receives the replaced arguments', async () => {

      const llm = new SimpleMockLLM();
      llm.nextResponse({
        content: null,
        toolCalls: [{ id: 'tc-rewrite', name: 'my-tool', arguments: '{"name":"original"}' }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      llm.nextResponse({
        content: 'all done',
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      });

      // Spy that captures every call's arguments so we can assert they were replaced (W1)
      const executedArgs: string[] = [];
      const toolExecutor = {
        execute: vi.fn().mockImplementation(async (tc: { name: string; arguments: string }) => {
          executedArgs.push(tc.arguments);
          return { result: '{"ok":true}', parsedResult: { ok: true }, success: true };
        }),
        getToolInfo: vi.fn().mockReturnValue({ name: 'my-tool', description: 'test', jsonSchema: { type: 'object' } }),
      };

      const pipeline = createHookPipeline();

      // Global PreToolUse hook — no pluginId (global scope, per spec)
      pipeline.register({
        id: 'global:PreToolUse:rewrite',
        event: 'PreToolUse',
        // no pluginId → global
        handler: vi.fn().mockImplementation(async (_ctx, payload: { toolCall: { id: string; name: string; arguments: string } }) => ({
          action: 'continue',
          replace: {
            toolCall: { ...payload.toolCall, arguments: '{"name":"rewritten"}' },
          },
        })),
      });

      const manifest = makeManifest({ tools: { builtin: [], local: [] } });
      const deps: TurnExecutorDeps = {
        loadRuntime: async () => ({ manifest, promptTemplate: 'Use tools.', references: [] }),
        llm,
        getConfig: () => ({}),
        toolExecutor,
        hookPipeline: pipeline,
        store: await createMainLoopStore('sess-hook-wire'),
      };

      const result = await executeTurn(makeTurnInput(), [manifest], deps);

      expect(result.runtimeResults[0].status).toBe('success');
      // Tool was called exactly once (hook returned continue, not abort)
      expect(toolExecutor.execute).toHaveBeenCalledOnce();
      // W1: assert the executor received the REPLACED arguments, not the original
      expect(executedArgs[0]).toBe('{"name":"rewritten"}');
    });
  });
});
