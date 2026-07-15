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

function grantOnce(
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
    scope: "once",
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
  it("reports a live grant without consuming one-time approval", () => {
    const gate = createRpcApprovalGate();
    grantOnce(gate, "sess-1", "p", "plugin:server-code");

    expect(gate.hasGrant("sess-1", "p")).toBe(true);
    expect(gate.hasGrant("sess-1", "p", "plugin:server-code")).toBe(true);
    expect(gate.hasGrant("sess-2", "p")).toBe(false);

    expect(isAllowed(gate, "sess-1", "p", "plugin:server-code")).toBe(true);
    expect(gate.hasGrant("sess-1", "p")).toBe(false);
  });

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

  it("cancels pending approvals when a plugin is revoked", () => {
    const gate = createRpcApprovalGate();
    const pending = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(pending.status).toBe("pending");
    expect(gate.revoke("sess-1", "p")).toBe(1);
    expect(gate.listPending("sess-1")).toEqual([]);
  });

  it("clears an un-consumed one-time grant so the next call re-prompts", () => {
    const gate = createRpcApprovalGate();
    grantOnce(gate, "sess-1", "p");
    // Revoke before any evaluate consumes the grant — exercises the
    // oneTimeGrants branch of revoke, not just sessionCache.
    expect(gate.revoke("sess-1", "p")).toBe(1);
    // The grant is gone: the next evaluate is pending, not a one-time allow.
    expect(isAllowed(gate, "sess-1", "p")).toBe(false);
  });

  it("counts and clears both a session-cached and a one-time grant together", () => {
    const gate = createRpcApprovalGate();
    grantSession(gate, "sess-1", "p", "act-session");
    grantOnce(gate, "sess-1", "p", "act-once");
    // revoke spans both the sessionCache and oneTimeGrants maps for the
    // (session, plugin) prefix.
    expect(gate.revoke("sess-1", "p")).toBe(2);
    expect(isAllowed(gate, "sess-1", "p", "act-session")).toBe(false);
  });
});
