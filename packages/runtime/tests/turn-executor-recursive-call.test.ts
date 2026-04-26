import { describe, expect, it, vi } from 'vitest';
import type { LoadedRuntime } from '@covel/plugin-loader';
import type { RuntimeManifest } from '@covel/shared';
import { executeTurn, MaxRecursionExceeded, type TurnExecutorDeps } from '../src/turn-executor.js';
import { makeEmitterSpy } from './_helpers/emitter-spy.js';

const input = {
  sessionId: 'sess-recursive',
  turnId: 'turn-recursive',
  playerMessage: 'start',
};

function manifest(name: string, extra: Partial<RuntimeManifest> = {}): RuntimeManifest {
  return {
    name,
    pluginId: name.split('/')[0] ?? name,
    description: name,
    runtimeType: 'function',
    priority: 500,
    trigger: { type: 'auto' },
    ...extra,
  };
}

describe('executeTurn recursiveCall', () => {
  it('exposes recursiveCall with incremented recursionDepth and traces nested calls', async () => {
    const caller = manifest('caller');
    const leaf = manifest('leaf', { trigger: { type: 'manual' } });
    const emitter = makeEmitterSpy();

    const loaded = new Map<string, LoadedRuntime>([
      [caller.name, {
        manifest: caller,
        promptTemplate: '',
        references: [],
        handler: async (ctx) => {
          const nested = await ctx.recursiveCall({
            manualTrigger: { runtimeId: 'leaf' },
            playerMessage: 'nested',
          });
          return {
            depth: ctx.recursionDepth,
            nestedDepth: nested.runtimeResults[0]?.output?.depth,
          };
        },
      }],
      [leaf.name, {
        manifest: leaf,
        promptTemplate: '',
        references: [],
        handler: async (ctx) => ({ depth: ctx.recursionDepth }),
      }],
    ]);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      getConfig: () => ({}),
      emitter,
    };

    const result = await executeTurn(input, [caller, leaf], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]?.output).toMatchObject({
      depth: 0,
      nestedDepth: 1,
    });
    expect(emitter.events.map((event) => event.type)).toEqual([
      'recursive.calling',
      'recursive.completed',
    ]);
  });

  it('enforces the runtime maxRecursionDepth limit', async () => {
    const caller = manifest('caller', { maxRecursionDepth: 0 });
    const leaf = manifest('leaf', { trigger: { type: 'manual' } });
    const emitter = makeEmitterSpy();
    const loaded = new Map<string, LoadedRuntime>([
      [caller.name, {
        manifest: caller,
        promptTemplate: '',
        references: [],
        handler: async (ctx) => {
          await ctx.recursiveCall({ manualTrigger: { runtimeId: 'leaf' } });
          return { ok: true };
        },
      }],
      [leaf.name, {
        manifest: leaf,
        promptTemplate: '',
        references: [],
        handler: async () => ({ ok: true }),
      }],
    ]);

    const deps: TurnExecutorDeps = {
      loadRuntime: async (rt) => loaded.get(rt.name),
      llm: { generate: vi.fn() },
      getConfig: () => ({}),
      emitter,
    };

    const result = await executeTurn(input, [caller, leaf], deps);

    expect(result.runtimeResults[0]?.status).toBe('failed');
    expect(result.runtimeResults[0]?.error).toContain('recursiveCall exceeded max depth 0');
    expect(emitter.events.find((event) => event.type === 'recursive.failed')?.payload).toMatchObject({
      runtimeId: 'caller',
      depth: 0,
      nextDepth: 1,
      maxDepth: 0,
    });
    expect(new MaxRecursionExceeded({ runtimeId: 'caller', depth: 1, maxDepth: 0 }).code).toBe('MAX_RECURSION_EXCEEDED');
  });
});
