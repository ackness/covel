import { describe, it, expect, beforeEach, afterEach } from "vitest";
import accumulateUsage from "../hooks/accumulate-usage.js";
import trimDownstream from "../hooks/trim-downstream.js";
import enforceCap from "../hooks/enforce-cap.js";
import cleanup from "../hooks/cleanup.js";
import { total, _reset } from "../hooks/budget.js";

const SID = "sess-cost-1";

describe("cost-gate hooks", () => {
  const prevHard = process.env.COST_GATE_HARD_TOKENS;
  const prevSoft = process.env.COST_GATE_SOFT_TOKENS;

  beforeEach(() => {
    _reset();
    process.env.COST_GATE_HARD_TOKENS = "100";
    process.env.COST_GATE_SOFT_TOKENS = "50";
  });

  afterEach(() => {
    if (prevHard === undefined) delete process.env.COST_GATE_HARD_TOKENS;
    else process.env.COST_GATE_HARD_TOKENS = prevHard;
    if (prevSoft === undefined) delete process.env.COST_GATE_SOFT_TOKENS;
    else process.env.COST_GATE_SOFT_TOKENS = prevSoft;
    _reset();
  });

  it("accumulate-usage adds token usage into the session bucket", async () => {
    const r = await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 10, outputTokens: 5 } } },
    );
    expect(r).toEqual({ action: "continue" });
    expect(total(SID)).toBe(15);

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 20, outputTokens: 0 } } },
    );
    expect(total(SID)).toBe(35);
  });

  it("accumulate-usage is a no-op when usage is missing", async () => {
    await accumulateUsage({ sessionId: SID }, { response: {} });
    await accumulateUsage({ sessionId: SID }, {});
    expect(total(SID)).toBe(0);
  });

  it("trim-downstream keeps all runtimes below the soft cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 10, outputTokens: 0 } } },
    ); // 10 < 50
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
    ];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r).toEqual({ action: "continue" });
  });

  it("trim-downstream drops non-story runtimes at/above the soft cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 60, outputTokens: 0 } } },
    ); // 60 >= 50
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
      { name: "guide", outputKind: "plugin" },
    ];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r.action).toBe("continue");
    expect(r.replace.triggered).toEqual([
      { name: "narrator", outputKind: "story" },
    ]);
  });

  it("trim-downstream returns plain continue when there is nothing to drop", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 60, outputTokens: 0 } } },
    );
    const triggered = [{ name: "narrator", outputKind: "story" }];
    const r = await trimDownstream({ sessionId: SID }, { triggered });
    expect(r).toEqual({ action: "continue" });
  });

  it("enforce-cap aborts the turn at/above the hard cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 100, outputTokens: 0 } } },
    ); // 100 >= 100
    const r = await enforceCap({ sessionId: SID });
    expect(r.action).toBe("abort");
    expect(r.reason).toMatch(/budget/i);
  });

  it("enforce-cap continues below the hard cap", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 99, outputTokens: 0 } } },
    );
    const r = await enforceCap({ sessionId: SID });
    expect(r).toEqual({ action: "continue" });
  });

  it("cleanup drops the session bucket", async () => {
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 30, outputTokens: 0 } } },
    );
    expect(total(SID)).toBe(30);
    const r = await cleanup({ sessionId: SID });
    expect(r).toEqual({ action: "continue" });
    expect(total(SID)).toBe(0);
  });

  it("buckets are isolated per session", async () => {
    await accumulateUsage(
      { sessionId: "a" },
      { response: { usage: { inputTokens: 10, outputTokens: 0 } } },
    );
    await accumulateUsage(
      { sessionId: "b" },
      { response: { usage: { inputTokens: 120, outputTokens: 0 } } },
    );
    expect(total("a")).toBe(10);
    expect(total("b")).toBe(120);
    // Session b is over the hard cap (100); session a is not.
    expect((await enforceCap({ sessionId: "a" })).action).toBe("continue");
    expect((await enforceCap({ sessionId: "b" })).action).toBe("abort");
  });

  it("degrades gracefully when misconfigured (soft >= hard): hard cap still enforced", async () => {
    // Operator error: soft cap not below hard cap. trim-downstream then has no
    // window before enforce-cap, but the hard cap must still protect spend and
    // nothing should crash.
    process.env.COST_GATE_SOFT_TOKENS = "100";
    process.env.COST_GATE_HARD_TOKENS = "100";
    const triggered = [
      { name: "narrator", outputKind: "story" },
      { name: "codex", outputKind: "plugin" },
    ];

    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 99, outputTokens: 0 } } },
    );
    // Below both caps: turn proceeds untouched.
    expect(
      (await trimDownstream({ sessionId: SID }, { triggered })).action,
    ).toBe("continue");
    expect((await enforceCap({ sessionId: SID })).action).toBe("continue");

    // Reaching the hard cap still aborts the turn.
    await accumulateUsage(
      { sessionId: SID },
      { response: { usage: { inputTokens: 1, outputTokens: 0 } } },
    );
    expect((await enforceCap({ sessionId: SID })).action).toBe("abort");
  });
});
