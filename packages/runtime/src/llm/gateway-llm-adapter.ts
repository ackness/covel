import type { PluginLlmModelTarget } from "./model-resolver.js";
import { instructionLocaleFor, unifyFinishReason } from "@covel/shared";
import type {
  LLMImagePart,
  LLMProviderContinuation,
  LLMTextPart,
} from "@covel/shared";
import type { LLMProviderRequest } from "@covel/shared";
import type { LLMDiagnostics, LLMRequestBudget } from "@covel/shared";
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
} from "./llm-adapter.js";

/**
 * Minimal structural form of `@covel/ai-provider`'s `SlotOverridesInput`.
 * Duplicated here to keep `@covel/runtime` decoupled from the ai-provider
 * package (which already depends on `@covel/runtime`'s sibling).
 */
export interface SlotOverridesInput {
  slotBindings?: Record<string, import("@covel/shared").LlmModelBinding>;
  parameterOverrides?: Record<
    string,
    {
      temperature?: number;
      topP?: number;
      topK?: number;
      maxOutputTokens?: number;
      frequencyPenalty?: number;
      presencePenalty?: number;
      reasoningEffort?: import("@covel/shared").ReasoningEffort;
    }
  >;
  customPresets?: Array<{
    reasoningEffort?: import("@covel/shared").ReasoningEffort;
    id: string;
    name: string;
    provider: string;
    baseUrl?: string;
    model: string;
    /** A built-in protocol or a plugin's `<pluginId>/<wireId>`. */
    protocol?: string;
  }>;
  capabilityOverrides?: Record<
    string,
    {
      input?: Array<"text" | "image" | "audio" | "video" | "file">;
      output?: Array<
        "text" | "image" | "audio" | "video" | "embedding" | "evaluation"
      >;
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
    input: {
      presetId?: string;
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
    },
    options?: {
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      traceId?: string;
      signal?: AbortSignal;
      requestBudget?: LLMRequestBudget;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      /** Request-hard generation limit; gateway applies it after metadata. */
      parameterOverrides?: { maxOutputTokens?: number };
      onTargetAttempt?: (target: LLMTargetIdentity) => void;
      onProviderRequest?: (request: LLMProviderRequest) => void;
    },
  ): Promise<{
    text: string;
    finishReason: string;
    usage: LLMUsageSummary;
    toolCalls?: Array<{ id: string; name: string; arguments: string }>;
    reasoningContent?: string;
    providerContinuation?: LLMProviderContinuation;
    diagnostics?: LLMDiagnostics;
  }>;

  streamText?(
    input: {
      presetId?: string;
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
      providerRequestMetadata?: Record<string, unknown>;
      defaults?: LLMRequestDefaults;
      responseFormat?: LLMResponseFormat;
    },
    options?: {
      apiKeys?: Record<string, string>;
      envApiKeys?: Record<string, string>;
      traceId?: string;
      signal?: AbortSignal;
      requestBudget?: LLMRequestBudget;
      slotOverrides?: SlotOverridesInput;
      capabilityOverridePolicy?: CapabilityOverridePolicy;
      /** @see generateText options.parameterOverrides */
      parameterOverrides?: { maxOutputTokens?: number };
      onTargetAttempt?: (target: LLMTargetIdentity) => void;
      onProviderRequest?: (request: LLMProviderRequest) => void;
    },
  ): AsyncIterable<{
    type: string;
    textDelta?: string;
    reasoningDelta?: string;
    finishReason?: string;
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
  /** Complete plugin model preferences, shared with the runtime model resolver. */
  readonly modelTargets?: ReadonlyMap<string, PluginLlmModelTarget>;
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
  const resolveSlot = (slot?: string) => {
    const selection = resolveGatewayModelSelection(slot, config);
    try {
      return gateway.resolveSlot(selection.presetId, {
        apiKeys: config?.apiKeys,
        ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
        ...(selection.slotOverrides
          ? { slotOverrides: selection.slotOverrides }
          : {}),
        ...(config?.capabilityOverridePolicy
          ? { capabilityOverridePolicy: config.capabilityOverridePolicy }
          : {}),
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
      const selection = resolveGatewayModelSelection(
        params.model ?? undefined,
        config,
      );
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
          presetId: selection.presetId,
          ...(params.defaults ? { defaults: params.defaults } : {}),
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          responseFormat: params.responseFormat,
        },
        {
          apiKeys: config?.apiKeys,
          ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
          traceId: config?.traceId,
          ...(selection.slotOverrides
            ? { slotOverrides: selection.slotOverrides }
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
          ...(params.requestBudget
            ? { requestBudget: params.requestBudget }
            : {}),
          ...(params.onTargetAttempt
            ? { onTargetAttempt: params.onTargetAttempt }
            : {}),
          ...(params.onProviderRequest
            ? { onProviderRequest: params.onProviderRequest }
            : {}),
        },
      );

      return {
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        content: result.text || null,
        toolCalls: (result.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        })),
        finishReason: completedFinishReason(result.finishReason),
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
      const selection = resolveGatewayModelSelection(
        params.model ?? undefined,
        config,
      );
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
          presetId: selection.presetId,
          ...(params.defaults ? { defaults: params.defaults } : {}),
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          responseFormat: params.responseFormat,
        },
        {
          apiKeys: config?.apiKeys,
          ...(config?.envApiKeys ? { envApiKeys: config.envApiKeys } : {}),
          traceId: config?.traceId,
          ...(selection.slotOverrides
            ? { slotOverrides: selection.slotOverrides }
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
          ...(params.requestBudget
            ? { requestBudget: params.requestBudget }
            : {}),
          ...(params.onTargetAttempt
            ? { onTargetAttempt: params.onTargetAttempt }
            : {}),
          ...(params.onProviderRequest
            ? { onProviderRequest: params.onProviderRequest }
            : {}),
        },
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

/** Translate a plugin preference into the same isolated overlay used by request selections. */
export function resolveGatewayModelSelection(
  model: string | undefined,
  config?: Pick<GatewayAdapterConfig, "modelTargets" | "slotOverrides">,
): { presetId?: string; slotOverrides?: SlotOverridesInput } {
  const target = model ? config?.modelTargets?.get(model) : undefined;
  if (!target) return { presetId: model, slotOverrides: config?.slotOverrides };
  const overrides = config?.slotOverrides;
  // The role is retained for capability/parameter overrides and fallback policy.
  if (overrides?.slotBindings?.[target.role])
    return { presetId: target.role, slotOverrides: overrides };
  const protocol = target.protocol as NonNullable<
    SlotOverridesInput["customPresets"]
  >[number]["protocol"];
  return {
    presetId: target.role,
    slotOverrides: {
      ...overrides,
      customPresets: [
        ...(overrides?.customPresets ?? []),
        {
          id: model!,
          name: target.model,
          provider: target.provider,
          model: target.model,
          ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
          ...(protocol ? { protocol } : {}),
        },
      ],
      slotBindings: {
        ...overrides?.slotBindings,
        [target.role]: { modelRef: model! },
      },
    },
  };
}

/**
 * Keep the JSON Schema visible to every gateway-backed provider. Some OpenAI-
 * compatible endpoints only support JSON mode rather than native strict
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
  messages: readonly import("./llm-adapter.js").LLMMessage[],
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

/** A gateway of another origin may still answer in a provider's own word. */
function completedFinishReason(
  reason: string,
): "stop" | "tool_calls" | "length" {
  const unified = unifyFinishReason(reason);
  return unified === "tool_calls" || unified === "length" ? unified : "stop";
}
