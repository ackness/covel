/**
 * Approval pipeline — checks tool calls against permission rules.
 *
 * Current rules (set in bootstrap.ts):
 *   - builtin:*     → allow (framework-owned tools)
 *   - local:*       → allow (plugin-declared tools from trusted sources)
 *   - third-party:* → deny  (community plugins, not yet implemented)
 *
 * When community plugin support is added, this pipeline gains the missing
 * decision-recording + session-allow persistence path (`hasSessionAllow` is a
 * stub until then).
 */

import type { ApprovalRequest } from "@covel/shared";
import type { DataStore } from "@covel/store";

export interface ApprovalCheckResult {
  readonly needsApproval: boolean;
  readonly autoDecision?: "allow";
  readonly reason: string;
}

export interface PermissionRule {
  /** Pattern: 'builtin:*', 'local:*', 'third-party:*', or specific tool name. */
  readonly pattern: string;
  readonly action: "allow" | "deny" | "ask";
}

export interface ApprovalPipeline {
  /** Check if a tool call needs approval. */
  check(
    request: ApprovalRequest,
    toolSource?: "builtin" | "local" | "third-party",
  ): ApprovalCheckResult;
  /** Check if a tool has a session-level allow decision for a specific plugin. */
  hasSessionAllow(
    sessionId: string,
    toolName: string,
    pluginId: string,
  ): boolean;
}

/** Source-category wildcards supported by permission rules. */
const SOURCE_WILDCARDS: ReadonlyMap<
  string,
  "builtin" | "local" | "third-party"
> = new Map([
  ["builtin:*", "builtin"],
  ["local:*", "local"],
  ["third-party:*", "third-party"],
]);

/**
 * Match a tool name against a permission pattern.
 * Supports: exact match, 'builtin:*', 'local:*', 'third-party:*'.
 * Returns the first matching rule, or undefined.
 */
export function matchPermissionRule(
  toolName: string,
  toolSource: "builtin" | "local" | "third-party",
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
 * Create an approval pipeline for gating tool calls against permission rules.
 *
 * When no custom rules are provided, all tool calls are auto-approved (default-allow-all).
 * When custom rules are provided, each tool call is matched against the rule list in order.
 *
 * @param _store - Reserved for the future decision-persistence path (community
 *   plugin approvals). Currently unused — accepted so callers need not change
 *   when persistence lands.
 * @param rules - Optional permission rules (e.g., `[{ pattern: 'third-party:*', action: 'ask' }]`). Defaults to allow-all.
 * @returns An `ApprovalPipeline` with `check` and `hasSessionAllow` methods.
 *
 * @example
 * ```typescript
 * import { createApprovalPipeline } from '@covel/approval';
 *
 * // Default: allow everything
 * const pipeline = createApprovalPipeline();
 * const result = pipeline.check({ toolName: 'get-weather', sessionId: 's1', turnId: 't1' });
 * // => { needsApproval: false, autoDecision: 'allow', reason: 'default-allow-all' }
 *
 * // With rules: require approval for third-party tools
 * const gated = createApprovalPipeline(store, [
 *   { pattern: 'builtin:*', action: 'allow' },
 *   { pattern: 'third-party:*', action: 'ask' },
 * ]);
 * ```
 */
export function createApprovalPipeline(
  _store?: DataStore,
  rules?: readonly PermissionRule[],
): ApprovalPipeline {
  function check(
    request: ApprovalRequest,
    toolSource?: "builtin" | "local" | "third-party",
  ): ApprovalCheckResult {
    // No custom rules → default allow-all.
    if (rules === undefined || rules.length === 0) {
      return {
        needsApproval: false,
        autoDecision: "allow",
        reason: "default-allow-all",
      };
    }

    const source = toolSource ?? "local";
    const matched = matchPermissionRule(request.toolName, source, rules);

    if (matched === undefined) {
      // No rule matched — default allow.
      return {
        needsApproval: false,
        autoDecision: "allow",
        reason: "default-allow-all",
      };
    }

    switch (matched.action) {
      case "allow":
        return {
          needsApproval: false,
          autoDecision: "allow",
          reason: "rule-allow",
        };
      case "ask":
        return { needsApproval: true, reason: "rule-ask" };
      case "deny":
        return { needsApproval: true, reason: "rule-deny" };
    }
  }

  // Community-plugin session approvals aren't wired to persistence yet, so
  // there is never a recorded prior allow-session. Stub returns false until
  // that decision-recording flow lands.
  function hasSessionAllow(): boolean {
    return false;
  }

  return { check, hasSessionAllow };
}
