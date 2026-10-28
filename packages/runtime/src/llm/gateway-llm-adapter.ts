import { instructionLocaleFor, unifyFinishReason } from "@covel/shared";
import type {
  LLMImagePart,
  LLMProviderContinuation,
  LLMTextPart,
} from "@covel/shared";
import type { LLMProviderRequest } from "@covel/shared";
import type {
  LLMDiagnostics,
  LLMRequestBudget,
  LLMQueueStart,
} from "@covel/shared";
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
  LLMResponse,
  LLMResponseFormat,
  LLMRequestDefaults,
  LLMStreamEvent,
  LLMTargetIdentity,
  LLMToolDefinition,
  LLMUsageSummary,
} from "@covel/shared";

import type {
  SlotOverridesInput,
  CapabilityOverridePolicy,
  ProviderRelay,
} from "@covel/ai-provider";

interface GatewayTextInput {
  presetId?: string;
  instructionLocale?: "en" | "zh";
  messages: Array<{
    role: string;
    content: string | readonly (LLMTextPart | LLMImagePart)[] | null;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    toolCallId?: string;
    reasoningContent?: string;
    providerContinuation?: LLMProviderContinuation;
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
  defaults?: LLMRequestDefaults;
  promptCacheKey?: string;
}

interface GatewayTextOptions {
  relay?: ProviderRelay;
  apiKeys?: Record<string, string>;
  envApiKeys?: Record<string, string>;
  traceId?: string;
  signal?: AbortSignal;
  requestBudget?: LLMRequestBudget;
  onQueueStart?: LLMQueueStart;
  slotOverrides?: SlotOverridesInput;
  capabilityOverridePolicy?: CapabilityOverridePolicy;
  /** Request-hard generation limit; gateway applies it after metadata. */
  parameterOverrides?: { maxOutputTokens?: number };
  onTargetAttempt?: (target: LLMTargetIdentity) => void;
  onProviderRequest?: (request: LLMProviderRequest) => void;
}

/** The text-generation surface the runtime adapts from the gateway. */
export interface GatewayLike {
  resolveSlot(
    presetId: string | undefined,
    options?: {
      relay?: ProviderRelay;
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      fallbackTag?: string;
    },
  ): {
    provider: string;
    model: string;
    capability?: {
      contextWindow?: number;
      maxOutputTokens?: number;
      input?: readonly string[];
    };
    parameterOverrides?: { maxOutputTokens?: number };
  } | null;

  generateText(
    input: GatewayTextInput,
    options?: GatewayTextOptions,
  ): Promise<{
    text: string;
    finishReason: string;
    rawFinishReason?: string;
    usage: LLMUsageSummary;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    reasoningContent?: string;
    providerContinuation?: LLMProviderContinuation;
    diagnostics?: LLMDiagnostics;
  }>;

  streamText?(
    input: GatewayTextInput,
    options?: GatewayTextOptions,
  ): AsyncIterable<{
    type: string;
    textDelta?: string;
    reasoningDelta?: string;
    finishReason?: string;
    rawFinishReason?: string;
    id?: string;
    name?: string;
    arguments?: string;
    reasoningContent?: string;
    providerContinuation?: LLMProviderContinuation;
    usage?: LLMUsageSummary;
    diagnostics?: LLMDiagnostics;
  }>;
}

export interface GatewayAdapterConfig {
  /** Request-scoped browser transport for the player's local model endpoints. */
  readonly relay?: ProviderRelay;
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
  // Built once so every gateway call carries the same request-scoped options;
  // a new option cannot be dropped at one call site.
  const requestOptions = {
    apiKeys: config?.apiKeys,
    ...(config?.relay ? { relay: config.relay } : {}),
    ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
    ...(config?.slotOverrides ? { slotOverrides: config.slotOverrides } : {}),
    ...(config?.capabilityOverridePolicy
      ? { capabilityOverridePolicy: config.capabilityOverridePolicy }
      : {}),
  };
  const callOptions = (
    params: Parameters<LLMAdapter["generate"]>[0],
  ): GatewayTextOptions => ({
    ...requestOptions,
    traceId: config?.traceId,
    ...(params.maxOutputTokens !== undefined
      ? { parameterOverrides: { maxOutputTokens: params.maxOutputTokens } }
      : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.onQueueStart ? { onQueueStart: params.onQueueStart } : {}),
    ...(params.requestBudget ? { requestBudget: params.requestBudget } : {}),
    ...(params.onTargetAttempt
      ? { onTargetAttempt: params.onTargetAttempt }
      : {}),
    ...(params.onProviderRequest
      ? { onProviderRequest: params.onProviderRequest }
      : {}),
  });
  const resolveSlot = (slot?: string) => {
    try {
      return gateway.resolveSlot(slot, {
        ...requestOptions,
        fallbackTag: "text",
      });
    } catch {
      // Target identity only enriches telemetry. The actual generate/stream
      // call must retain its existing retry and paired error-trace path.
      return undefined;
    }
  };
  return {
    resolveTarget(slot) {
      const target = resolveSlot(slot);
      return target
        ? { provider: target.provider, model: target.model }
        : undefined;
    },
    // Protocol defaults are text only, so `image` is listed only for a model
    // the model table knows or the configuration declares.
    acceptsImageInput(slot) {
      return resolveSlot(slot)?.capability?.input?.includes("image") === true;
    },
    resolveBudget(slot) {
      const target = resolveSlot(slot);
      return target
        ? {
            ...target.capability,
            requestedMaxOutputTokens:
              target.parameterOverrides?.maxOutputTokens,
          }
        : undefined;
    },

    async generate(params): Promise<LLMResponse> {
      // Convert LLMToolDefinition[] → gateway ToolDefinition[]
      const tools = params.tools?.map(toGatewayTool);

      // Convert LLMMessage[] → gateway TextMessage[]
      const messages = toGatewayMessages(
        withResponseFormatInstruction(
          params.messages,
          params.responseFormat,
          params.locale,
        ),
      );

      const result = await gateway.generateText(
        {
          presetId: params.model ?? undefined,
          instructionLocale: instructionLocaleFor(params.locale),
          ...(params.defaults ? { defaults: params.defaults } : {}),
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          responseFormat: params.responseFormat,
          ...(params.promptCacheKey
            ? { promptCacheKey: params.promptCacheKey }
            : {}),
        },
        callOptions(params),
      );

      return {
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        content: result.text || null,
        toolCalls: (result.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        finishReason: unifyFinishReason(result.finishReason),
        ...(result.rawFinishReason
          ? { rawFinishReason: result.rawFinishReason }
          : {}),
        usage: result.usage,
        ...(result.providerContinuation
          ? { providerContinuation: result.providerContinuation }
          : {}),
        ...(result.reasoningContent
          ? { reasoningContent: result.reasoningContent }
          : {}),
      };
    },

    async *stream(params): AsyncIterable<LLMStreamEvent> {
      if (!gateway.streamText) {
        throw new Error("Gateway does not support streaming");
      }

      const messages = toGatewayMessages(
        withResponseFormatInstruction(
          params.messages,
          params.responseFormat,
          params.locale,
        ),
      );
      const tools = params.tools?.map(toGatewayTool);

      for await (const event of gateway.streamText(
        {
          presetId: params.model ?? undefined,
          instructionLocale: instructionLocaleFor(params.locale),
          ...(params.defaults ? { defaults: params.defaults } : {}),
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          responseFormat: params.responseFormat,
          ...(params.promptCacheKey
            ? { promptCacheKey: params.promptCacheKey }
            : {}),
        },
        callOptions(params),
      )) {
        if (event.type === "tool-argument-delta") {
          yield { type: "tool-argument-delta" as const };
        } else if (
          event.type === "text-delta" &&
          event.textDelta !== undefined
        ) {
          yield { type: "text-delta" as const, textDelta: event.textDelta };
        } else if (
          event.type === "reasoning-delta" &&
          event.reasoningDelta !== undefined
        ) {
          yield {
            type: "reasoning-delta",
            reasoningDelta: event.reasoningDelta,
          };
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
            ...(event.diagnostics ? { diagnostics: event.diagnostics } : {}),
            finishReason: event.finishReason ?? "stop",
            ...(event.rawFinishReason
              ? { rawFinishReason: event.rawFinishReason }
              : {}),
            ...(event.providerContinuation
              ? { providerContinuation: event.providerContinuation }
              : {}),
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
 * Keep the JSON Schema visible to every gateway-backed provider. Some endpoints using the
 * OpenAI API only support JSON mode rather than native strict
 * schemas; the provider wire hint guarantees JSON while this instruction
 * supplies the exact allowed fields that the runtime validates afterward.
 * It is appended to the system prompt, so it is in the instruction language
 * of the session locale.
 */
function withResponseFormatInstruction(
  messages: readonly LLMMessage[],
  responseFormat: LLMResponseFormat | undefined,
  locale: string | undefined,
): readonly LLMMessage[] {
  if (!responseFormat) return messages;
  const rule =
    instructionLocaleFor(locale) === "zh"
      ? "只返回完全符合下面这份 JSON Schema 的 JSON。不要添加 schema 不允许的属性。"
      : "Return only JSON that conforms exactly to the following JSON Schema. Do not add properties that the schema does not allow.";
  const instruction = `${rule}\n<response-format>${JSON.stringify(responseFormat.schema)}</response-format>`;
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
  messages: readonly import("@covel/shared").LLMMessage[],
) {
  return messages.map((msg) => ({
    role: msg.role,
    ...(msg.providerContinuation
      ? { providerContinuation: msg.providerContinuation }
      : {}),
    // A stored picture is inlined by the kernel before the call; a reference
    // that is still here has no bytes and is not sent.
    content:
      typeof msg.content === "string" || !msg.content
        ? msg.content
        : msg.content.filter(
            (part): part is LLMTextPart | LLMImagePart => part.type !== "media",
          ),
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
