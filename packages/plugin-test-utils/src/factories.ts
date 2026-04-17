/**
 * Test data factories for common types.
 */

import type { TurnInput, RuntimeResult } from '@covel/shared';
import type { TriggerContext } from '@covel/runtime';

/**
 * Create a `TurnInput` with sensible defaults for testing.
 *
 * @param overrides - Partial fields to override the defaults.
 * @returns A complete `TurnInput` object.
 *
 * @example
 * ```typescript
 * const input = makeTurnInput({ playerMessage: 'Attack the goblin' });
 * ```
 */
export function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: 'sess-test',
    turnId: 'turn-1',
    playerMessage: '开始游戏',
    ...overrides,
  };
}

/**
 * Create a `TriggerContext` with sensible defaults for testing.
 *
 * @param overrides - Partial fields to override the defaults.
 * @returns A complete `TriggerContext` object.
 *
 * @example
 * ```typescript
 * const ctx = makeTriggerContext({ turnNumber: 5, isManualTrigger: true });
 * ```
 */
export function makeTriggerContext(overrides?: Partial<TriggerContext>): TriggerContext {
  return {
    sessionId: 'sess-test',
    turnNumber: 1,
    triggerCount: 0,
    turnsSinceLastTrigger: 999,
    pendingEventTopics: [],
    hasUpstreamFailure: false,
    isManualTrigger: false,
    preGameCompleted: [],
    ...overrides,
  };
}

/**
 * Create a `RuntimeResult` with sensible defaults for testing.
 *
 * @param overrides - Partial fields to override the defaults.
 * @returns A complete `RuntimeResult` object.
 *
 * @example
 * ```typescript
 * const result = makeRuntimeResult({ status: 'failed', error: 'timeout' });
 * ```
 */
export function makeRuntimeResult(overrides?: Partial<RuntimeResult>): RuntimeResult {
  return {
    pluginId: 'test-plugin',
    runtimeId: 'test-rt',
    runId: 'run-1',
    turnId: 'turn-1',
    status: 'success',
    output: {},
    toolCalls: [],
    durationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
