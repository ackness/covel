/**
 * Approval pipeline — extras beyond `approval-pipeline.test.ts`.
 *
 *  - rule-list ordering: first match wins (deny before allow swap)
 *  - exact tool-name rules apply regardless of source category
 *  - `deny` action surfaces `needsApproval: true, reason: 'rule-deny'`
 *    (different from `ask` in semantics — UI must distinguish)
 */

import { describe, it, expect } from "vitest";
import type { ApprovalRequest } from "@covel/shared";
import { createApprovalPipeline } from "../src/approval-pipeline.js";

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
    const pipeline = createApprovalPipeline(undefined, [
      { pattern: "covel_dangerous_tool", action: "deny" },
      { pattern: "local:*", action: "allow" },
    ]);
    const result = pipeline.check(
      makeRequest({ toolName: "covel_dangerous_tool" }),
      "local",
    );
    expect(result.needsApproval).toBe(true);
    expect(result.reason).toBe("rule-deny");
  });

  it("first match wins — earlier allow shields a later deny", () => {
    const pipeline = createApprovalPipeline(undefined, [
      { pattern: "covel_safe_tool", action: "allow" },
      { pattern: "local:*", action: "deny" },
    ]);
    const result = pipeline.check(
      makeRequest({ toolName: "covel_safe_tool" }),
      "local",
    );
    expect(result.needsApproval).toBe(false);
    expect(result.autoDecision).toBe("allow");
    expect(result.reason).toBe("rule-allow");
  });

  it("deny vs ask are surfaced distinctly so the UI can tell prompts from blocks", () => {
    const askPipeline = createApprovalPipeline(undefined, [
      { pattern: "third-party:*", action: "ask" },
    ]);
    const denyPipeline = createApprovalPipeline(undefined, [
      { pattern: "third-party:*", action: "deny" },
    ]);

    const askRes = askPipeline.check(makeRequest(), "third-party");
    const denyRes = denyPipeline.check(makeRequest(), "third-party");

    expect(askRes).toEqual({ needsApproval: true, reason: "rule-ask" });
    expect(denyRes).toEqual({ needsApproval: true, reason: "rule-deny" });
  });
});

describe("approval rule wildcards vs exact match", () => {
  it("exact match still works when a permissive wildcard sits below it", () => {
    const pipeline = createApprovalPipeline(undefined, [
      { pattern: "covel_special_tool", action: "ask" },
      { pattern: "local:*", action: "allow" },
    ]);
    expect(
      pipeline.check(makeRequest({ toolName: "covel_special_tool" }), "local"),
    ).toEqual({ needsApproval: true, reason: "rule-ask" });
    // A different tool flows through the wildcard.
    expect(
      pipeline.check(makeRequest({ toolName: "covel_normal_tool" }), "local"),
    ).toEqual({
      needsApproval: false,
      autoDecision: "allow",
      reason: "rule-allow",
    });
  });

  it("source category mismatch causes wildcard rules to be skipped over", () => {
    // builtin:* must NEVER fire for a third-party request, even if the
    // exact-name rule is missing — falls through to default-allow.
    const pipeline = createApprovalPipeline(undefined, [
      { pattern: "builtin:*", action: "allow" },
    ]);
    const result = pipeline.check(makeRequest(), "third-party");
    expect(result.reason).toBe("default-allow-all");
  });
});
