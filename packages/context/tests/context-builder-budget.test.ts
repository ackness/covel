import { describe, it, expect } from "vitest";
import { buildContext } from "@covel/context";
import type {
  ContextBuildParams,
  MessageHistoryRecord,
  TokenEstimator,
} from "@covel/context";
import type { RuntimeManifest, TurnInput } from "@covel/shared";

// Deterministic estimator — 1 token per 4 characters.
const mockEstimator: TokenEstimator = (text) => Math.ceil(text.length / 4);

function makeManifest(): RuntimeManifest {
  return { name: "test-rt", description: "test", priority: 500 };
}

function makeTurnInput(): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "do something",
  };
}

// Build a long history guaranteed to overflow a small budget.
function makeHistory(): readonly MessageHistoryRecord[] {
  const history: MessageHistoryRecord[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "a".repeat(400), // 100 tokens each
    });
  }
  return history;
}

const baseParams = (): ContextBuildParams => ({
  promptTemplate: "You are a test runtime.",
  manifest: makeManifest(),
  turnInput: makeTurnInput(),
  completedResults: new Map(),
  messageHistory: makeHistory(),
});

describe("buildContext — budget pruning", () => {
  it("prunes when estimator+budget are provided", () => {
    const params: ContextBuildParams = {
      ...baseParams(),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 500,
        reservedForResponse: 0,
      },
    };

    const ctx = buildContext(params);

    // Input history = 20 msgs + 1 current user = 21. Pruning must drop some.
    expect(ctx.messages.length).toBeLessThan(21);
    // First element should be the synthetic placeholder.
    const first = ctx.messages[0]!;
    expect(first.role).toBe("system");
    expect(first.content).toMatch(/older messages pruned/);
  });

  it("reports the budget outcome so callers can trace a pruned turn", () => {
    const params: ContextBuildParams = {
      ...baseParams(),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 500,
        reservedForResponse: 0,
      },
    };

    const ctx = buildContext(params);

    expect(ctx.budgetExceeded).toBe(true);
    expect(ctx.prunedMessageCount).toBeGreaterThan(0);
  });

  it("does not prune when estimator is missing", () => {
    const params: ContextBuildParams = {
      ...baseParams(),
      contextBudget: {
        maxInputTokens: 500,
        reservedForResponse: 0,
      },
      // estimator omitted
    };

    const ctx = buildContext(params);

    expect(ctx.messages.length).toBe(21);
    expect(ctx.messages[0]!.role).toBe("user");
  });

  it("does not prune when contextBudget is missing", () => {
    const params: ContextBuildParams = {
      ...baseParams(),
      estimator: mockEstimator,
      // contextBudget omitted
    };

    const ctx = buildContext(params);

    expect(ctx.messages.length).toBe(21);
    expect(ctx.messages[0]!.role).toBe("user");
  });
});
