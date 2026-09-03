/**
 * Bridge adapter: @covel/ai-provider gateway → LLMAdapter interface.
 *
 * This thin wrapper translates between the runtime's LLMAdapter interface
 * and the ai-provider gateway's generateText method, enabling support for
 * all configured providers (OpenAI, Anthropic, DeepSeek, Qwen, etc.)
 * through the unified slot/preset system.
 */

import type {
  LLMAdapter,
  LLMMessage,
  LLMMessageContent,
  LLMResponse,
  LLMResponseFormat,
  LLMStreamEvent,
  LLMTargetIdentity,
  LLMToolDefinition,
  LLMUsageSummary,
} from "./llm-adapter.js";

/**
 * Minimal structural form of `@covel/ai-provider`'s `SlotOverridesInput`.
 * Duplicated here to keep `@covel/runtime` decoupled from the ai-provider
 * package (which already depends on `@covel/runtime`'s sibling).
 */
export interface SlotOverridesInput {
  slotPresetOverrides?: Record<string, string>;
  parameterOverrides?: Record<
    string,
    {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxOutputTokens?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      reasoningEffort?:
        | "disabled"
        | "automatic"
        | "none"
        | "minimal"
        | "low"
        | "medium"
        | "high"
        | "xhigh"
        | "max";
    }
  >;
  customPresets?: Array<{
    id: string;
    name: string;
    provider: string;
    baseUrl?: string;
    model: string;
    protocol?:
      "openai-chat-v1" | "openai-responses-v1" | "anthropic-messages-v1";
  }>;
  capabilityOverrides?: Record<
    string,
    {
      input?: Array<"text" | "image" | "audio" | "video" | "file">;
      output?: Array<"text" | "image" | "audio" | "video" | "embedding">;
      features?: Array<
        | "function_calling"
        | "structured_output"
        | "streaming"
        | "reasoning"
        | "vision"
        | "prompt_caching"
        | "web_search"
        | "computer_use"
      >;
      contextWindow?: number;
      maxOutputTokens?: number;
    }
  >;
}

export type CapabilityOverridePolicy = "full" | "restrict-only";

/**
 * Minimal gateway interface — only the parts we need.
 * Matches the shape returned by @covel/ai-provider's createGateway().
 *
 * Intentionally NOT folded into the shared LLM-adapter contracts
 * (`LLMAdapter` / `SimpleCompletionAdapter` in `@covel/shared`): this is a
 * structural duck-type of the *ai-provider gateway* (provider-protocol shape:
 * `generateText` / `streamText`, `presetId`, OpenAI-style `function` tools),
 * declared here so `@covel/runtime` does not take a build/type dependency on
 * `@covel/ai-provider` (which already depends on runtime's sibling). It is the
 * thing `createGatewayAdapter` adapts *into* an `LLMAdapter`, not another copy
 * of the LLM-call contract — merging the two would re-couple the packages.
 */
export interface GatewayLike {
  resolveSlot(
    presetId: string | undefined,
    options?: {
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      fallbackTag?: string;
    },
  ): { provider: string; model: string } | null;

  generateText(
    input: {
      presetId?: string;
      messages: Array<{
        role: string;
        content: LLMMessageContent | null;
        toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        toolCallId?: string;
        reasoningContent?: string;
      }>;
      tools?: Array<{
        type: "function";
        function: {
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };
      }>;
      responseFormat?: LLMResponseFormat;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: {
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      traceId?: string;
      signal?: AbortSignal;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      /** Request-hard generation limit; gateway applies it after metadata. */
      parameterOverrides?: { maxOutputTokens?: number };
      onTargetAttempt?: (target: LLMTargetIdentity) => void;
    },
  ): Promise<{
    text: string;
    finishReason: string;
    usage: LLMUsageSummary;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    reasoningContent?: string;
  }>;

  streamText?(
    input: {
      presetId?: string;
      messages: Array<{
        role: string;
        content: LLMMessageContent | null;
        toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        toolCallId?: string;
        reasoningContent?: string;
      }>;
      tools?: Array<{
        type: "function";
        function: {
          name: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };
      }>;
      providerRequestMetadata?: Record<string, unknown>;
    },
    options?: {
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      traceId?: string;
      signal?: AbortSignal;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      /** @see generateText options.parameterOverrides */
      parameterOverrides?: { maxOutputTokens?: number };
      onTargetAttempt?: (target: LLMTargetIdentity) => void;
    },
  ): AsyncIterable<{
    type: string;
    textDelta?: string;
    finishReason?: string;
    id?: string;
    name?: string;
    arguments?: string;
    reasoningContent?: string;
    usage?: LLMUsageSummary;
  }>;
}

export interface GatewayAdapterConfig {
  /** API keys from the request (e.g., from X-Provider-Keys header). */
  readonly apiKeys?: Record<string, string>;
  /**
   * Server-env / platform API keys. The gateway only attaches these when
   * the resolved target's baseUrl origin matches trusted server config —
   * request-scoped custom presets never receive them.
   */
  readonly envApiKeys?: Record<string, string>;
  /** Trace ID for observability. */
  readonly traceId?: string;
  /**
   * Per-request slot/preset overlay forwarded to the gateway. Lets a
   * browser-only custom slot (e.g. `fast` → `custom_abc`) resolve to a
   * client-declared preset without needing a server-side llm.toml entry.
   */
  readonly slotOverrides?: SlotOverridesInput;
  /** Server-selected policy; never sourced from the client header. */
  readonly capabilityOverridePolicy?: CapabilityOverridePolicy;
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
    resolveTarget(slot) {
      try {
        const target = gateway.resolveSlot(slot, {
          apiKeys: config?.apiKeys,
          ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
          ...(config?.slotOverrides
            ? { slotOverrides: config.slotOverrides }
            : {}),
          ...(config?.capabilityOverridePolicy
            ? { capabilityOverridePolicy: config.capabilityOverridePolicy }
            : {}),
          fallbackTag: "text",
        });
        return target
          ? { provider: target.provider, model: target.model }
          : undefined;
      } catch {
        // Target identity only enriches telemetry. The actual generate/stream
        // call must retain its existing retry and paired error-trace path.
        return undefined;
      }
    },

    async generate(params): Promise<LLMResponse> {
      // Convert LLMToolDefinition[] → gateway ToolDefinition[]
      const tools = params.tools?.map(toGatewayTool);

      // Convert LLMMessage[] → gateway TextMessage[]
      const messages = toGatewayMessages(
        withResponseFormatInstruction(params.messages, params.responseFormat),
      );

      const result = await gateway.generateText(
        {
          presetId: params.model ?? undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          responseFormat: params.responseFormat,
        },
        {
          apiKeys: config?.apiKeys,
          ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
          traceId: config?.traceId,
          ...(config?.slotOverrides
            ? { slotOverrides: config.slotOverrides }
            : {}),
          ...(config?.capabilityOverridePolicy
            ? { capabilityOverridePolicy: config.capabilityOverridePolicy }
            : {}),
          ...(params.maxOutputTokens !== undefined
            ? {
                parameterOverrides: {
                  maxOutputTokens: params.maxOutputTokens,
                },
              }
            : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.onTargetAttempt
            ? { onTargetAttempt: params.onTargetAttempt }
            : {}),
        },
      );

      return {
        content: result.text || null,
        toolCalls: (result.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        finishReason:
          result.finishReason === "tool_calls"
            ? "tool_calls"
            : result.finishReason === "length"
              ? "length"
              : "stop",
        usage: result.usage,
        ...(result.reasoningContent
          ? { reasoningContent: result.reasoningContent }
          : {}),
      };
    },

    async *stream(params): AsyncIterable<LLMStreamEvent> {
      if (!gateway.streamText) {
        throw new Error("Gateway does not support streaming");
      }

      const messages = toGatewayMessages(params.messages);
      const tools = params.tools?.map(toGatewayTool);

      for await (const event of gateway.streamText(
        {
          presetId: params.model ?? undefined,
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
        },
        {
          apiKeys: config?.apiKeys,
          ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
          traceId: config?.traceId,
          ...(config?.slotOverrides
            ? { slotOverrides: config.slotOverrides }
            : {}),
          ...(config?.capabilityOverridePolicy
            ? { capabilityOverridePolicy: config.capabilityOverridePolicy }
            : {}),
          ...(params.maxOutputTokens !== undefined
            ? {
                parameterOverrides: {
                  maxOutputTokens: params.maxOutputTokens,
                },
              }
            : {}),
          ...(params.signal ? { signal: params.signal } : {}),
          ...(params.onTargetAttempt
            ? { onTargetAttempt: params.onTargetAttempt }
            : {}),
        },
      )) {
        if (event.type === "text-delta" && event.textDelta !== undefined) {
          yield { type: "text-delta" as const, textDelta: event.textDelta };
        } else if (event.type === "tool-call" && event.id && event.name) {
          yield {
            type: "tool-call" as const,
            id: event.id,
            name: event.name,
            arguments: event.arguments ?? "{}",
          };
        } else if (event.type === "done") {
          yield {
            type: "done" as const,
            finishReason: event.finishReason ?? "stop",
            ...(event.reasoningContent
              ? { reasoningContent: event.reasoningContent }
              : {}),
            ...(event.usage ? { usage: event.usage } : {}),
          };
        }
      }
    },
  };
}

/**
 * Keep the JSON Schema visible to every gateway-backed provider. Some OpenAI-
 * compatible endpoints only support JSON mode rather than native strict
 * schemas; the provider wire hint guarantees JSON while this instruction
 * supplies the exact allowed fields that the runtime validates afterward.
 */
function withResponseFormatInstruction(
  messages: readonly LLMMessage[],
  responseFormat: LLMResponseFormat | undefined,
): readonly LLMMessage[] {
  if (!responseFormat) return messages;
  const instruction =
    "Return only JSON that conforms exactly to the following JSON Schema. " +
    "Do not add properties that the schema does not allow.\n" +
    `<response-format>${JSON.stringify(responseFormat.schema)}</response-format>`;
  const systemIndex = messages.findIndex(
    (message) => message.role === "system",
  );

  if (systemIndex < 0) {
    return [{ role: "system", content: instruction }, ...messages];
  }

  return messages.map((message, index) => {
    if (index !== systemIndex) return message;
    const content =
      typeof message.content === "string"
        ? `${message.content}\n\n${instruction}`
        : [
            ...message.content,
            { type: "text" as const, text: `\n\n${instruction}` },
          ];
    return { ...message, content };
  });
}

function toGatewayMessages(
  messages: readonly import("./llm-adapter.js").LLMMessage[],
) {
  return messages.map((msg) => ({
    role: msg.role,
    content: msg.content,
    ...(msg.name ? { name: msg.name } : {}),
    ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
    ...(msg.toolCalls?.length ? { toolCalls: [...msg.toolCalls] } : {}),
    ...(msg.reasoningContent ? { reasoningContent: msg.reasoningContent } : {}),
  }));
}

function toGatewayTool(tool: LLMToolDefinition) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
