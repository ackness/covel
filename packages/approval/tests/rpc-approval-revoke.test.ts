import { describe, expect, it } from "vitest";
import {
  createRpcApprovalGate,
  type RpcApprovalGate,
} from "../src/rpc-approval.js";

function grantSession(
  gate: RpcApprovalGate,
  sessionId: string,
  pluginId: string,
  action = "a",
): void {
  const r = gate.evaluate({
    sessionId,
    pluginId,
    action,
    payload: null,
    trustLevel: "community",
  });
  if (r.status !== "pending") throw new Error("expected pending");
  gate.decide({
    approvalId: r.approvalId,
    decision: "allow",
    scope: "session",
    decidedAt: new Date().toISOString(),
  });
}

function isAllowed(
  gate: RpcApprovalGate,
  sessionId: string,
  pluginId: string,
  action = "a",
): boolean {
  return (
    gate.evaluate({
      sessionId,
      pluginId,
      action,
      payload: null,
      trustLevel: "community",
    }).status === "allow"
  );
}

describe("gate.revoke (PR-7 — withdraw community grants mid-session)", () => {
  it("clears a session-cached grant so the next call re-prompts", () => {
    const gate = createRpcApprovalGate();
    grantSession(gate, "sess-1", "p");
    expect(isAllowed(gate, "sess-1", "p")).toBe(true);

    expect(gate.revoke("sess-1", "p")).toBe(1);

    expect(isAllowed(gate, "sess-1", "p")).toBe(false);
  });

  it("without pluginId clears every grant for that session only", () => {
    const gate = createRpcApprovalGate();
    grantSession(gate, "sess-1", "p1");
    grantSession(gate, "sess-1", "p2");
    grantSession(gate, "sess-2", "p1");

    expect(gate.revoke("sess-1")).toBe(2);

    expect(isAllowed(gate, "sess-1", "p1")).toBe(false);
    expect(isAllowed(gate, "sess-1", "p2")).toBe(false);
    // A different session keeps its grant.
    expect(isAllowed(gate, "sess-2", "p1")).toBe(true);
  });

  it("scoped to one plugin leaves the session's other grants intact", () => {
    const gate = createRpcApprovalGate();
    grantSession(gate, "sess-1", "p1");
    grantSession(gate, "sess-1", "p2");

    expect(gate.revoke("sess-1", "p1")).toBe(1);

    expect(isAllowed(gate, "sess-1", "p1")).toBe(false);
    expect(isAllowed(gate, "sess-1", "p2")).toBe(true);
  });

  it("returns 0 for a session with no grants", () => {
    const gate = createRpcApprovalGate();
    expect(gate.revoke("nope")).toBe(0);
  });
});
