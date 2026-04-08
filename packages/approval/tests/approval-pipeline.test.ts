import { describe, it, expect, beforeEach } from 'vitest';
import type { ApprovalRequest, ApprovalRecord } from '@covel/shared';
import {
  matchPermissionRule,
  createApprovalPipeline,
} from '../src/approval-pipeline.js';
import type { PermissionRule, ApprovalPipeline } from '../src/approval-pipeline.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolName: 'covel_test_rt_my_tool',
    pluginId: 'test',
    runtimeId: 'rt',
    input: {},
    turnId: 'turn-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<ApprovalRecord>): ApprovalRecord {
  return {
    approvalId: 'apr-1',
    toolName: 'covel_test_rt_my_tool',
    decision: 'allow-session',
    decidedAt: new Date().toISOString(),
    turnId: 'turn-1',
    sessionId: 'sess-1',
    ...overrides,
  };
}

// ── matchPermissionRule ──────────────────────────────────────────────────────

describe('matchPermissionRule', () => {
  it('exact match — rule pattern matches tool name', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'covel_my_tool', action: 'allow' },
    ];
    const result = matchPermissionRule('covel_my_tool', 'local', rules);
    expect(result).toEqual({ pattern: 'covel_my_tool', action: 'allow' });
  });

  it('builtin wildcard — builtin:* matches builtin source', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'builtin:*', action: 'allow' },
    ];
    const result = matchPermissionRule('covel_some_tool', 'builtin', rules);
    expect(result).toEqual({ pattern: 'builtin:*', action: 'allow' });
  });

  it('local wildcard — local:* matches local source', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'local:*', action: 'allow' },
    ];
    const result = matchPermissionRule('covel_some_tool', 'local', rules);
    expect(result).toEqual({ pattern: 'local:*', action: 'allow' });
  });

  it('third-party wildcard — third-party:* matches third-party source', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'third-party:*', action: 'ask' },
    ];
    const result = matchPermissionRule('covel_some_tool', 'third-party', rules);
    expect(result).toEqual({ pattern: 'third-party:*', action: 'ask' });
  });

  it('no match — builtin:* does not match third-party source', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'builtin:*', action: 'allow' },
    ];
    const result = matchPermissionRule('covel_some_tool', 'third-party', rules);
    expect(result).toBeUndefined();
  });

  it('first matching rule wins', () => {
    const rules: readonly PermissionRule[] = [
      { pattern: 'local:*', action: 'deny' },
      { pattern: 'local:*', action: 'allow' },
      { pattern: 'covel_my_tool', action: 'ask' },
    ];
    const result = matchPermissionRule('covel_my_tool', 'local', rules);
    expect(result).toEqual({ pattern: 'local:*', action: 'deny' });
  });
});

// ── createApprovalPipeline ───────────────────────────────────────────────────

describe('createApprovalPipeline', () => {
  describe('default behavior (no custom rules)', () => {
    let pipeline: ApprovalPipeline;

    beforeEach(() => {
      pipeline = createApprovalPipeline();
    });

    it('check: default allow-all', () => {
      const result = pipeline.check(makeRequest());
      expect(result).toEqual({
        needsApproval: false,
        autoDecision: 'allow',
        reason: 'default-allow-all',
      });
    });
  });

  describe('with custom rules', () => {
    it('check: builtin allowed — no approval needed', () => {
      const pipeline = createApprovalPipeline(undefined, [
        { pattern: 'builtin:*', action: 'allow' },
        { pattern: 'third-party:*', action: 'ask' },
      ]);
      const result = pipeline.check(makeRequest(), 'builtin');
      expect(result).toEqual({
        needsApproval: false,
        autoDecision: 'allow',
        reason: 'rule-allow',
      });
    });

    it('check: third-party asks — needs approval', () => {
      const pipeline = createApprovalPipeline(undefined, [
        { pattern: 'builtin:*', action: 'allow' },
        { pattern: 'third-party:*', action: 'ask' },
      ]);
      const result = pipeline.check(makeRequest(), 'third-party');
      expect(result).toEqual({
        needsApproval: true,
        reason: 'rule-ask',
      });
    });
  });

  describe('recordDecision + getSessionApprovals', () => {
    let pipeline: ApprovalPipeline;

    beforeEach(() => {
      pipeline = createApprovalPipeline();
    });

    it('record and retrieve', () => {
      const record = makeRecord();
      pipeline.recordDecision(record);
      const approvals = pipeline.getSessionApprovals('sess-1');
      expect(approvals).toEqual([record]);
    });

    it('multiple sessions isolated', () => {
      pipeline.recordDecision(makeRecord({ sessionId: 'sess-1' }));
      pipeline.recordDecision(makeRecord({ sessionId: 'sess-2', approvalId: 'apr-2' }));

      const sess1 = pipeline.getSessionApprovals('sess-1');
      const sess2 = pipeline.getSessionApprovals('sess-2');

      expect(sess1).toHaveLength(1);
      expect(sess1[0].sessionId).toBe('sess-1');
      expect(sess2).toHaveLength(1);
      expect(sess2[0].sessionId).toBe('sess-2');
    });
  });

  describe('hasSessionAllow', () => {
    let pipeline: ApprovalPipeline;

    beforeEach(() => {
      pipeline = createApprovalPipeline();
    });

    it('has session allow — returns true after allow-session decision', () => {
      pipeline.recordDecision(makeRecord({ decision: 'allow-session' }));
      expect(pipeline.hasSessionAllow('sess-1', 'covel_test_rt_my_tool')).toBe(true);
    });

    it('no session allow — returns false when no record exists', () => {
      expect(pipeline.hasSessionAllow('sess-1', 'covel_test_rt_my_tool')).toBe(false);
    });

    it('allow-once does not count as session allow', () => {
      pipeline.recordDecision(makeRecord({ decision: 'allow-once' }));
      expect(pipeline.hasSessionAllow('sess-1', 'covel_test_rt_my_tool')).toBe(false);
    });
  });
});
