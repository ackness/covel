/**
 * Test data factories for common types.
 */

import type {
  InputSlot,
  JsonValue,
  TurnInput,
  RuntimeResult,
} from "@covel/shared";
import {
  STORY_CONTEXT_INPUT,
  type StoryContextItem,
  type StoryContextOmission,
  type StoryContextValue,
} from "@covel/plugin-handlers-utils";
import type { TriggerContext } from "@covel/runtime";

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
    sessionId: "sess-test",
    turnId: "turn-1",
    playerMessage: "开始游戏",
    origin: "player",
    // A session always has a locale. Without one the framework writes no
    // preamble, so a test would see a prompt that production never sends.
    locale: "zh-CN",
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
 * const ctx = makeTriggerContext({ turnNumber: 5, logicalTurn: 5 });
 * ```
 */
export function makeTriggerContext(
  overrides?: Partial<TriggerContext>,
): TriggerContext {
  return {
    sessionId: "sess-test",
    turnNumber: 1,
    logicalTurn: 1,
    triggerCount: 0,
    turnsSinceLastTrigger: 999,
    pendingEventTopics: [],
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
export function makeRuntimeResult(
  overrides?: Partial<RuntimeResult>,
): RuntimeResult {
  return {
    pluginId: "test-plugin",
    runtimeId: "test-rt",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    output: {},
    toolCalls: [],
    durationMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create the input slot a reader of the `story-context@1` kernel input gets,
 * for a function handler's `ctx.inputs`. Items keep the order given, as the
 * kernel's ranking would leave them; `priority` defaults to `normal` and
 * `source` to a placeholder provider.
 *
 * @example
 * ```typescript
 * const inputs = {
 *   context: storyContextSlot([{ title: "World time", content: "Dusk." }]),
 * };
 * ```
 */
export function storyContextSlot(
  items: readonly (Pick<StoryContextItem, "title" | "content"> &
    Partial<Pick<StoryContextItem, "priority" | "source">>)[],
  omitted: readonly StoryContextOmission[] = [],
): InputSlot {
  const value: StoryContextValue = {
    items: items.map((item) => ({
      title: item.title,
      content: item.content,
      priority: item.priority ?? "normal",
      source: item.source ?? {
        pluginId: "test-provider",
        runtimeId: "test-provider/context",
      },
    })),
    omitted: omitted.map((entry) => ({ ...entry })),
  };
  return {
    cardinality: "one",
    value: structuredClone(value) as unknown as JsonValue,
    source: {
      pluginId: "__kernel",
      runtimeId: STORY_CONTEXT_INPUT,
      resultId: "test-execution",
    },
  };
}
