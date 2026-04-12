/**
 * Sprint 1 exit-criterion stress test — long session, 50 turns.
 *
 * Demonstrates the full context-budget chain end-to-end:
 *
 *   scripts/long-session-50turns.ts
 *     → @covel/ai-provider.estimateTokens  (real T1 tokenizer)
 *     → @covel/runtime.executeTurn          (threads estimator + budget through)
 *       → @covel/context.buildContext        (reads COVEL_CONTEXT_BUDGET_V1 gate)
 *         → @covel/context.applyBudget        (prunes oldest messages)
 *
 * Exit criterion:
 *   1. Every per-turn input token count ≤ maxInputTokens (hard upper bound)
 *   2. Average per-turn input token count ≤ 0.7 * maxInputTokens
 *   3. Pruning was triggered on AT LEAST one turn
 *   4. No executeTurn() call threw
 *
 * Run: pnpm stress:budget
 *   or: npx tsx scripts/long-session-50turns.ts
 *
 * Exits 0 on PASS, 1 on any assertion failure.
 *
 * IMPORTANT: This script is self-contained. It does NOT depend on any real
 * plugin — a synthetic narrator-like manifest is hand-rolled here so the
 * script continues to work even if real plugins are deleted, renamed, or
 * restructured. `packages/runtime/src/` is forbidden from importing
 * @covel/ai-provider (per the framework-plugin isolation rule), but scripts/
 * in the composition layer may freely import from both.
 */

// Set the feature flag BEFORE anything calls executeTurn.
// buildContext reads the env var lazily per call, so order only matters if
// something else in the import graph caches it — nothing does today.
process.env.COVEL_CONTEXT_BUDGET_V1 = '1';

import { estimateTokens } from '../packages/ai-provider/src/index.js';
import type { TokenEstimator } from '../packages/context/src/index.js';
import type { RuntimeManifest, TurnInput } from '../packages/shared/src/index.js';
import type { LoadedRuntime } from '../packages/plugin-loader/src/index.js';
import { executeTurn } from '../packages/runtime/src/index.js';
import type { TurnExecutorDeps } from '../packages/runtime/src/index.js';
import type {
  LLMAdapter,
  LLMResponse,
} from '../packages/runtime/src/llm-adapter.js';
import type { LLMMessage } from '../packages/runtime/src/llm-adapter.js';
import { createMemoryStore } from '../packages/store/src/index.js';

// ── Config ───────────────────────────────────────────────────────

const TURN_COUNT = 50;
const CONTEXT_BUDGET = {
  maxInputTokens: 4000,
  reservedForResponse: 500,
  protectLastUserTurns: 2,
} as const;
const SESSION_ID = 'stress-session';
const PLACEHOLDER_REGEX = /\[\.\.\. \d+ older messages pruned/;

// ~400 characters of fake narrative — enough to make history grow past the
// budget within ~15 turns at the configured 4000 token cap.
const NARRATIVE_400 =
  'You stand at the edge of the mist-wreathed moor. Black pines lean over ' +
  'the path, their needles hissing in the cold wind. Somewhere beyond the ' +
  'ridge, a bell tolls — once, twice, and then falls silent. The lantern at ' +
  'your belt sputters low but refuses to die. A cairn of dark stones marks ' +
  'the fork ahead, and from behind it drifts the faint, iron smell of old ' +
  'blood. Whatever is waiting out there has been waiting a very long time.';

// ── Estimator ────────────────────────────────────────────────────

const estimator: TokenEstimator = (text: string) =>
  estimateTokens(text, { family: 'openai' });

// ── Recording LLM ────────────────────────────────────────────────

/**
 * Minimal LLMAdapter that records the exact message array it was handed on
 * every call and always returns a fixed ~400-char narrative wrapped as JSON
 * (so turn-executor parses it as `{ narrativeOutput }`).
 *
 * We hand-roll this instead of extending @covel/plugin-test-utils.MockLLM
 * because we need deterministic per-call message capture for the
 * per-turn token accounting below.
 */
class RecordingLLM implements LLMAdapter {
  readonly calls: Array<{
    readonly messages: readonly LLMMessage[];
  }> = [];

  async generate(params: {
    readonly messages: readonly LLMMessage[];
  }): Promise<LLMResponse> {
    this.calls.push({ messages: params.messages });
    return {
      content: JSON.stringify({ narrativeOutput: NARRATIVE_400 }),
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

// ── Synthetic manifest + loaded runtime ──────────────────────────

const syntheticManifest: RuntimeManifest = {
  name: 'test-narrator',
  pluginId: 'test-narrator',
  description: 'Synthetic narrator for Sprint 1 stress test — no tools.',
  priority: 500,
  runtimeType: 'agent',
  outputKind: 'story',
};

const syntheticLoaded: LoadedRuntime = {
  manifest: syntheticManifest,
  promptTemplate:
    'You are narrating. Current message: {{ player.message }}. Keep it terse.',
  references: [],
};

// ── Per-turn accounting ──────────────────────────────────────────

interface TurnStats {
  readonly turnIndex: number;
  readonly inputTokens: number;
  readonly messageCount: number;
  readonly pruned: boolean;
}

function tokensForCall(messages: readonly LLMMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimator(m.content);
  }
  return total;
}

function callContainsPlaceholder(messages: readonly LLMMessage[]): boolean {
  for (const m of messages) {
    if (PLACEHOLDER_REGEX.test(m.content)) {
      return true;
    }
  }
  return false;
}

// ── Main ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const store = createMemoryStore();
  const llm = new RecordingLLM();

  const deps: TurnExecutorDeps = {
    loadRuntime: async () => syntheticLoaded,
    llm,
    getConfig: () => ({}),
    store,
    estimator,
    contextBudget: { ...CONTEXT_BUDGET },
  };

  const stats: TurnStats[] = [];

  for (let i = 0; i < TURN_COUNT; i++) {
    const turnInput: TurnInput = {
      sessionId: SESSION_ID,
      turnId: `turn-${i}`,
      playerMessage: `Move forward step ${i}`,
      locale: 'en',
    };

    const callsBefore = llm.calls.length;
    try {
      await executeTurn(turnInput, [syntheticManifest], deps);
    } catch (err) {
      console.error(`\nFAIL: executeTurn threw on turn ${i}:`, err);
      process.exit(1);
    }

    // Expect exactly one new LLM call per turn (synthetic manifest has no
    // tool loop, so the agent path calls generate() once).
    const callsAfter = llm.calls.length;
    if (callsAfter - callsBefore !== 1) {
      console.error(
        `\nFAIL: turn ${i} produced ${callsAfter - callsBefore} LLM calls (expected 1)`,
      );
      process.exit(1);
    }

    const call = llm.calls[callsAfter - 1]!;
    stats.push({
      turnIndex: i,
      inputTokens: tokensForCall(call.messages),
      messageCount: call.messages.length,
      pruned: callContainsPlaceholder(call.messages),
    });
  }

  // ── Assertions ───────────────────────────────────────────────

  const maxInput = Math.max(...stats.map((s) => s.inputTokens));
  const avgInput = Math.round(
    stats.reduce((acc, s) => acc + s.inputTokens, 0) / stats.length,
  );
  const avgThreshold = Math.floor(CONTEXT_BUDGET.maxInputTokens * 0.7);
  const prunedTurns = stats.filter((s) => s.pruned).length;

  const failures: string[] = [];

  if (maxInput > CONTEXT_BUDGET.maxInputTokens) {
    failures.push(
      `Max per-turn input ${maxInput} exceeds hard cap ${CONTEXT_BUDGET.maxInputTokens}`,
    );
  }
  if (avgInput > avgThreshold) {
    failures.push(
      `Average per-turn input ${avgInput} exceeds 0.7 * cap (${avgThreshold})`,
    );
  }
  if (prunedTurns < 1) {
    failures.push(
      `Pruning was never triggered across ${TURN_COUNT} turns — budget gate did not engage`,
    );
  }

  // ── Report ───────────────────────────────────────────────────

  const pct = Math.round((avgInput / CONTEXT_BUDGET.maxInputTokens) * 100);
  const status = failures.length === 0 ? 'PASS' : 'FAIL';

  console.log('');
  console.log(
    `Long-session stress (${TURN_COUNT} turns, budget ${CONTEXT_BUDGET.maxInputTokens} tokens)`,
  );
  console.log('-------------------------------------------------');
  console.log(`Max per-turn input: ${maxInput} tokens`);
  console.log(`Average:            ${avgInput} tokens (${pct}% of budget)`);
  console.log(`Pruning triggered:  ${prunedTurns}/${TURN_COUNT} turns`);
  console.log(`Status: ${status}`);

  if (failures.length > 0) {
    console.log('');
    for (const f of failures) {
      console.log(`  - ${f}`);
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unexpected failure:', err);
  process.exit(1);
});
