/**
 * MockLLM — configurable mock LLM adapter for plugin testing.
 *
 * Records all calls for assertion. Supports a default response, a scripted
 * `responses[]` queue (consumed in order, falls back to `defaultResponse`
 * once exhausted), and optional message capture for prompt inspection.
 */

import type {
  LLMAdapter,
  LLMAdapterMessage,
  LLMResponse,
  LLMToolDefinition,
} from '@covel/runtime';

type LLMResponseFormat = NonNullable<
  Parameters<LLMAdapter['generate']>[0]['responseFormat']
>;

export interface MockLLMCall {
  /** Zero-based index of this generate() invocation. */
  readonly callIndex: number;
  /** Captured prompt messages. Empty when `captureMessages` is `false`. */
  readonly messages: readonly LLMAdapterMessage[];
  readonly model?: string;
  readonly toolNames?: readonly string[];
  readonly responseFormat?: LLMResponseFormat;
}

export interface MockLLMConfig {
  /** Returned when the scripted `responses` queue is empty. */
  readonly defaultResponse?: LLMResponse;
  /** Scripted responses, consumed in order; subsequent calls reuse `defaultResponse`. */
  readonly responses?: readonly LLMResponse[];
  /** Whether to record prompt messages on each call. Defaults to `true`. */
  readonly captureMessages?: boolean;
}

/**
 * Configurable mock LLM adapter for plugin testing.
 *
 * Records each `generate()` invocation in `calls` for assertion. Replays
 * `responses` in order when provided, then falls back to `defaultResponse`.
 *
 * @example
 * ```typescript
 * import { MockLLM } from '@covel/plugin-test-utils';
 *
 * // single default response
 * const llm = new MockLLM({
 *   defaultResponse: {
 *     content: '{"narrativeOutput": "The dragon roars!"}',
 *     toolCalls: [],
 *     finishReason: 'stop',
 *     usage: { inputTokens: 100, outputTokens: 50 },
 *   },
 * });
 *
 * // scripted multi-call sequence
 * const scripted = new MockLLM({
 *   responses: [
 *     { content: 'pick-a-tool', toolCalls: [{ id: 't1', name: 'create-form', arguments: '{}' }], finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 } },
 *     { content: 'done', toolCalls: [], finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 3 } },
 *   ],
 * });
 * ```
 */
export class MockLLM implements LLMAdapter {
  readonly calls: MockLLMCall[] = [];
  defaultResponse: LLMResponse;
  private readonly responses: readonly LLMResponse[];
  private nextResponseIndex = 0;
  private readonly captureMessages: boolean;

  constructor(config?: MockLLMConfig) {
    this.defaultResponse = config?.defaultResponse ?? {
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
    this.responses = config?.responses ?? [];
    this.captureMessages = config?.captureMessages ?? true;
  }

  async generate(
    params: Parameters<LLMAdapter['generate']>[0],
  ): Promise<LLMResponse> {
    const call: MockLLMCall = {
      callIndex: this.calls.length,
      messages: this.captureMessages ? params.messages : [],
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.tools
        ? { toolNames: params.tools.map((t: LLMToolDefinition) => t.name) }
        : {}),
      ...(params.responseFormat !== undefined
        ? { responseFormat: params.responseFormat }
        : {}),
    };
    this.calls.push(call);

    if (this.nextResponseIndex < this.responses.length) {
      const response = this.responses[this.nextResponseIndex]!;
      this.nextResponseIndex += 1;
      return response;
    }
    return this.defaultResponse;
  }
}
