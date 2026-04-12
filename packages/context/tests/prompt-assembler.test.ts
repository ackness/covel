import { afterEach, describe, expect, it } from 'vitest';
import {
  buildContext,
  buildContextV2,
  type ContextBuildParams,
  type MessageHistoryRecord,
  type TokenEstimator,
} from '@covel/context';
import type { RuntimeManifest, RuntimeResult, TurnInput } from '@covel/shared';

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return { name: 'test-rt', description: 'test', priority: 500, ...overrides };
}

function makeRuntimeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: 'test-plugin',
    runtimeId: 'test-rt',
    runId: 'run-1',
    turnId: 'turn-1',
    status: 'success',
    output: {},
    toolCalls: [],
    durationMs: 10,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-1',
    turnId: 'turn-1',
    playerMessage: 'I step forward',
    ...overrides,
  };
}

function baselineParams(
  overrides?: Partial<ContextBuildParams>,
): ContextBuildParams {
  return {
    promptTemplate: 'You are a test narrator.',
    manifest: makeManifest(),
    turnInput: makeTurnInput(),
    completedResults: new Map(),
    config: {},
    ...overrides,
  };
}

// Deterministic mock estimator — ~4 chars per token.
const mockEstimator: TokenEstimator = text => Math.ceil(text.length / 4);

// Ensure env-based gating never leaks between tests.
afterEach(() => {
  delete process.env.COVEL_PROMPT_V2;
  delete process.env.COVEL_CONTEXT_BUDGET_V1;
});

// ── Tests ───────────────────────────────────────────────────────

describe('prompt-assembler V2', () => {
  it('produces byte-identical output to V1 for a locale-less, inject-less baseline', () => {
    const params = baselineParams({
      promptTemplate: 'You are a narrator. Respond to {{ player.message }}.',
      turnInput: makeTurnInput({ playerMessage: 'hello world' }),
    });

    const v1 = buildContext(params);
    const v2 = buildContextV2(params);

    expect(v2.systemPrompt).toBe(v1.systemPrompt);
    expect(v2.messages).toEqual(v1.messages);
  });

  it('places the language constraint in segment 1 (framework preamble), not at the tail of segment 3', () => {
    const params = baselineParams({
      promptTemplate: 'Tell a story.',
      turnInput: makeTurnInput({ locale: 'en-US', playerMessage: 'go' }),
    });

    const v2 = buildContextV2(params);

    // Preamble appears before the plugin body.
    const localeIdx = v2.systemPrompt.indexOf('[LANGUAGE]');
    const bodyIdx = v2.systemPrompt.indexOf('Tell a story.');
    expect(localeIdx).toBeGreaterThanOrEqual(0);
    expect(bodyIdx).toBeGreaterThan(localeIdx);

    // Language name is resolved from the locale map.
    expect(v2.systemPrompt).toContain('English');

    // Confirm V1 places it at the TAIL of the prompt — structural contrast.
    const v1 = buildContext(params);
    expect(v1.systemPrompt.endsWith('in English.')).toBe(true);
  });

  it('places upstream injects in segment 5, after plugin instructions, before messages', () => {
    const params = baselineParams({
      promptTemplate: 'You are a downstream runtime.',
      manifest: makeManifest({
        input: {
          inject: [
            { from: 'upstream/rt', field: 'narrativeOutput', as: '<upstream-output>' },
          ],
        },
      }),
      completedResults: new Map([
        [
          'upstream/rt',
          makeRuntimeResult({ output: { narrativeOutput: 'the upstream story' } }),
        ],
      ]),
    });

    const v2 = buildContextV2(params);

    const bodyIdx = v2.systemPrompt.indexOf('You are a downstream runtime.');
    const injectIdx = v2.systemPrompt.indexOf('<upstream-output>the upstream story</upstream-output>');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThan(bodyIdx);

    // Messages array still only contains the current user turn.
    expect(v2.messages).toEqual([{ role: 'user', content: 'I step forward' }]);
  });

  it('omits empty segments without leaving double blank lines in the output', () => {
    const params = baselineParams({
      promptTemplate: 'Line one.',
      // No locale → segment 1 empty. No injects → segment 5 empty.
      // Segments 2/4/6 are always empty for S2-T1.
    });

    const v2 = buildContextV2(params);

    // Only segment 3 has content → systemPrompt is exactly the plugin body.
    expect(v2.systemPrompt).toBe('Line one.');
    // No stray blank-line separators from skipped segments.
    expect(v2.systemPrompt).not.toMatch(/\n\n\n/);
  });

  it('respects the budget-pruning pass when estimator + contextBudget + COVEL_CONTEXT_BUDGET_V1=1 are provided', () => {
    process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

    // Large history that should be pruned down.
    const history: MessageHistoryRecord[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
      { role: 'user', content: 'c'.repeat(400) },
      { role: 'assistant', content: 'd'.repeat(400) },
      { role: 'user', content: 'recent-user-1' },
      { role: 'assistant', content: 'recent-asst-1' },
      { role: 'user', content: 'recent-user-2' },
    ];

    const params = baselineParams({
      promptTemplate: 'Short system.',
      messageHistory: history,
      turnInput: makeTurnInput({ playerMessage: 'final player message' }),
      estimator: mockEstimator,
      contextBudget: {
        maxInputTokens: 200,
        reservedForResponse: 50,
        protectLastUserTurns: 2,
      },
    });

    const v2 = buildContextV2(params);

    // A synthetic placeholder system message appears at index 0 after pruning.
    expect(v2.messages[0]?.role).toBe('system');
    expect(v2.messages[0]?.content).toMatch(/older messages pruned/);

    // Last protected window + current user message are preserved.
    const tail = v2.messages.slice(-3).map(m => m.content);
    expect(tail).toContain('recent-user-2');
    expect(tail[tail.length - 1]).toBe('final player message');

    // Pruning actually dropped something.
    expect(v2.messages.length).toBeLessThan(history.length + 2); // +2 = placeholder + current user
  });

  it('is correctly gated by COVEL_PROMPT_V2: exact "1" selects V2, any other value keeps V1', () => {
    // V1 and V2 produce structurally different prompts when locale is set:
    // V1 appends locale at the tail, V2 prepends it in segment 1.
    const params = baselineParams({
      promptTemplate: 'Plugin body.',
      turnInput: makeTurnInput({ locale: 'zh-CN', playerMessage: 'go' }),
    });

    const v1Direct = buildContext({ ...params }); // no flag → V1
    expect(v1Direct.systemPrompt.startsWith('Plugin body.')).toBe(true);
    expect(v1Direct.systemPrompt.endsWith('in 中文.')).toBe(true);

    // Flag set to literal "1" → V2 path.
    process.env.COVEL_PROMPT_V2 = '1';
    const v2Gated = buildContext({ ...params });
    expect(v2Gated.systemPrompt.startsWith('[LANGUAGE]')).toBe(true);
    expect(v2Gated.systemPrompt).toContain('Plugin body.');

    // Any other truthy-ish value → still V1 (strict equality on "1").
    process.env.COVEL_PROMPT_V2 = 'true';
    const v1Again = buildContext({ ...params });
    expect(v1Again.systemPrompt).toBe(v1Direct.systemPrompt);

    process.env.COVEL_PROMPT_V2 = '0';
    const v1Zero = buildContext({ ...params });
    expect(v1Zero.systemPrompt).toBe(v1Direct.systemPrompt);
  });
});
