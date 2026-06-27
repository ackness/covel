/**
 * LLM adapter — thin abstraction for calling language models.
 *
 * This is the canonical contract describing a single LLM call. It lives in
 * `@covel/shared` so that distribution-level consumers (e.g. `@covel/create`)
 * can depend on the call shape without pulling in the entire kernel via
 * `@covel/runtime`. Runtime re-exports these names for backward
 * compatibility; implementations can wrap `@covel/ai-provider`'s gateway or
 * provide mock responses for testing.
 */

import type { MediaRef } from "./media.js";

export interface LLMTextPart {
  readonly type: "text";
  readonly text: string;
}

export interface LLMImagePart {
  readonly type: "image";
  readonly image: MediaRef;
}

export type LLMContentPart = LLMTextPart | LLMImagePart;
export type LLMMessageContent = string | readonly LLMContentPart[];

export interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: LLMMessageContent;
  readonly toolCallId?: string;
  readonly name?: string;
  /** For assistant messages that include tool calls (OpenAI protocol requires this). */
  readonly toolCalls?: readonly LLMToolCall[];
  /**
   * Thinking-mode reasoning returned on a prior assistant turn. Must be
   * carried back on the follow-up request for providers that enforce
   * round-trip (DashScope Qwen, DeepSeek v4 thinking). See the
   * openai-chat adapter's `serializeMessages` for the wire mapping.
   */
  readonly reasoningContent?: string;
}

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string; // JSON string
}

export interface LLMResponse {
  readonly content: string | null;
  readonly toolCalls: readonly LLMToolCall[];
  readonly finishReason: "stop" | "tool_calls" | "length" | "error";
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  /**
   * Reasoning text emitted by providers in thinking mode. When present it
   * must be carried back on the assistant message for the next request in
   * a multi-turn tool loop.
   */
  readonly reasoningContent?: string;
}

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>; // JSON Schema
}

export interface LLMResponseFormat {
  readonly type: "json_schema";
  readonly schema: Readonly<Record<string, unknown>>;
}

export type LLMStreamEvent =
  | { readonly type: "text-delta"; readonly textDelta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "done";
      readonly finishReason: string;
      /** Accumulated reasoning_content emitted during the stream. */
      readonly reasoningContent?: string;
    };

export interface LLMAdapter {
  /**
   * Call the LLM with messages and optional tools.
   * The `model` parameter maps to a slot name (e.g., 'default', 'fast', 'balance').
   */
  generate(params: {
    readonly model?: string;
    readonly messages: readonly LLMMessage[];
    readonly tools?: readonly LLMToolDefinition[];
    readonly responseFormat?: LLMResponseFormat;
    /**
     * Abort the HTTP call when the signal fires. Required for timeouts —
     * turn-executor's `timeoutMs` is a loop guard; without this signal a
     * hung HTTP request will never unblock.
     */
    readonly signal?: AbortSignal;
  }): Promise<LLMResponse>;

  /**
   * Stream LLM output as an async iterable of events.
   * Optional — when not provided, callers should fall back to `generate()`.
   */
  stream?(params: {
    readonly model?: string;
    readonly messages: readonly LLMMessage[];
    readonly tools?: readonly LLMToolDefinition[];
    /** @see generate.signal */
    readonly signal?: AbortSignal;
  }): AsyncIterable<LLMStreamEvent>;
}
