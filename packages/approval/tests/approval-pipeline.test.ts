import { describe, it, expect, beforeEach } from "vitest";
import type { ApprovalRequest } from "@covel/shared";
import {
  DEFAULT_TOOL_APPROVAL_RULES,
  matchPermissionRule,
  createApprovalPipeline,
  createDefaultToolApprovalPipeline,
} from "../src/approval-pipeline.js";
import type {
  PermissionRule,
  ApprovalPipeline,
} from "../src/approval-pipeline.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeRequest(overrides?: Partial<ApprovalRequest>): ApprovalRequest {
  return {
    toolName: "covel_test_rt_my_tool",
    pluginId: "test",
    runtimeId: "rt",
    input: {},
    turnId: "turn-1",
    sessionId: "sess-1",
    ...overrides,
  };
}

// ── matchPermissionRule ──────────────────────────────────────────────────────

describe("matchPermissionRule", () => {
  it("exact match — rule pattern matches tool name", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "covel_my_tool", action: "allow" },
    ];
    const result = matchPermissionRule("covel_my_tool", "local", rules);
    expect(result).toEqual({ pattern: "covel_my_tool", action: "allow" });
  });

  it("builtin wildcard — builtin:* matches builtin source", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "builtin:*", action: "allow" },
    ];
    const result = matchPermissionRule("covel_some_tool", "builtin", rules);
    expect(result).toEqual({ pattern: "builtin:*", action: "allow" });
  });

  it("local wildcard — local:* matches local source", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "local:*", action: "allow" },
    ];
    const result = matchPermissionRule("covel_some_tool", "local", rules);
    expect(result).toEqual({ pattern: "local:*", action: "allow" });
  });

  it("no match — builtin:* does not match local source", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "builtin:*", action: "allow" },
    ];
    const result = matchPermissionRule("covel_some_tool", "local", rules);
    expect(result).toBeUndefined();
  });

  it("first matching rule wins", () => {
    const rules: readonly PermissionRule[] = [
      { pattern: "local:*", action: "deny" },
      { pattern: "local:*", action: "allow" },
      { pattern: "covel_my_tool", action: "deny" },
    ];
    const result = matchPermissionRule("covel_my_tool", "local", rules);
    expect(result).toEqual({ pattern: "local:*", action: "deny" });
  });
});

it("the default policy contains only categories the host registry produces", () => {
  expect(DEFAULT_TOOL_APPROVAL_RULES).toEqual([
    { pattern: "builtin:*", action: "allow" },
    { pattern: "local:*", action: "allow" },
  ]);
});

it("uses the same source policy for host and isolated tool execution", () => {
  const pipeline = createDefaultToolApprovalPipeline();
  expect(pipeline.check(makeRequest(), "builtin").decision).toBe("allow");
  expect(pipeline.check(makeRequest(), "local").decision).toBe("allow");
});

// ── createApprovalPipeline ───────────────────────────────────────────────────

describe("createApprovalPipeline", () => {
  describe("default behavior (no custom rules)", () => {
    let pipeline: ApprovalPipeline;

    beforeEach(() => {
      pipeline = createApprovalPipeline();
    });

    it("check: default allow-all", () => {
      const result = pipeline.check(makeRequest());
      expect(result).toEqual({
        decision: "allow",
        reason: "default-allow-all",
      });
    });
  });

  describe("with custom rules", () => {
    it("rejects unsupported ask rules during configuration", () => {
      expect(() =>
        createApprovalPipeline([
          { pattern: "local:*", action: "ask" },
        ] as unknown as readonly PermissionRule[]),
      ).toThrow(/ask.*not supported/i);
    });

    it("check: builtin allowed — no approval needed", () => {
      const pipeline = createApprovalPipeline([
        { pattern: "builtin:*", action: "allow" },
        { pattern: "local:*", action: "deny" },
      ]);
      const result = pipeline.check(makeRequest(), "builtin");
      expect(result).toEqual({
        decision: "allow",
        reason: "rule-allow",
      });
    });

    it("check: local denied — execution is blocked", () => {
      const pipeline = createApprovalPipeline([
        { pattern: "builtin:*", action: "allow" },
        { pattern: "local:*", action: "deny" },
      ]);
      const result = pipeline.check(makeRequest(), "local");
      expect(result).toEqual({
        decision: "deny",
        reason: "rule-deny",
      });
    });
  });
});
