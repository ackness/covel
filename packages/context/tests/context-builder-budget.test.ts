import { describe, it, expect, afterEach } from 'vitest';
import { buildContext } from '@covel/context';
import type {
  ContextBuildParams,
  MessageHistoryRecord,
  TokenEstimator,
} from '@covel/context';
import type { RuntimeManifest, TurnInput } from '@covel/shared';

// Deterministic estimator — 1 token per 4 characters.
const mockEstimator: TokenEstimator = text => Math.ceil(text.length / 4);

function makeManifest(): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500 };
}

function makeTurnInput(): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'do something',
  };
}

// Build a long history guaranteed to overflow a small budget.
function makeHistory(): readonly MessageHistoryRecord[] {
  const history: MessageHistoryRecord[] = [];
  for (let i = 0; i < 20; i++) {
    history.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'a'.repeat(400), // 100 tokens each
    });
  }
  return history;
}

const baseParams = (): ContextBuildParams => ({
  promptTemplate: 'You are a test runtime.',
  manifest: makeManifest(),
  turnInput: makeTurnInput(),
  completedResults: new Map(),
  config: {},
  messageHistory: makeHistory(),
});

describe('buildContext — budget feature flag', () => {
  afterEach(() => {
    delete process.env.COVEL_CONTEXT_BUDGET_V1;
  });

  it('prunes when env flag is set AND estimator+budget are provided', () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';
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
    expect(first.role).toBe('system');
    expect(first.content).toMatch(/older messages pruned/);
  });

  it('does not prune when env flag is unset', () => {
    delete process.env.COVEL_CONTEXT_BUDGET_V1;
    const params: ContextBuildParams = {
      ...baseParams(),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 500,
        reservedForResponse: 0,
      },
    };

    const ctx = buildContext(params);

    // Full history + current message preserved, no placeholder.
    expect(ctx.messages.length).toBe(21);
    expect(ctx.messages[0]!.role).toBe('user');
  });

  it('does not prune when flag is set but estimator is missing', () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';
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
    expect(ctx.messages[0]!.role).toBe('user');
  });

  it('does not prune when flag is set but contextBudget is missing', () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';
    const params: ContextBuildParams = {
      ...baseParams(),
      estimator: mockEstimator,
      // contextBudget omitted
    };

    const ctx = buildContext(params);

    expect(ctx.messages.length).toBe(21);
    expect(ctx.messages[0]!.role).toBe('user');
  });
});
