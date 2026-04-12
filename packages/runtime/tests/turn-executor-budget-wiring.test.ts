/**
 * Wiring tests for the S1-T5 context-budget plumbing in turn-executor.
 *
 * These tests lock in the gates on budget injection:
 *
 *   1. Injected when: estimator + contextBudget + env flag + no declared tools
 *   2. Skipped when: manifest declares `input.tools` (I1 tool-pair guard)
 *   3. Skipped when: manifest declares `tools.builtin` (I1 tool-pair guard)
 *   4. Skipped when: manifest declares `tools.local` (I1 tool-pair guard)
 *   5. Skipped when: env flag (`COVEL_CONTEXT_BUDGET_V1`) is unset
 *
 * The env-flag check itself lives in `buildContext` (S1-T2); turn-executor's
 * job is only to thread the dependency references through. We verify the
 * thread by spying on the estimator — if it gets called at least once during
 * the turn, we know the budget pass ran.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeManifest, TurnInput } from '@covel/shared';
import type { LoadedRuntime } from '@covel/plugin-loader';
import type { TokenEstimator } from '@covel/context';
import { executeTurn } from '../src/turn-executor.js';
import type { TurnExecutorDeps } from '../src/turn-executor.js';
import type { LLMAdapter, LLMResponse } from '../src/llm-adapter.js';

// ── Fixtures ─────────────────────────────────────────────────────

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 42, outputTokens: 10 },
  };
}

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: 'test-narrator',
    pluginId: 'test-narrator',
    description: 'Synthetic narrator for budget-wiring tests.',
    priority: 500,
    runtimeType: 'agent',
    outputKind: 'story',
    ...overrides,
  };
}

function makeLoaded(manifest: RuntimeManifest): LoadedRuntime {
  return {
    manifest,
    promptTemplate: 'You are narrating. Current message: {{ player.message }}.',
    references: [],
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-budget-wire',
    turnId: 'turn-1',
    playerMessage: 'Look around the room',
    ...overrides,
  };
}

function makeBaseDeps(
  llm: LLMAdapter,
  manifest: RuntimeManifest,
): TurnExecutorDeps {
  return {
    loadRuntime: async () => makeLoaded(manifest),
    llm,
    getConfig: () => ({}),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('turn-executor → context budget wiring', () => {
  afterEach(() => {
    delete process.env.COVEL_CONTEXT_BUDGET_V1;
    vi.restoreAllMocks();
  });

  it('invokes the estimator when all conditions are met', async () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Narrator-like manifest: no tools declared on input.
    const manifest = makeManifest();

    const deps: TurnExecutorDeps = {
      ...makeBaseDeps(llm, manifest),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe('success');
    expect(estimator).toHaveBeenCalled();
  });

  it('skips the estimator when the manifest declares input.tools (I1 guard)', async () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare at least one input tool — turn-executor must NOT inject budget.
    const manifest = makeManifest({
      input: {
        tools: [{ plugin: 'other-plugin', runtime: 'other-runtime' }],
      },
    });

    const deps: TurnExecutorDeps = {
      ...makeBaseDeps(llm, manifest),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });

  it('skips the estimator when the manifest declares tools.builtin (I1 guard)', async () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare a builtin tool — buildToolDefinitions would register it, so budget
    // injection must be skipped to avoid splitting assistant↔tool pairs.
    const manifest = makeManifest({
      tools: {
        builtin: ['plugin-data-set'],
      },
    });

    const deps: TurnExecutorDeps = {
      ...makeBaseDeps(llm, manifest),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });

  it('skips the estimator when the manifest declares tools.local (I1 guard)', async () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare a local tool path — buildToolDefinitions would register it, so
    // budget injection must be skipped.
    const manifest = makeManifest({
      tools: {
        local: ['./tools/dummy.ts'],
      },
    });

    const deps: TurnExecutorDeps = {
      ...makeBaseDeps(llm, manifest),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });

  it('skips the estimator when COVEL_CONTEXT_BUDGET_V1 is unset', async () => {
    // Env flag deliberately NOT set.
    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    const manifest = makeManifest();

    const deps: TurnExecutorDeps = {
      ...makeBaseDeps(llm, manifest),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });
});
