import { describe, expect, it, vi } from "vitest";
import {
  COMMUNITY_SERVER_CODE_ACTION,
  createRpcApprovalGate,
  type EvaluateInput,
  type PolicyDecisionResult,
} from "../src/index.js";

const input = (overrides: Partial<EvaluateInput> = {}): EvaluateInput => ({
  sessionId: "sess-1",
  sessionScope: "inc-1",
  pluginId: "plugin-a",
  action: COMMUNITY_SERVER_CODE_ACTION,
  payload: {},
  trustLevel: "community",
  ...overrides,
});

describe("RpcApprovalGate policy pre-check and plugin revocation", () => {
  it("short-circuits with denied when L1-L3 policy denies even if L4 session cache exists", () => {
    let policy: PolicyDecisionResult = { decision: "ask" };
    const gate = createRpcApprovalGate({
      policyDecision: () => policy,
    });

    const pending = gate.evaluate(input());
    expect(pending.status).toBe("pending");
    if (pending.status !== "pending") return;

    expect(
      gate.decide(
        {
          approvalId: pending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        "inc-1",
      ).ok,
    ).toBe(true);
    expect(gate.evaluate(input())).toEqual({
      status: "allow",
      reason: "session-cached",
    });
    expect(
      gate.hasGrant(
        "sess-1",
        "plugin-a",
        COMMUNITY_SERVER_CODE_ACTION,
        "inc-1",
      ),
    ).toBe(true);

    policy = {
      decision: "deny",
      reason: "policy",
      capability: "plugin.communityCode",
    };
    expect(gate.evaluate(input())).toEqual({
      status: "denied",
      reason: "policy",
      capability: "plugin.communityCode",
    });
    expect(
      gate.hasGrant(
        "sess-1",
        "plugin-a",
        COMMUNITY_SERVER_CODE_ACTION,
        "inc-1",
      ),
    ).toBe(false);
    expect(gate.listPending("sess-1", "inc-1")).toEqual([]);
  });

  it("allows through evaluate and hasGrant when policy returns persistent-grant", () => {
    const gate = createRpcApprovalGate({
      policyDecision: (query) =>
        query.action === COMMUNITY_SERVER_CODE_ACTION
          ? { decision: "allow", reason: "persistent-grant" }
          : { decision: "ask" },
    });

    expect(gate.evaluate(input())).toEqual({
      status: "allow",
      reason: "persistent-grant",
    });
    expect(
      gate.hasGrant(
        "sess-1",
        "plugin-a",
        COMMUNITY_SERVER_CODE_ACTION,
        "inc-1",
      ),
    ).toBe(true);
    expect(gate.evaluate(input({ action: "custom-action" })).status).toBe(
      "pending",
    );
  });

  it("fails safe to ask and logs throttled warnings if policyDecision throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const gate = createRpcApprovalGate({
        policyDecision: () => {
          throw new Error("boom");
        },
      });
      expect(gate.evaluate(input()).status).toBe("pending");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("lists matching session grants and revokes a plugin across all sessions", () => {
    const gate = createRpcApprovalGate();
    const allowForSession = (
      sessionId: string,
      sessionScope: string,
      pluginId: string,
      action: string,
    ) => {
      const res = gate.evaluate(
        input({ sessionId, sessionScope, pluginId, action }),
      );
      if (res.status !== "pending") throw new Error("expected pending");
      gate.decide(
        {
          approvalId: res.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        sessionScope,
      );
    };

    allowForSession("s1", "inc-a", "beta", "act-2");
    allowForSession("s1", "inc-a", "alpha", "act-1");
    allowForSession("s1", "stale-inc", "alpha", "stale-act");
    allowForSession("s2", "inc-b", "alpha", "act-1");
    gate.evaluate(
      input({
        sessionId: "s3",
        sessionScope: "inc-c",
        pluginId: "alpha",
        action: "pending-act",
      }),
    );

    expect(gate.listSessionGrants("s1", () => "inc-a")).toEqual([
      { pluginId: "alpha", action: "act-1" },
      { pluginId: "beta", action: "act-2" },
    ]);

    // Clearing plugin alpha removes s1 (both scopes), s2 session cache, and s3 pending.
    expect(gate.revokePlugin("alpha")).toBe(4);
    expect(gate.listSessionGrants("s1", () => "inc-a")).toEqual([
      { pluginId: "beta", action: "act-2" },
    ]);
    expect(gate.listSessionGrants("s2", () => "inc-b")).toEqual([]);
    expect(gate.listPending("s3", "inc-c")).toEqual([]);
  });
});
