/**
 * Hook pipeline emitter integration tests.
 *
 * Verifies that HookPipeline.run() fans out `hook.fired`, `hook.rewrote`, and
 * `hook.aborted` into the TurnEmitter so the /debug timeline can render every
 * hook invocation without reaching into the eventBus wire.
 */

import { describe, it, expect } from 'vitest';
import { createHookPipeline } from '../src/hooks/pipeline.js';
import type { TurnEmitter } from '../src/turn-emitter.js';

interface EmitterSpy extends TurnEmitter {
  readonly events: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeEmitterSpy(): EmitterSpy {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sessionId: 'sess',
    turnId: 'turn',
    async emit(type: string, payload: Record<string, unknown>): Promise<void> {
      events.push({ type, payload });
    },
    events,
  };
}

describe('HookPipeline emitter integration', () => {
  it('emits hook.fired for each handler invoked', async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: 'hook-a',
      event: 'PreStateCommit',
      handler: async () => ({ action: 'continue' }),
    });

    await pipeline.run(
      'PreStateCommit',
      { event: 'PreStateCommit', sessionId: 'S', turnId: 'T' },
      { proposal: { id: 'p1' } },
      { emitter },
    );

    const fired = emitter.events.find((e) => e.type === 'hook.fired');
    expect(fired).toBeDefined();
    expect(fired!.payload).toMatchObject({
      event: 'PreStateCommit',
      hookName: 'hook-a',
      targetId: 'p1',
      targetType: 'proposal',
    });
  });

  it('emits hook.rewrote when handler returns replace', async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: 'hook-b',
      event: 'PreStateCommit',
      handler: async () => ({
        action: 'continue',
        replace: { proposal: { id: 'p1', mutated: true } },
      }),
    });

    await pipeline.run(
      'PreStateCommit',
      { event: 'PreStateCommit', sessionId: 'S', turnId: 'T' },
      { proposal: { id: 'p1' } },
      { emitter },
    );

    const rewrote = emitter.events.find((e) => e.type === 'hook.rewrote');
    expect(rewrote).toBeDefined();
    expect(rewrote!.payload).toMatchObject({
      event: 'PreStateCommit',
      hookName: 'hook-b',
    });
    expect(rewrote!.payload.diff).toBeDefined();
  });

  it('emits hook.aborted on abort', async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: 'hook-c',
      event: 'PreStateCommit',
      handler: async () => ({ action: 'abort', reason: 'policy-no' }),
    });

    await pipeline.run(
      'PreStateCommit',
      { event: 'PreStateCommit', sessionId: 'S', turnId: 'T' },
      { proposal: { id: 'p1' } },
      { emitter },
    );

    const aborted = emitter.events.find((e) => e.type === 'hook.aborted');
    expect(aborted).toBeDefined();
    expect(aborted!.payload).toMatchObject({
      event: 'PreStateCommit',
      hookName: 'hook-c',
      reason: 'policy-no',
      targetId: 'p1',
      targetType: 'proposal',
    });
  });

  it('extracts targetId from toolCall payload for PreToolUse', async () => {
    const emitter = makeEmitterSpy();
    const pipeline = createHookPipeline();
    pipeline.register({
      id: 'hook-tool',
      event: 'PreToolUse',
      handler: async () => ({ action: 'continue' }),
    });

    await pipeline.run(
      'PreToolUse',
      { event: 'PreToolUse', sessionId: 'S', turnId: 'T', pluginId: 'p', runtimeId: 'r' },
      { toolCall: { toolCallId: 'tc-42', name: 'foo', arguments: '{}' } },
      { emitter },
    );

    const fired = emitter.events.find((e) => e.type === 'hook.fired');
    expect(fired!.payload).toMatchObject({
      event: 'PreToolUse',
      targetId: 'tc-42',
      targetType: 'toolCall',
    });
  });
});
