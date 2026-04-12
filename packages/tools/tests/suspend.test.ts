/**
 * Tests for the suspend builtin tool (S4-T4).
 */

import { describe, it, expect } from 'vitest';
import { suspendTool, isSuspendSentinel } from '../src/builtin/suspend.js';
import type { SuspendSentinel } from '../src/builtin/suspend.js';

describe('suspendTool', () => {
  it('should have the correct name', () => {
    expect(suspendTool.name).toBe('suspend');
  });

  it('execute() should return the sentinel shape', async () => {
    const params = {
      reason: 'Need player name',
      resumeSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    };
    // The tool module execute is called via the ToolModule interface
    const result = await suspendTool.execute(params, {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      pluginId: 'test-plugin',
      runtimeId: 'test-runtime',
    });

    expect(result).toMatchObject({
      _covelSuspend: true,
      reason: 'Need player name',
      resumeSchema: params.resumeSchema,
    });
  });

  it('execute() sentinel passes isSuspendSentinel type guard', async () => {
    const result = await suspendTool.execute(
      { reason: 'test reason', resumeSchema: { type: 'object' } },
      { sessionId: 'sess-1', turnId: 'turn-1', pluginId: 'p', runtimeId: 'r' },
    );
    expect(isSuspendSentinel(result)).toBe(true);
  });
});

describe('isSuspendSentinel', () => {
  it('returns true for a valid sentinel', () => {
    const sentinel: SuspendSentinel = {
      _covelSuspend: true,
      reason: 'test',
      resumeSchema: { type: 'object' },
    };
    expect(isSuspendSentinel(sentinel)).toBe(true);
  });

  it('returns false for a regular object', () => {
    expect(isSuspendSentinel({ foo: 'bar' })).toBe(false);
  });

  it('returns false for null', () => {
    expect(isSuspendSentinel(null)).toBe(false);
  });

  it('returns false for string', () => {
    expect(isSuspendSentinel('suspend')).toBe(false);
  });

  it('returns false when _covelSuspend is not true', () => {
    expect(isSuspendSentinel({ _covelSuspend: false, reason: 'x', resumeSchema: {} })).toBe(false);
  });

  it('returns false when reason is missing', () => {
    expect(isSuspendSentinel({ _covelSuspend: true, resumeSchema: {} })).toBe(false);
  });

  it('returns false when reason is not a string', () => {
    expect(isSuspendSentinel({ _covelSuspend: true, reason: 42, resumeSchema: {} })).toBe(false);
  });
});
