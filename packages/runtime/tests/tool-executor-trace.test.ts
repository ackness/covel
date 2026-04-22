/**
 * ToolExecutor trace emission tests — covers tool.calling / tool.completed /
 * tool.failed across the 5 branches (success, NOT_FOUND, DENIED, INVALID_ARGS,
 * VALIDATION_ERROR via Zod, and the emitter-absent backward-compatible path).
 */

import { describe, it, expect } from 'vitest';
import { ZodError, z } from 'zod';
import { createToolExecutor } from '../src/tool-executor.js';
import type { ToolCallContext } from '../src/tool-executor.js';
import { ToolValidationError } from '@covel/tools';
import type { ToolModule } from '@covel/tools';
import type { ApprovalPipeline } from '@covel/approval';
import { makeEmitterSpy } from './_helpers/emitter-spy.js';

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

  it('emits tool.failed with DENIED when approval denies the call', async () => {
    const emitter = makeEmitterSpy();
    const mockTool = { name: 'dangerous', description: '', jsonSchema: {}, async execute() { return {}; } };
    const approval: ApprovalPipeline = {
      check: () => ({ needsApproval: true, reason: 'explicit deny' }),
      hasSessionAllow: () => false,
      getSessionApprovals: () => [],
      recordDecision: () => undefined,
    };
    const executor = createToolExecutor({
      findTool: () => mockTool as unknown as ToolModule,
      approval,
    });

    const res = await executor.execute(
      { toolCallId: 'c5', name: 'dangerous', arguments: '{}' },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events).toHaveLength(1);
    expect(emitter.events[0].type).toBe('tool.failed');
    expect(emitter.events[0].payload).toMatchObject({
      code: 'DENIED',
      error: 'explicit deny',
      approvalStatus: 'user-denied',
      success: false,
    });
  });

  it('emits tool.calling/completed with approvalStatus=user-allowed when session already allowed', async () => {
    const emitter = makeEmitterSpy();
    const mockTool = {
      name: 'sensitive',
      description: '',
      jsonSchema: {},
      async execute() { return { ok: true }; },
    };
    const approval: ApprovalPipeline = {
      // needsApproval=true, but hasSessionAllow returns true → tool proceeds
      // with approvalStatus='user-allowed' (not 'user-denied').
      check: () => ({ needsApproval: true, reason: 'sensitive action' }),
      hasSessionAllow: () => true,
      getSessionApprovals: () => [],
      recordDecision: () => undefined,
    };
    const executor = createToolExecutor({
      findTool: () => mockTool as unknown as ToolModule,
      approval,
    });

    const res = await executor.execute(
      { toolCallId: 'c-allow', name: 'sensitive', arguments: '{}' },
      { ...baseCtx, emitter },
    );

    expect(res.success).toBe(true);
    expect(res.approvalStatus).toBe('user-allowed');
    expect(emitter.events.map(e => e.type)).toEqual(['tool.calling', 'tool.completed']);
    expect(emitter.events[0].payload).toMatchObject({
      toolName: 'sensitive',
      approvalStatus: 'user-allowed',
    });
    expect(emitter.events[1].payload).toMatchObject({
      toolName: 'sensitive',
      success: true,
      approvalStatus: 'user-allowed',
    });
  });

  it('emits tool.failed with VALIDATION_ERROR and details (dedup exercised)', async () => {
    const emitter = makeEmitterSpy();
    // Build a ZodError whose issues include two entries on the same path
    // so the dedup logic in tool-executor collapses them into one detail.
    const schema = z.object({ name: z.string() });
    let zodError: ZodError;
    try {
      schema.parse({ name: 123 });
      throw new Error('schema should have rejected');
    } catch (err) {
      if (err instanceof ZodError) {
        zodError = err;
      } else {
        throw err;
      }
    }
    // Duplicate the first issue to exercise dedup (same path, different message).
    const issues = (zodError! as unknown as { issues: Array<{ path: (string | number)[]; message: string; code?: string }> }).issues;
    issues.push({ ...issues[0], message: 'phantom duplicate on same path' });
    // Add a second distinct path so we end up with 2 deduped details total.
    issues.push({ path: ['age'], message: 'age is required', code: issues[0].code });
    const validationError = new ToolValidationError(zodError!);

    const throwingTool = {
      name: 'vx',
      description: '',
      jsonSchema: {},
      async execute() { throw validationError; },
    };
    const executor = createToolExecutor({
      findTool: () => throwingTool as unknown as ToolModule,
    });

    const res = await executor.execute(
      { toolCallId: 'c6', name: 'vx', arguments: '{"name":123}' },
      { ...baseCtx, emitter },
    );
    expect(res.success).toBe(false);
    expect(emitter.events.map(e => e.type)).toEqual(['tool.calling', 'tool.failed']);
    const failPayload = emitter.events[1].payload;
    expect(failPayload.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(failPayload.details)).toBe(true);
    // Dedup means only 2 unique paths survive (name + age), not 3 raw issues.
    expect((failPayload.details as string[]).length).toBe(2);
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
