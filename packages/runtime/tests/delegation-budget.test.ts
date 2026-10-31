import { describe, expect, it } from "vitest";
import { DelegationBudget } from "../src/orchestration/delegation-budget.js";

describe("execution delegation allowance", () => {
  it("counts every admitted call while counting repeated characters once", () => {
    const budget = new DelegationBudget({
      sessionId: "s",
      settings: { maxActors: 1, maxSubagentCalls: 3 },
    });
    expect(budget.claim("a")).toBeUndefined();
    expect(budget.claim("b")).toBe("actors");
    expect(budget.claim("a")).toBeUndefined();
    expect(budget.claim()).toBeUndefined();
    expect(budget.claim("a")).toBe("calls");
    expect(budget.snapshot().calls).toBe(3);
  });
  it("restores spent calls and actor identity, including zero settings", () => {
    const budget = new DelegationBudget({
      sessionId: "s",
      settings: { maxActors: 0, maxSubagentCalls: 1 },
    });
    expect(budget.claim("a")).toBe("actors");
    expect(budget.claim()).toBeUndefined();
    const resumed = new DelegationBudget({
      sessionId: "s",
      saved: budget.snapshot(),
    });
    expect(resumed.claim()).toBe("calls");
    expect(new DelegationBudget({ sessionId: "s" }).claim()).toBeUndefined();
  });
  it("clamps a plan without reserving and retains later admitted characters", () => {
    const budget = new DelegationBudget({
      sessionId: "s",
      settings: { maxActors: 1, maxSubagentCalls: 3 },
    });
    budget.claim("a");
    const plan = budget.clamp({
      actors: [{ characterId: "b" }, { characterId: "a" }],
      order: "parallel",
      narrator: "after",
      yieldHint: "user",
    });
    expect(plan.actors).toEqual([{ characterId: "a" }]);
    expect(budget.snapshot().calls).toBe(1);
  });
});
