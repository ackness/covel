/**
 * MockLLM — configurable mock LLM adapter for plugin testing.
 *
 * Records all calls for assertion. Supports custom default response
 * and per-call response overrides via `nextResponses` queue.
 */

import type { LLMAdapter, LLMAdapterMessage, LLMResponse } from '@covel/runtime';

/**
 * Configurable mock LLM adapter for plugin testing.
 *
 * Records all `generate()` calls in the `calls` array for assertion.
 * Responds with `defaultResponse` on every call (override via constructor).
 *
 * @example
 * ```typescript
 * import { MockLLM } from '@covel/plugin-test-utils';
 *
 * const llm = new MockLLM({
 *   defaultResponse: {
 *     content: '{"narrativeOutput": "The dragon roars!"}',
 *     toolCalls: [],
 *     finishReason: 'stop',
 *     usage: { inputTokens: 100, outputTokens: 50 },
 *   },
 * });
 *
 * // Use in a test harness or pass to executeTurn deps
 * const response = await llm.generate({ messages: [{ role: 'user', content: 'Hello' }] });
 * expect(llm.calls).toHaveLength(1);
 * ```
 */
export class MockLLM implements LLMAdapter {
  calls: Array<{ messages: readonly LLMAdapterMessage[] }> = [];
  defaultResponse: LLMResponse;

  /**
   * Create a new MockLLM instance.
   *
   * @param config - Optional configuration with a custom default LLM response.
   */
  constructor(config?: { defaultResponse?: LLMResponse }) {
    this.defaultResponse = config?.defaultResponse ?? {
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  async generate(
    params: Parameters<LLMAdapter['generate']>[0],
  ): Promise<LLMResponse> {
    this.calls.push({ messages: params.messages });
    return this.defaultResponse;
  }
}
