/**
 * Approval pipeline — extras beyond `approval-pipeline.test.ts`.
 *
 *  - rule-list ordering: first match wins (deny before allow swap)
 *  - exact tool-name rules apply regardless of source category
 *  - `deny` action returns an explicit policy decision
 */

import { describe, it, expect } from "vitest";
import type { ApprovalRequest } from "@covel/shared";
import { createApprovalPipeline } from "../src/approval-pipeline.js";
import type { PermissionRule } from "../src/approval-pipeline.js";

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolName: "covel_test_tool",
    pluginId: "plug",
    runtimeId: "rt",
    input: {},
    turnId: "t1",
    sessionId: "s1",
    ...overrides,
  };
}

describe("approval rule ordering", () => {
  it("first match wins — earlier deny suppresses later allow", () => {
    // Auditors often add a tighter rule above a permissive one. Order matters.
    const pipeline = createApprovalPipeline([
      { pattern: "covel_dangerous_tool", action: "deny" },
      { pattern: "local:*", action: "allow" },
    ]);
    const result = pipeline.check(
      makeRequest({ toolName: "covel_dangerous_tool" }),
      "local",
    );
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("rule-deny");
  });

  it("first match wins — earlier allow shields a later deny", () => {
    const pipeline = createApprovalPipeline([
      { pattern: "covel_safe_tool", action: "allow" },
      { pattern: "local:*", action: "deny" },
    ]);
    const result = pipeline.check(
      makeRequest({ toolName: "covel_safe_tool" }),
      "local",
    );
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("rule-allow");
  });

  it("unsupported actions fail closed during configuration", () => {
    const denyPipeline = createApprovalPipeline([
      { pattern: "third-party:*", action: "deny" },
    ]);

    const denyRes = denyPipeline.check(makeRequest(), "third-party");

    expect(denyRes).toEqual({ decision: "deny", reason: "rule-deny" });
    expect(() =>
      createApprovalPipeline([
        { pattern: "third-party:*", action: "prompt" },
      ] as unknown as readonly PermissionRule[]),
    ).toThrow(/not supported/i);
  });
});

describe("approval rule wildcards vs exact match", () => {
  it("exact match still works when a permissive wildcard sits below it", () => {
    const pipeline = createApprovalPipeline([
      { pattern: "covel_special_tool", action: "deny" },
      { pattern: "local:*", action: "allow" },
    ]);
    expect(
      pipeline.check(makeRequest({ toolName: "covel_special_tool" }), "local"),
    ).toEqual({ decision: "deny", reason: "rule-deny" });
    // A different tool flows through the wildcard.
    expect(
      pipeline.check(makeRequest({ toolName: "covel_normal_tool" }), "local"),
    ).toEqual({
      decision: "allow",
      reason: "rule-allow",
    });
  });

  it("source category mismatch causes wildcard rules to be skipped over", () => {
    // builtin:* must NEVER fire for a third-party request, even if the
    // exact-name rule is missing — falls through to default-allow.
    const pipeline = createApprovalPipeline([
      { pattern: "builtin:*", action: "allow" },
    ]);
    const result = pipeline.check(makeRequest(), "third-party");
    expect(result.reason).toBe("default-allow-all");
  });
});
