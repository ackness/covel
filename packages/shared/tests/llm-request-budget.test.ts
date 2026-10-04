import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLlmRequestBudget,
  createLlmRequestScope,
  DEFAULT_LLM_REQUEST_CEILING_MS,
  DEFAULT_LLM_REQUEST_IDLE_TIMEOUT_MS,
  DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  noteLlmRequestProgress,
} from "../src/llm-request-budget.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LLM request budget progress", () => {
  it("moves the default deadline while output arrives and stops at the ceiling", () => {
    const start = Date.now();
    const budget = createLlmRequestBudget();
    expect(budget.deadline).toBe(start + DEFAULT_LLM_REQUEST_TIMEOUT_MS);

    vi.advanceTimersByTime(100_000);
    noteLlmRequestProgress(budget);
    expect(budget.deadline).toBe(
      start + 100_000 + DEFAULT_LLM_REQUEST_IDLE_TIMEOUT_MS,
    );

    vi.advanceTimersByTime(DEFAULT_LLM_REQUEST_CEILING_MS);
    noteLlmRequestProgress(budget);
    expect(budget.deadline).toBe(start + DEFAULT_LLM_REQUEST_CEILING_MS);
  });

  it("never moves the deadline earlier", () => {
    const budget = createLlmRequestBudget({
      timeoutMs: 600_000,
      idleTimeoutMs: 1_000,
    });
    const deadline = budget.deadline;
    noteLlmRequestProgress(budget);
    expect(budget.deadline).toBe(deadline);
  });

  it("keeps an explicit limit fixed", () => {
    const timed = createLlmRequestBudget({ timeoutMs: 50 });
    const absolute = createLlmRequestBudget({ deadline: Date.now() + 50 });
    const deadlines = [timed.deadline, absolute.deadline];
    vi.advanceTimersByTime(40);
    noteLlmRequestProgress(timed);
    noteLlmRequestProgress(absolute);
    expect([timed.deadline, absolute.deadline]).toEqual(deadlines);
  });

  it("does not move past an absolute deadline", () => {
    const limit = Date.now() + 200;
    const budget = createLlmRequestBudget({
      timeoutMs: 100,
      deadline: limit,
      idleTimeoutMs: 150,
    });
    vi.advanceTimersByTime(90);
    noteLlmRequestProgress(budget);
    expect(budget.deadline).toBe(limit);
  });

  it("keeps a scope open for a request that writes and ends it on silence", () => {
    const scope = createLlmRequestScope({
      budget: createLlmRequestBudget({ timeoutMs: 100, idleTimeoutMs: 100 }),
    });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(80);
      noteLlmRequestProgress(scope.budget);
    }
    expect(scope.signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);
    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toMatchObject({
      code: "REQUEST_BUDGET_EXCEEDED",
      reason: "deadline",
    });
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects limits that are not positive", () => {
    expect(() => createLlmRequestBudget({ idleTimeoutMs: 0 })).toThrow(
      RangeError,
    );
    expect(() => createLlmRequestBudget({ ceilingMs: -1 })).toThrow(RangeError);
  });
});
