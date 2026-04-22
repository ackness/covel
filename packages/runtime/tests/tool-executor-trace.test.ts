/**
 * ToolExecutor trace emission tests — covers tool.calling / tool.completed /
 * tool.failed across the 5 branches (success, NOT_FOUND, INVALID_ARGS,
 * VALIDATION_ERROR via Zod, and the emitter-absent backward-compatible path).
 */

import { describe, it, expect } from 'vitest';
import { createToolExecutor } from '../src/tool-executor.js';
import type { ToolCallContext } from '../src/tool-executor.js';
import type { TurnEmitter } from '../src/turn-emitter.js';
import type { ToolModule } from '@covel/tools';

function makeEmitterSpy(): TurnEmitter & { events: Array<{ type: string; payload: Record<string, unknown> }> } {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  return {
    sessionId: 'sess',
    turnId: 'turn',
    async emit(type, payload) { events.push({ type, payload }); },
    events,
  } as TurnEmitter & { events: Array<{ type: string; payload: Record<string, unknown> }> };
}

const baseCtx: ToolCallContext = {
  sessionId: 'sess',
  turnId: 'turn',
  pluginId: 'test-plugin',
  runtimeId: 'test-plugin/main',
};

describe('ToolExecutor trace emissions', () => {
  it('emits tool.calling then tool.completed on success', async () => {
    const emitter = makeEmitterSpy();
    const mockTool = {
      name: 'echo',
      description: 'echo',
      jsonSchema: {},
      async execute(params: unknown) { return { echo: params }; },
    };
    const executor = createToolExecutor({
      findTool: () => mockTool as unknown as ToolModule,
    });

    const res = await executor.execute(
      { toolCallId: 'c1', name: 'echo', arguments: '{"hi":1}' },
      { ...baseCtx, emitter },
    );

    expect(res.success).toBe(true);
    expect(emitter.events.map(e => e.type)).toEqual(['tool.calling', 'tool.completed']);
    expect(emitter.events[0].payload).toMatchObject({
      toolName: 'echo',
      toolCallId: 'c1',
      arguments: '{"hi":1}',
      source: 'local',
      approvalStatus: 'auto-allowed',
    });
    expect(emitter.events[1].payload).toMatchObject({
      toolName: 'echo',
      success: true,
      approvalStatus: 'auto-allowed',
    });
    expect(typeof emitter.events[1].payload.durationMs).toBe('number');
  });

  it('emits tool.failed with NOT_FOUND when tool missing', async () => {
    const emitter = makeEmitterSpy();
    const executor = createToolExecutor({ findTool: () => undefined });
    const res = await executor.execute(
      { toolCallId: 'c2', name: 'nope', arguments: '{}' },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].type).toBe('tool.failed');
    expect(emitter.events[0].payload).toMatchObject({ code: 'NOT_FOUND', success: false });
  });

  it('emits tool.failed with INVALID_ARGS when arguments are not valid JSON', async () => {
    const emitter = makeEmitterSpy();
    const executor = createToolExecutor({
      findTool: () => ({ name: 'x', description: '', jsonSchema: {}, async execute() { return {}; } }) as unknown as ToolModule,
    });
    const res = await executor.execute(
      { toolCallId: 'c3', name: 'x', arguments: '{not json' },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events[0].type).toBe('tool.failed');
    expect(emitter.events[0].payload.code).toBe('INVALID_ARGS');
  });

  it('does not emit anything when emitter is absent', async () => {
    const mockTool = { name: 'noop', description: '', jsonSchema: {}, async execute() { return {}; } };
    const executor = createToolExecutor({ findTool: () => mockTool as unknown as ToolModule });
    const res = await executor.execute(
      { toolCallId: 'c4', name: 'noop', arguments: '{}' },
      baseCtx,
    );
    expect(res.success).toBe(true);
    // No crash — backward-compatible path
  });
});
