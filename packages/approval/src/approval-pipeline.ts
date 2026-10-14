/**
 * Static tool policy — checks resolved tool calls against permission rules.
 *
 * The host allows framework tools (`builtin`) and registered plugin tools
 * (`local`). Community server-code and runtime authorization happens before
 * plugin tools become callable; it is separate from this source policy.
 */

import type { ApprovalRequest } from "@covel/shared";

export interface ApprovalCheckResult {
  readonly decision: "allow" | "deny";
  readonly reason: string;
}

export interface PermissionRule {
  /** Pattern: 'builtin:*', 'local:*', or specific tool name. */
  readonly pattern: string;
  readonly action: "allow" | "deny";
}

export interface ApprovalPipeline {
  /** Resolve the policy decision for a tool call. */
  check(
    request: ApprovalRequest,
    toolSource?: "builtin" | "local",
  ): ApprovalCheckResult;
}

/** Source-category wildcards supported by permission rules. */
const SOURCE_WILDCARDS: ReadonlyMap<string, "builtin" | "local"> = new Map([
  ["builtin:*", "builtin"],
  ["local:*", "local"],
]);

/**
 * Match a tool name against a permission pattern.
 * Supports: exact match, 'builtin:*', 'local:*'.
 * Returns the first matching rule, or undefined.
 */
export function matchPermissionRule(
  toolName: string,
  toolSource: "builtin" | "local",
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
 * @param rules - Optional permission rules (e.g., `[{ pattern: 'delete-record', action: 'deny' }]`). Defaults to allow-all.
 * @returns An `ApprovalPipeline` with a `check` method.
 *
 * @example
 * ```typescript
 * import { createApprovalPipeline } from '@covel/approval';
 *
 * // Default: allow everything
 * const pipeline = createApprovalPipeline();
 * const result = pipeline.check({ toolName: 'get-weather', sessionId: 's1', turnId: 't1' });
 * // => { decision: 'allow', reason: 'default-allow-all' }
 *
 * // With rules: deny one tool before allowing the other local tools
 * const gated = createApprovalPipeline([
 *   { pattern: 'delete-record', action: 'deny' },
 *   { pattern: 'local:*', action: 'allow' },
 * ]);
 * ```
 */
export function createApprovalPipeline(
  rules?: readonly PermissionRule[],
): ApprovalPipeline {
  for (const rule of rules ?? []) {
    const action: unknown = (rule as { readonly action?: unknown }).action;
    if (action !== "allow" && action !== "deny") {
      throw new Error(
        `Approval action ${JSON.stringify(action)} is not supported. Static tool rules accept only "allow" or "deny".`,
      );
    }
  }

  function check(
    request: ApprovalRequest,
    toolSource?: "builtin" | "local",
  ): ApprovalCheckResult {
    // No custom rules → default allow-all.
    if (rules === undefined || rules.length === 0) {
      return {
        decision: "allow",
        reason: "default-allow-all",
      };
    }

    const source = toolSource ?? "local";
    const matched = matchPermissionRule(request.toolName, source, rules);

    if (matched === undefined) {
      // No rule matched — default allow.
      return {
        decision: "allow",
        reason: "default-allow-all",
      };
    }

    switch (matched.action) {
      case "allow":
        return {
          decision: "allow",
          reason: "rule-allow",
        };
      case "deny":
        return { decision: "deny", reason: "rule-deny" };
    }
  }

  return { check };
}

/** The host's tool-source policy, shared by production and isolated runtime tests. */
export const DEFAULT_TOOL_APPROVAL_RULES: readonly PermissionRule[] = [
  { pattern: "builtin:*", action: "allow" },
  { pattern: "local:*", action: "allow" },
];

export function createDefaultToolApprovalPipeline(): ApprovalPipeline {
  return createApprovalPipeline(DEFAULT_TOOL_APPROVAL_RULES);
}
