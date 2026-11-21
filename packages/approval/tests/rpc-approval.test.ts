import { describe, expect, it, vi } from "vitest";
import {
  createRpcApprovalGate as createStrictRpcApprovalGate,
  MAX_SESSION_CACHE,
  ONE_TIME_GRANT_TTL_MS,
  STALE_PENDING_TTL_MS,
  type EvaluateInput,
  type RpcApprovalGateOptions,
} from "../src/rpc-approval.js";

const TEST_SCOPE = "test-session-incarnation";
type TestEvaluateInput = Omit<EvaluateInput, "sessionScope"> &
  Partial<Pick<EvaluateInput, "sessionScope">>;

function createRpcApprovalGate(options?: RpcApprovalGateOptions) {
  const gate = createStrictRpcApprovalGate(options);
  return {
    ...gate,
    evaluate: (input: TestEvaluateInput) =>
      gate.evaluate({ sessionScope: TEST_SCOPE, ...input }),
    decide: (decision: Parameters<typeof gate.decide>[0], scope = TEST_SCOPE) =>
      gate.decide(decision, scope),
    listPending: (sessionId: string, scope = TEST_SCOPE) =>
      gate.listPending(sessionId, scope),
    hasGrant: (
      sessionId: string,
      pluginId: string,
      action: string,
      scope = TEST_SCOPE,
      ...payloadArg: [] | [payload: unknown]
    ) => gate.hasGrant(sessionId, pluginId, action, scope, ...payloadArg),
  };
}

describe("createRpcApprovalGate", () => {
  it("fails closed when an untyped caller omits sessionScope", () => {
    const gate = createStrictRpcApprovalGate();
    expect(() =>
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "a",
        payload: null,
        trustLevel: "community",
      } as EvaluateInput),
    ).toThrow(/sessionScope is required/);
  });

  it("auto-allows builtin trust level", () => {
    const gate = createRpcApprovalGate();
    const result = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "framework",
      action: "submit-form",
      payload: {},
      trustLevel: "builtin",
    });
    expect(result.status).toBe("allow");
    if (result.status === "allow") expect(result.reason).toBe("trusted");
  });

  it("puts community-trust calls into pending", () => {
    const gate = createRpcApprovalGate();
    const result = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "third-party",
      action: "do-stuff",
      payload: { x: 1 },
      trustLevel: "community",
      description: "Run the thing",
    });
    expect(result.status).toBe("pending");
    if (result.status === "pending") {
      expect(result.approvalId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.pending.pluginId).toBe("third-party");
      expect(result.pending.action).toBe("do-stuff");
      expect(result.pending.description).toBe("Run the thing");
    }
  });

  it("expires a stale matching pending before considering reuse", () => {
    const now = Date.parse("2026-08-24T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const gate = createRpcApprovalGate();
      const first = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "third-party",
        action: "do-stuff",
        payload: { version: 1 },
        trustLevel: "community",
      });
      if (first.status !== "pending") throw new Error("unreachable");

      vi.setSystemTime(now + 60 * 60 * 1000 + 1);
      const retried = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "third-party",
        action: "do-stuff",
        payload: { version: 2 },
        trustLevel: "community",
      });

      expect(retried.status).toBe("pending");
      if (retried.status !== "pending") throw new Error("unreachable");
      expect(retried.approvalId).not.toBe(first.approvalId);
      expect(retried.pending.payload).toEqual({ version: 2 });
      expect(gate.listPending("sess-1")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("decide(allow, scope=session) caches the triple for follow-up calls", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(first.status).toBe("pending");
    if (first.status !== "pending") throw new Error("unreachable");

    gate.decide({
      approvalId: first.approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });

    const second = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(second.status).toBe("allow");
    if (second.status === "allow") expect(second.reason).toBe("session-cached");

    // Third call still allowed (session cache is sticky for the instance).
    const third = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(third.status).toBe("allow");
  });

  it("decide(allow, scope=once) issues a one-time grant that is consumed exactly once", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    if (first.status !== "pending") throw new Error("unreachable");

    gate.decide({
      approvalId: first.approvalId,
      decision: "allow",
      scope: "once",
      decidedAt: new Date().toISOString(),
    });

    const second = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(second.status).toBe("allow");
    if (second.status === "allow") expect(second.reason).toBe("one-time-grant");

    // Third call needs another approval — the grant was consumed.
    const third = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(third.status).toBe("pending");
  });

  it("binds a one-time grant to the exact approved payload", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 1, target: "merchant" },
      trustLevel: "community",
    });
    if (first.status !== "pending") throw new Error("unreachable");

    gate.decide({
      approvalId: first.approvalId,
      decision: "allow",
      scope: "once",
      decidedAt: new Date().toISOString(),
    });

    // A changed payload is a different dispatch and must prompt independently.
    const changed = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 10_000, target: "merchant" },
      trustLevel: "community",
    });
    expect(changed.status).toBe("pending");

    // The rejected substitution must not consume the honest one-time retry.
    const approved = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      // Object key order is not part of JSON value identity.
      payload: { target: "merchant", amount: 1 },
      trustLevel: "community",
    });
    expect(approved).toMatchObject({
      status: "allow",
      reason: "one-time-grant",
    });
  });

  it("does not reuse a pending approval for a different payload", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 1 },
      trustLevel: "community",
    });
    const second = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 2 },
      trustLevel: "community",
    });
    expect(first.status).toBe("pending");
    expect(second.status).toBe("pending");
    if (first.status === "pending" && second.status === "pending") {
      expect(second.approvalId).not.toBe(first.approvalId);
      expect(second.pending.payload).toEqual({ amount: 2 });
    }
  });

  it("decide(deny) does not cache anything; next call goes pending again", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    if (first.status !== "pending") throw new Error("unreachable");

    const result = gate.decide({
      approvalId: first.approvalId,
      decision: "deny",
      decidedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(true);

    const second = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(second.status).toBe("pending");
    // A fresh approvalId, not the same one (the old one was consumed).
    if (second.status === "pending") {
      expect(second.approvalId).not.toBe(first.approvalId);
    }
  });

  it("decide() with unknown approvalId returns ok: false", () => {
    const gate = createRpcApprovalGate();
    const result = gate.decide({
      approvalId: "made-up-id",
      decision: "allow",
      decidedAt: new Date().toISOString(),
    });
    expect(result.ok).toBe(false);
  });

  it("listPending() filters by sessionId", () => {
    const gate = createRpcApprovalGate();
    gate.evaluate({
      sessionId: "sess-A",
      pluginId: "p",
      action: "a1",
      payload: null,
      trustLevel: "community",
    });
    gate.evaluate({
      sessionId: "sess-A",
      pluginId: "p",
      action: "a2",
      payload: null,
      trustLevel: "community",
    });
    gate.evaluate({
      sessionId: "sess-B",
      pluginId: "p",
      action: "a3",
      payload: null,
      trustLevel: "community",
    });

    expect(gate.listPending("sess-A")).toHaveLength(2);
    expect(gate.listPending("sess-B")).toHaveLength(1);
    expect(gate.listPending("sess-missing")).toHaveLength(0);
  });

  it("isolates pending requests and grants by session incarnation", () => {
    const gate = createRpcApprovalGate();
    const oldPending = gate.evaluate({
      sessionId: "reused-id",
      sessionScope: "incarnation-old",
      pluginId: "p",
      action: "a",
      payload: { incarnation: "old" },
      trustLevel: "community",
    });
    if (oldPending.status !== "pending") throw new Error("unreachable");

    const newPending = gate.evaluate({
      sessionId: "reused-id",
      sessionScope: "incarnation-new",
      pluginId: "p",
      action: "a",
      payload: { incarnation: "new" },
      trustLevel: "community",
    });
    if (newPending.status !== "pending") throw new Error("unreachable");

    expect(newPending.approvalId).not.toBe(oldPending.approvalId);
    expect(gate.listPending("reused-id", "incarnation-old")).toEqual([
      oldPending.pending,
    ]);
    expect(gate.listPending("reused-id", "incarnation-new")).toEqual([
      newPending.pending,
    ]);

    expect(
      gate.decide(
        {
          approvalId: oldPending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        "incarnation-new",
      ),
    ).toEqual({
      ok: false,
      error: `approval scope changed for ${oldPending.approvalId}`,
      reason: "scope-changed",
    });

    expect(
      gate.decide(
        {
          approvalId: oldPending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        "incarnation-old",
      ).ok,
    ).toBe(true);
    expect(gate.hasGrant("reused-id", "p", "a", "incarnation-old")).toBe(true);
    expect(gate.hasGrant("reused-id", "p", "a", "incarnation-new")).toBe(false);
  });

  it("session cache is per-(plugin, action), not per-plugin", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a1",
      payload: null,
      trustLevel: "community",
    });
    if (first.status !== "pending") throw new Error("unreachable");
    gate.decide({
      approvalId: first.approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });

    // a1 cached, a2 still needs approval.
    const a2 = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a2",
      payload: null,
      trustLevel: "community",
    });
    expect(a2.status).toBe("pending");
  });

  it("rejects new pending entries when the per-session cap is reached", () => {
    const gate = createRpcApprovalGate();
    // 64 is the MAX_PENDING_PER_SESSION default.
    for (let i = 0; i < 64; i++) {
      const result = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: `a${i}`,
        payload: null,
        trustLevel: "community",
      });
      expect(result.status).toBe("pending");
    }
    // 65th call → rejected.
    const overflow = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "a-overflow",
      payload: null,
      trustLevel: "community",
    });
    expect(overflow.status).toBe("rejected");
    if (overflow.status === "rejected") {
      expect(overflow.reason).toBe("queue-full");
      expect(overflow.limit).toBe(64);
    }
    // Other sessions still work.
    const otherSession = gate.evaluate({
      sessionId: "sess-2",
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    expect(otherSession.status).toBe("pending");
  });

  it("does not let an old incarnation's pending cap block a recreated session", () => {
    const gate = createRpcApprovalGate();
    for (let i = 0; i < 64; i++) {
      expect(
        gate.evaluate({
          sessionId: "reused-id",
          sessionScope: "old-incarnation",
          pluginId: "p",
          action: `old-${i}`,
          payload: null,
          trustLevel: "community",
        }).status,
      ).toBe("pending");
    }

    expect(
      gate.evaluate({
        sessionId: "reused-id",
        sessionScope: "new-incarnation",
        pluginId: "p",
        action: "new-request",
        payload: null,
        trustLevel: "community",
      }).status,
    ).toBe("pending");
  });

  it("cap recovers after deciding pending entries", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "first",
      payload: null,
      trustLevel: "community",
    });
    if (first.status !== "pending") throw new Error("unreachable");

    // Fill up to cap.
    for (let i = 0; i < 63; i++) {
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: `a${i}`,
        payload: null,
        trustLevel: "community",
      });
    }

    // Decide one → frees a slot.
    gate.decide({
      approvalId: first.approvalId,
      decision: "deny",
      decidedAt: new Date().toISOString(),
    });

    const next = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "recovered",
      payload: null,
      trustLevel: "community",
    });
    expect(next.status).toBe("pending");
  });

  it("sweeps stale pending approvals in listPending, listAllPendingForSession, getPending, pendingMatchesScope, and decide", () => {
    const now = Date.parse("2026-08-24T00:00:00.000Z");
    vi.useFakeTimers();
    try {
      const setupExpired = () => {
        vi.setSystemTime(now);
        const gate = createRpcApprovalGate();
        const pending = gate.evaluate({
          sessionId: "sess-1",
          pluginId: "third-party",
          action: "do-stuff",
          payload: { version: 1 },
          trustLevel: "community",
        });
        if (pending.status !== "pending") throw new Error("unreachable");
        vi.setSystemTime(now + STALE_PENDING_TTL_MS + 1);
        return { gate, approvalId: pending.approvalId };
      };

      {
        const { gate } = setupExpired();
        expect(gate.listPending("sess-1")).toEqual([]);
      }
      {
        const { gate } = setupExpired();
        expect(gate.listAllPendingForSession("sess-1")).toEqual([]);
      }
      {
        const { gate, approvalId } = setupExpired();
        expect(gate.getPending(approvalId)).toBeUndefined();
      }
      {
        const { gate, approvalId } = setupExpired();
        expect(gate.pendingMatchesScope(approvalId, TEST_SCOPE)).toBe(false);
      }
      {
        const { gate, approvalId } = setupExpired();
        const decision = gate.decide({
          approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        });
        expect(decision).toEqual({
          ok: false,
          error: `unknown approvalId: ${approvalId}`,
          reason: "unknown-approval",
        });
        expect(gate.hasGrant("sess-1", "third-party", "do-stuff")).toBe(false);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates multiple once approvals with different payloads for the same action without overwriting", () => {
    const gate = createRpcApprovalGate();
    const first = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 1, target: "merchant" },
      trustLevel: "community",
    });
    const second = gate.evaluate({
      sessionId: "sess-1",
      pluginId: "p",
      action: "transfer",
      payload: { amount: 2, target: "smith" },
      trustLevel: "community",
    });
    if (first.status !== "pending" || second.status !== "pending") {
      throw new Error("unreachable");
    }

    expect(
      gate.decide({
        approvalId: first.approvalId,
        decision: "allow",
        scope: "once",
        decidedAt: new Date().toISOString(),
      }).ok,
    ).toBe(true);
    expect(
      gate.decide({
        approvalId: second.approvalId,
        decision: "allow",
        scope: "once",
        decidedAt: new Date().toISOString(),
      }).ok,
    ).toBe(true);

    // 4-arg hasGrant remains backward-compatible; 5-arg hasGrant matches by payload without consuming.
    expect(gate.hasGrant("sess-1", "p", "transfer")).toBe(true);
    expect(
      gate.hasGrant("sess-1", "p", "transfer", TEST_SCOPE, {
        target: "merchant",
        amount: 1,
      }),
    ).toBe(true);
    expect(
      gate.hasGrant("sess-1", "p", "transfer", TEST_SCOPE, {
        amount: 2,
        target: "smith",
      }),
    ).toBe(true);
    expect(
      gate.hasGrant("sess-1", "p", "transfer", TEST_SCOPE, {
        amount: 999,
        target: "other",
      }),
    ).toBe(false);
    expect(
      gate.hasGrant("sess-1", "p", "transfer", TEST_SCOPE, undefined),
    ).toBe(false);

    // Approving payload B must not clobber the unused once grant for payload A.
    expect(
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "transfer",
        payload: { target: "merchant", amount: 1 },
        trustLevel: "community",
      }),
    ).toEqual({ status: "allow", reason: "one-time-grant" });

    // Payload A was consumed once; retrying it must prompt again.
    expect(
      gate.hasGrant("sess-1", "p", "transfer", TEST_SCOPE, {
        amount: 1,
        target: "merchant",
      }),
    ).toBe(false);
    expect(
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "transfer",
        payload: { amount: 1, target: "merchant" },
        trustLevel: "community",
      }).status,
    ).toBe("pending");

    // Payload B's grant must still be intact and consumable once.
    expect(
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "transfer",
        payload: { target: "smith", amount: 2 },
        trustLevel: "community",
      }),
    ).toEqual({ status: "allow", reason: "one-time-grant" });

    expect(
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "transfer",
        payload: { amount: 2, target: "smith" },
        trustLevel: "community",
      }).status,
    ).toBe("pending");
  });

  it("sweeps expired one-time grants on write in decide() and counts multi-payload grants on revoke()", () => {
    const now = Date.parse("2026-08-24T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const gate = createRpcApprovalGate();
      const first = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "a1",
        payload: { step: 1 },
        trustLevel: "community",
      });
      if (first.status !== "pending") throw new Error("unreachable");
      gate.decide({
        approvalId: first.approvalId,
        decision: "allow",
        scope: "once",
        decidedAt: new Date().toISOString(),
      });

      // Advance past the one-time grant TTL, then write two fresh once grants for the same action.
      vi.setSystemTime(now + ONE_TIME_GRANT_TTL_MS + 1);
      const second = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "a2",
        payload: { step: 2 },
        trustLevel: "community",
      });
      const third = gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "a2",
        payload: { step: 3 },
        trustLevel: "community",
      });
      if (second.status !== "pending" || third.status !== "pending") {
        throw new Error("unreachable");
      }
      gate.decide({
        approvalId: second.approvalId,
        decision: "allow",
        scope: "once",
        decidedAt: new Date().toISOString(),
      });
      gate.decide({
        approvalId: third.approvalId,
        decision: "allow",
        scope: "once",
        decidedAt: new Date().toISOString(),
      });

      // Only the two fresh grants remain to be revoked (the expired a1 grant was swept).
      expect(gate.revoke("sess-1", "p")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  const grantSessionAction = (
    gate: ReturnType<typeof createRpcApprovalGate>,
    sessionId: string,
  ) => {
    const pending = gate.evaluate({
      sessionId,
      pluginId: "p",
      action: "a",
      payload: null,
      trustLevel: "community",
    });
    if (pending.status !== "pending") throw new Error("unreachable");
    gate.decide({
      approvalId: pending.approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });
  };

  it("evicts least-recently-used sessionCache entries past the cap", () => {
    const gate = createRpcApprovalGate();
    for (let i = 0; i < MAX_SESSION_CACHE; i += 1) {
      grantSessionAction(gate, `sess-${i}`);
    }

    // Touch sess-0 so sess-1 becomes the least-recently-used entry.
    expect(
      gate.evaluate({
        sessionId: "sess-0",
        pluginId: "p",
        action: "a",
        payload: null,
        trustLevel: "community",
      }),
    ).toEqual({ status: "allow", reason: "session-cached" });

    // Adding one more entry past the cap evicts sess-1 while keeping sess-0.
    grantSessionAction(gate, "sess-overflow");

    expect(
      gate.evaluate({
        sessionId: "sess-0",
        pluginId: "p",
        action: "a",
        payload: null,
        trustLevel: "community",
      }),
    ).toEqual({ status: "allow", reason: "session-cached" });
    expect(
      gate.evaluate({
        sessionId: "sess-1",
        pluginId: "p",
        action: "a",
        payload: null,
        trustLevel: "community",
      }).status,
    ).toBe("pending");
    expect(
      gate.evaluate({
        sessionId: "sess-overflow",
        pluginId: "p",
        action: "a",
        payload: null,
        trustLevel: "community",
      }),
    ).toEqual({ status: "allow", reason: "session-cached" });
  });

  it("supports configuring maxSessionCache and refreshes LRU on hasGrant", () => {
    expect(() => createRpcApprovalGate({ maxSessionCache: 0 })).toThrow(
      RangeError,
    );
    const gate = createRpcApprovalGate({ maxSessionCache: 2 });

    grantSessionAction(gate, "s1");
    grantSessionAction(gate, "s2");
    // Refresh s1 via hasGrant so s2 becomes the LRU victim.
    expect(gate.hasGrant("s1", "p", "a")).toBe(true);
    grantSessionAction(gate, "s3");

    expect(gate.hasGrant("s1", "p", "a")).toBe(true);
    expect(gate.hasGrant("s2", "p", "a")).toBe(false);
    expect(gate.hasGrant("s3", "p", "a")).toBe(true);
  });
});
