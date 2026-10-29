import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRpcApprovalGate,
  COMMUNITY_SERVER_CODE_ACTION,
  type EvaluateInput,
} from "../src/rpc-approval.js";
const input = (action = COMMUNITY_SERVER_CODE_ACTION): EvaluateInput => ({
  sessionId: "session",
  sessionScope: "incarnation",
  pluginId: "probe",
  action,
  payload: {},
  trustLevel: "community",
});
afterEach(() => vi.restoreAllMocks());
describe("trusted-source implicit grants", () => {
  it.each([COMMUNITY_SERVER_CODE_ACTION, "runtime:probe/x"])(
    "allows %s through evaluate and hasGrant",
    (action) => {
      const predicate = vi.fn(() => true);
      const gate = createRpcApprovalGate({ implicitGrant: predicate });
      expect(gate.evaluate(input(action))).toEqual({
        status: "allow",
        reason: "trusted-source",
      });
      expect(gate.hasGrant("session", "probe", action, "incarnation")).toBe(
        true,
      );
      expect(predicate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session",
          pluginId: "probe",
          action,
        }),
      );
      expect(gate.listPending("session", "incarnation")).toEqual([]);
    },
  );
  it.each(["do-thing", "runtime", "event:topic"])(
    "never consults the predicate for %s",
    (action) => {
      const predicate = vi.fn(() => true);
      const gate = createRpcApprovalGate({ implicitGrant: predicate });
      expect(gate.evaluate(input(action)).status).toBe("pending");
      expect(gate.hasGrant("session", "probe", action, "incarnation")).toBe(
        false,
      );
      expect(predicate).not.toHaveBeenCalled();
    },
  );
  it("falls back to the normal queue and explicit session grants", () => {
    const gate = createRpcApprovalGate({ implicitGrant: () => false });
    const pending = gate.evaluate(input());
    if (pending.status !== "pending") throw new Error("Expected pending");
    expect(
      gate.decide(
        {
          approvalId: pending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        "incarnation",
      ).ok,
    ).toBe(true);
    expect(gate.evaluate(input())).toEqual({
      status: "allow",
      reason: "session-cached",
    });
    expect(
      gate.hasGrant(
        "session",
        "probe",
        COMMUNITY_SERVER_CODE_ACTION,
        "incarnation",
      ),
    ).toBe(true);
  });
  it("preserves queue limits with a false predicate", () => {
    const gate = createRpcApprovalGate({ implicitGrant: () => false });
    for (let i = 0; i < 64; i++)
      expect(gate.evaluate({ ...input(), pluginId: `probe-${i}` }).status).toBe(
        "pending",
      );
    expect(gate.evaluate({ ...input(), pluginId: "extra" })).toMatchObject({
      status: "rejected",
      reason: "queue-full",
    });
  });
  it("fails closed on exceptions and logs once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const gate = createRpcApprovalGate({
      implicitGrant: () => {
        throw new Error("broken");
      },
    });
    expect(gate.evaluate(input()).status).toBe("pending");
    expect(
      gate.hasGrant(
        "session",
        "probe",
        COMMUNITY_SERVER_CODE_ACTION,
        "incarnation",
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("keeps builtin short-circuit and cannot revoke source policy per session", () => {
    const predicate = vi.fn(() => true);
    const gate = createRpcApprovalGate({ implicitGrant: predicate });
    expect(gate.evaluate({ ...input(), trustLevel: "builtin" })).toEqual({
      status: "allow",
      reason: "trusted",
    });
    expect(predicate).not.toHaveBeenCalled();
    expect(gate.revoke("session", "probe")).toBe(0);
    expect(gate.evaluate(input())).toEqual({
      status: "allow",
      reason: "trusted-source",
    });
  });
});
