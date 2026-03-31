import { describe, it, expect } from "vitest";
import { createBudgetEnforcer } from "../src/budget.js";

describe("budget-enforcer", () => {
  it("allows steps within budget", () => {
    const enforcer = createBudgetEnforcer({ maxSteps: 3 });

    expect(() => enforcer.checkStep()).not.toThrow();
    expect(() => enforcer.checkStep()).not.toThrow();
    expect(() => enforcer.checkStep()).not.toThrow();
    expect(enforcer.state.steps).toBe(3);

    enforcer.dispose();
  });

  it("throws when step limit exceeded", () => {
    const enforcer = createBudgetEnforcer({ maxSteps: 1 });

    enforcer.checkStep(); // step 1 — ok
    expect(() => enforcer.checkStep()).toThrow("budget exceeded");

    enforcer.dispose();
  });

  it("tracks token usage", () => {
    const enforcer = createBudgetEnforcer({ maxTokens: 100 });

    expect(enforcer.recordTokens(30, 20)).toBe(false); // 50 < 100
    expect(enforcer.recordTokens(30, 25)).toBe(true); // 105 > 100

    enforcer.dispose();
  });

  it("reports timeout status", () => {
    const enforcer = createBudgetEnforcer({ timeoutMs: 50 });

    expect(enforcer.isTimedOut()).toBe(false);

    enforcer.dispose();
  });

  it("provides abort signal", () => {
    const enforcer = createBudgetEnforcer({ timeoutMs: 10000 });
    const signal = enforcer.signal();

    expect(signal.aborted).toBe(false);

    enforcer.dispose();
  });

  it("works with no budget constraints", () => {
    const enforcer = createBudgetEnforcer();

    enforcer.checkStep();
    enforcer.checkStep();
    expect(enforcer.recordTokens(1000, 1000)).toBe(false);
    expect(enforcer.isTimedOut()).toBe(false);

    enforcer.dispose();
  });
});
