import { describe, expect, it } from "vitest";
import { createRpcApprovalGate } from "../src/rpc-approval.js";

describe("createRpcApprovalGate (PR-7)", () => {
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

	it("auto-allows official trust level", () => {
		const gate = createRpcApprovalGate();
		const result = gate.evaluate({
			sessionId: "sess-1",
			pluginId: "codex",
			action: "regenerate",
			payload: {},
			trustLevel: "official",
		});
		expect(result.status).toBe("allow");
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

	it("rejects new pending entries when the per-session cap is reached (MEDIUM-1)", () => {
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

	it("cap recovers after deciding pending entries (MEDIUM-1)", () => {
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
});
