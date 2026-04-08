/**
 * Bridge adapter: @covel/ai-provider gateway → LLMAdapter interface.
 *
 * This thin wrapper translates between the runtime's LLMAdapter interface
 * and the ai-provider gateway's generateText method, enabling support for
 * all configured providers (OpenAI, Anthropic, DeepSeek, Qwen, etc.)
 * through the unified slot/preset system.
 */

import type { LLMAdapter, LLMResponse, LLMToolDefinition } from './llm-adapter.js';

/**
 * Minimal gateway interface — only the parts we need.
 * Matches the shape returned by @covel/ai-provider's createGateway().
 */
export interface GatewayLike {
  generateText(
    input: {
      presetId?: string;
      messages: Array<{
        role: string;
        content: string | null;
        toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        toolCallId?: string;
      }>;
      tools?: Array<{
        type: 'function';
        function: { name: string; description?: string; parameters?: Record<string, unknown> };
      }>;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: { apiKeys?: Record<string, string>; traceId?: string },
  ): Promise<{
    text: string;
    finishReason: string;
    usage: { inputTokens: number; outputTokens: number };
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  }>;
}

export interface GatewayAdapterConfig {
  /** API keys from the request (e.g., from X-Provider-Keys header). */
  readonly apiKeys?: Record<string, string>;
  /** Trace ID for observability. */
  readonly traceId?: string;
}

/**
 * Create an LLMAdapter that delegates to the ai-provider gateway.
 *
 * The `model` parameter in generate() is treated as a slot/preset ID
 * (e.g., 'default', 'fast', 'ds', 'qwen'). If undefined, uses the
 * gateway's default slot.
 */
export function createGatewayAdapter(
  gateway: GatewayLike,
  config?: GatewayAdapterConfig,
): LLMAdapter {
  return {
    async generate(params): Promise<LLMResponse> {
      // Convert LLMToolDefinition[] → gateway ToolDefinition[]
      const tools = params.tools?.map(toGatewayTool);

      // Convert LLMMessage[] → gateway TextMessage[]
      const messages = params.messages.map((msg) => ({
        role: msg.role,
        content: msg.content,
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolCalls?.length ? { toolCalls: [...msg.toolCalls] } : {}),
      }));

      const result = await gateway.generateText(
        {
          presetId: params.model ?? undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        },
        {
          apiKeys: config?.apiKeys,
          traceId: config?.traceId,
        },
      );

      return {
        content: result.text || null,
        toolCalls: (result.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        finishReason: result.finishReason === 'tool_calls'
          ? 'tool_calls'
          : result.finishReason === 'length'
            ? 'length'
            : 'stop',
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        },
      };
    },
  };
}

function toGatewayTool(tool: LLMToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
