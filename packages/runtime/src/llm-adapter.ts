/**
 * LLM adapter — thin abstraction for calling language models.
 *
 * This is the interface that TurnExecutor uses. Implementations can wrap
 * @covel/ai-provider's gateway or provide mock responses for testing.
 */

export interface LLMMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolCallId?: string;
  readonly name?: string;
  /** For assistant messages that include tool calls (OpenAI protocol requires this). */
  readonly toolCalls?: readonly LLMToolCall[];
}

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // JSON string
}

export interface LLMResponse {
  readonly content: string | null;
  readonly toolCalls: readonly LLMToolCall[];
  readonly finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>; // JSON Schema
}

export interface LLMAdapter {
  /**
   * Call the LLM with messages and optional tools.
   * The `model` parameter maps to a slot name (e.g., 'default', 'fast', 'balance').
   */
  generate(params: {
    readonly model?: string;
    readonly messages: readonly LLMMessage[];
    readonly tools?: readonly LLMToolDefinition[];
    readonly responseFormat?: {
      readonly type: 'json_schema';
      readonly schema: Readonly<Record<string, unknown>>;
    };
  }): Promise<LLMResponse>;
}
