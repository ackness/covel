import { describe, it, expect } from "vitest";
import { createTurnContextBudget } from "../../src/routes/api/bootstrap/compactor.js";

describe("createTurnContextBudget", () => {
  it("prefers the explicit env override over capability", () => {
    const budget = createTurnContextBudget({
      contextWindowOverride: 8000,
      resolveNarrativeBudget: () => ({
        contextWindow: 128_000,
        maxOutputTokens: 8192,
      }),
    });

    expect(budget.maxInputTokens).toBe(8000);
    // reservedForResponse still comes from capability — the override only
    // pins the window.
    expect(budget.reservedForResponse).toBe(8192);
  });

  it("derives window and reserve from the narrative slot capability", () => {
    const budget = createTurnContextBudget({
      resolveNarrativeBudget: () => ({
        contextWindow: 200_000,
        maxOutputTokens: 16_000,
      }),
    });

    expect(budget.maxInputTokens).toBe(200_000);
    expect(budget.reservedForResponse).toBe(16_000);
  });

  it("falls back to 32768 / 4000 when no source is available", () => {
    const budget = createTurnContextBudget({});

    expect(budget.maxInputTokens).toBe(32_768);
    expect(budget.reservedForResponse).toBe(4000);
  });

  it("re-resolves capability on every access (llm.toml hot-reload)", () => {
    let window = 64_000;
    const budget = createTurnContextBudget({
      resolveNarrativeBudget: () => ({ contextWindow: window }),
    });

    expect(budget.maxInputTokens).toBe(64_000);
    window = 1_000_000;
    expect(budget.maxInputTokens).toBe(1_000_000);
  });
});
