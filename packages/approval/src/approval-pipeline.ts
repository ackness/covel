/**
 * Approval pipeline — checks tool calls against permission rules.
 * Current implementation: default-allow-all (skeleton for future third-party tool approval).
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalRecord } from '@covel/shared';
import type { DataStore, ApprovalRecord as StoreApprovalRecord } from '@covel/store';

export interface ApprovalCheckResult {
  readonly needsApproval: boolean;
  readonly autoDecision?: 'allow';
  readonly reason: string;
}

export interface PermissionRule {
  /** Pattern: 'builtin:*', 'local:*', 'third-party:*', or specific tool name. */
  readonly pattern: string;
  readonly action: 'allow' | 'deny' | 'ask';
}

export interface ApprovalPipeline {
  /** Check if a tool call needs approval. */
  check(request: ApprovalRequest, toolSource?: 'builtin' | 'local' | 'third-party'): ApprovalCheckResult;
  /** Get all session approval records. */
  getSessionApprovals(sessionId: string): readonly ApprovalRecord[];
  /** Record an approval decision. */
  recordDecision(record: ApprovalRecord): void;
  /** Check if a tool has a session-level allow decision. */
  hasSessionAllow(sessionId: string, toolName: string): boolean;
}

/** Source-category wildcards supported by permission rules. */
const SOURCE_WILDCARDS: ReadonlyMap<string, 'builtin' | 'local' | 'third-party'> = new Map([
  ['builtin:*', 'builtin'],
  ['local:*', 'local'],
  ['third-party:*', 'third-party'],
]);

/**
 * Match a tool name against a permission pattern.
 * Supports: exact match, 'builtin:*', 'local:*', 'third-party:*'.
 * Returns the first matching rule, or undefined.
 */
export function matchPermissionRule(
  toolName: string,
  toolSource: 'builtin' | 'local' | 'third-party',
  rules: readonly PermissionRule[],
): PermissionRule | undefined {
  for (const rule of rules) {
    const wildcardSource = SOURCE_WILDCARDS.get(rule.pattern);
    if (wildcardSource !== undefined) {
      if (wildcardSource === toolSource) {
        return rule;
      }
      continue;
    }
    // Exact tool-name match (source-agnostic).
    if (rule.pattern === toolName) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Convert a shared ApprovalRecord to a store ApprovalRecord.
 */
function toStoreApproval(record: ApprovalRecord): StoreApprovalRecord {
  return {
    id: record.approvalId,
    sessionId: record.sessionId,
    toolName: record.toolName,
    decision: record.decision,
    turnId: record.turnId,
    createdAt: record.decidedAt,
  };
}

/**
 * Create an approval pipeline.
 * When no custom rules are provided, all tool calls are auto-approved (default-allow-all).
 * When custom rules are provided, each tool call is matched against the rules.
 *
 * @param store - Optional DataStore for persisting approval decisions.
 * @param rules - Optional permission rules. Default: allow-all.
 */
export function createApprovalPipeline(store?: DataStore, rules?: readonly PermissionRule[]): ApprovalPipeline {
  // In-memory cache — always maintained for fast lookups
  const sessionRecords = new Map<string, ApprovalRecord[]>();

  function check(
    request: ApprovalRequest,
    toolSource?: 'builtin' | 'local' | 'third-party',
  ): ApprovalCheckResult {
    // No custom rules → default allow-all.
    if (rules === undefined || rules.length === 0) {
      return { needsApproval: false, autoDecision: 'allow', reason: 'default-allow-all' };
    }

    const source = toolSource ?? 'local';
    const matched = matchPermissionRule(request.toolName, source, rules);

    if (matched === undefined) {
      // No rule matched — default allow.
      return { needsApproval: false, autoDecision: 'allow', reason: 'default-allow-all' };
    }

    switch (matched.action) {
      case 'allow':
        return { needsApproval: false, autoDecision: 'allow', reason: 'rule-allow' };
      case 'ask':
        return { needsApproval: true, reason: 'rule-ask' };
      case 'deny':
        return { needsApproval: true, reason: 'rule-deny' };
    }
  }

  function getSessionApprovals(sessionId: string): readonly ApprovalRecord[] {
    return sessionRecords.get(sessionId) ?? [];
  }

  function recordDecision(record: ApprovalRecord): void {
    const existing = sessionRecords.get(record.sessionId);
    if (existing !== undefined) {
      sessionRecords.set(record.sessionId, [...existing, record]);
    } else {
      sessionRecords.set(record.sessionId, [record]);
    }

    // Persist to store (fire-and-forget to keep sync API)
    if (store) {
      void store.saveApproval(toStoreApproval(record));
    }
  }

  function hasSessionAllow(sessionId: string, toolName: string): boolean {
    const records = sessionRecords.get(sessionId);
    if (records === undefined) {
      return false;
    }
    return records.some(
      (r) => r.toolName === toolName && r.decision === 'allow-session',
    );
  }

  return { check, getSessionApprovals, recordDecision, hasSessionAllow };
}
