import { stripPromptCacheMarkers } from "@covel/shared";
import {
  withTextRequestDefaults,
  defaultToolChoice,
} from "./request-defaults.js";
import type { ModelProviderAdapter } from "./adapter.js";
import {
  assertGenerationPayload,
  assertStreamCompleted,
  assertSuccessfulFinishReason,
} from "./generation-completion.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  readOpenAiChatText,
  readOpenAiChatFinishReason,
  readOpenAiChatUsage,
  readOpenAiChatToolCalls,
  readOpenAiChatReasoningContent,
  readOpenAiChatStreamDelta,
  readOpenAiChatStreamReasoningDelta,
  readOpenAiChatStreamFinishReason,
  readOpenAiChatStreamToolCallDeltas,
} from "./http.js";
import { applyCapabilityFallback } from "./capability-fallback.js";
import {
  captureContinuation,
  continuationItems,
} from "./provider-continuation.js";
import {
  createThinkTagSplitter,
  joinReasoning,
  splitThinkTags,
} from "./think-tags.js";
import type { OpenAiChatReasoningField } from "./http/openai-readers.js";
import {
  openAiChatReasoningFields,
  reasoningRequestFields,
} from "../reasoning-effort.js";
import {
  createMetadataSanitizer,
  extractParameterOverrides,
  mediaRefFallbackText,
} from "./common.js";
import { readTokenCount } from "./usage.js";
import {
  readResponseDiagnostics,
  ResponseDiagnostics,
} from "./response-diagnostics.js";
import {
  objectResponseFormat,
  withResponseFormatInstruction,
} from "./structured-output.js";

import type {
  ModelRequestContext,
  ProviderConfig,
  TextMessage,
  TextMessageContent,
  ToolDefinition,
} from "../types.js";

/** Fields that providerRequestMetadata must never override. */
const OPENAI_PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "response_format",
  // `input` is protected for embeddings — it is built from params.values.
  "input",
  // Slot-level dispatch hints — consumed by the adapter, not forwarded.
  "embeddingFormat",
  // Slot-level generation params — translated by the adapter.
  "parameterOverrides",
  "reasoning_effort",
  "reasoningEffort",
]);

/** camelCase override key → OpenAI Chat wire field. */
const OPENAI_PARAMETER_FIELD_MAP = {
  temperature: "temperature",
  topP: "top_p",
  maxOutputTokens: "max_tokens",
  frequencyPenalty: "frequency_penalty",
  presencePenalty: "presence_penalty",
} as const;

const sanitizeOpenAiMetadata = createMetadataSanitizer(OPENAI_PROTECTED_KEYS);

function extractOpenAiParameterOverrides(
  meta: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  model: string,
): Record<string, unknown> {
  return {
    ...extractParameterOverrides(meta, {
      ...OPENAI_PARAMETER_FIELD_MAP,
      maxOutputTokens: /(?:^|\/)gpt-[5-9]|(?:^|\/)o[134](?:-|$)/i.test(model)
        ? "max_completion_tokens"
        : "max_tokens",
    }),
    ...reasoningRequestFields(
      openAiChatReasoningFields,
      meta,
      context,
      "openai-chat-v1",
      model,
    ),
  };
}

/**
 * Build the `input` field for a POST /embeddings request, dispatching on
 * the slot's declared embedding format.
 *
 * - "openai" (default): array of strings, per the OpenAI spec.
 * - "nemotron-multimodal": OpenRouter NVIDIA Nemotron multimodal shape
 *   where each element is `{content: [{type: "text", text}, ...]}`. Phase 1
 *   supports text parts only; adding image_url parts is a Phase 2 feature.
 */
function buildEmbeddingInput(values: string[], format: string): unknown {
  if (format === "nemotron-multimodal") {
    return values.map((text) => ({
      content: [{ type: "text", text }],
    }));
  }
  return values;
}

function serializeOpenAiChatContent(content: TextMessageContent): unknown {
  if (typeof content === "string") return stripPromptCacheMarkers(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text")
      return { type: "text", text: stripPromptCacheMarkers(part.text) };
    if (part.image.url) {
      return { type: "image_url", image_url: { url: part.image.url } };
    }
    return { type: "text", text: mediaRefFallbackText(part) };
  });
}

function isDeepSeekThinkingRequest(
  model: string,
  context: ModelRequestContext | undefined,
  body: Record<string, unknown>,
): boolean {
  const provider = (
    context?.preset?.provider ??
    context?.profile?.provider ??
    ""
  ).toLowerCase();
  const models = [model, context?.preset?.model, context?.profile?.model]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  const isDeepSeek =
    /(?:^|[-_/])deepseek(?:[-_/]|$)/.test(provider) ||
    models.some((candidate) =>
      /(?:^|[-_/])deepseek(?:[-_/]|$)/.test(candidate),
    );
  const defaultsToThinking = models.some((candidate) =>
    /(?:^|[-_/])deepseek-(?:v4(?:[-._/]|$)|flash(?:[-_/]|$))/.test(candidate),
  );
  const thinking = body.thinking;
  const thinkingType =
    thinking !== null &&
    typeof thinking === "object" &&
    (thinking as Record<string, unknown>).type;
  return (
    isDeepSeek &&
    (thinkingType === "enabled" || (!thinkingType && defaultsToThinking))
  );
}

function attachOpenAiTools(
  body: Record<string, unknown>,
  tools: ToolDefinition[] | undefined,
  model: string,
  context: ModelRequestContext | undefined,
  defaults: import("@covel/shared").LLMRequestDefaults | undefined,
): void {
  if (!tools || tools.length === 0) return;
  body.tools = tools;
  if (!isDeepSeekThinkingRequest(model, context, body)) {
    body.tool_choice ??= defaultToolChoice(defaults, body, "chat");
  }
}

const PROTOCOL = "openai-chat-v1";

/**
 * Remember a non-default reasoning field so a follow-up sent to the same
 * target echoes the trace under the field it arrived in.
 */
/**
 * Where a reply's reasoning came from: a wire field, or `think` for reasoning
 * the model wrote inline as `<think>…</think>`.
 */
type ReasoningSource = OpenAiChatReasoningField | "think";

function reasoningContinuation(
  field: ReasoningSource | undefined,
  model: string,
  config: ProviderConfig,
) {
  return field === "reasoning" || field === "think"
    ? captureContinuation(PROTOCOL, model, config, [
        { type: "reasoning", field },
      ])
    : undefined;
}

/**
 * The reasoning field is a property of the endpoint, not of one message, so
 * no provider list is needed: a request echoes reasoning under the field this
 * endpoint was seen to emit, else under the common `reasoning_content`.
 */
function endpointReasoningField(
  messages: readonly TextMessage[],
  model: string,
  config: ProviderConfig,
): OpenAiChatReasoningField {
  return messages.some((msg) =>
    continuationItems(msg, PROTOCOL, model, config)?.some(
      (item) => item.type === "reasoning" && item.field === "reasoning",
    ),
  )
    ? "reasoning"
    : "reasoning_content";
}

/**
 * Serialize TextMessage[] to OpenAI wire format.
 * Handles assistant messages with tool_calls and tool role messages.
 */
function serializeMessages(
  messages: TextMessage[],
  model: string,
  config: ProviderConfig,
): Record<string, unknown>[] {
  const field = endpointReasoningField(messages, model, config);
  return messages.map((msg) => {
    // Reasoning a model wrote inline is not sent back: models that think in
    // `<think>` blocks expect history to carry only their final replies.
    const inlineThink = continuationItems(msg, PROTOCOL, model, config)?.some(
      (item) => item.type === "reasoning" && item.field === "think",
    );
    const reasoning =
      msg.reasoningContent && !inlineThink
        ? { [field]: msg.reasoningContent }
        : {};
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: serializeOpenAiChatContent(msg.content) ?? "",
        ...reasoning,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (msg.role === "tool" && msg.toolCallId) {
      return {
        role: "tool",
        content: serializeOpenAiChatContent(msg.content),
        tool_call_id: msg.toolCallId,
      };
    }
    if (msg.role === "assistant" && msg.reasoningContent) {
      return {
        role: "assistant",
        content: serializeOpenAiChatContent(msg.content),
        ...reasoning,
      };
    }
    return { role: msg.role, content: serializeOpenAiChatContent(msg.content) };
  });
}

/**
 * OpenAI Chat Completions v1 adapter.
 * Works with any OpenAI-compatible API (DeepSeek, DashScope, etc.).
 */
export function createOpenAiChatAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params, context) {
      params = withTextRequestDefaults(params);
      const messages = applyCapabilityFallback(
        withResponseFormatInstruction(params.messages, params.responseFormat),
        context,
      );
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(messages, params.model, config),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      };
      attachOpenAiTools(
        body,
        params.tools,
        params.model,
        context,
        params.defaults,
      );
      if (params.responseFormat) {
        // json_object is the widest interoperable structured-output mode for
        // OpenAI-compatible endpoints (including Qwen/DeepSeek proxies). The
        // adapter also places the exact schema in the system prompt;
        // runtime validation remains the final contract gate.
        body.response_format = { type: "json_object" };
      }

      const response = await postJson(config, "/chat/completions", body);
      const payload = await parseJson(response);
      const diagnostics = readResponseDiagnostics(
        payload,
        "chat",
        "openai-chat",
      );
      assertSuccess(response, payload, "openai-chat");
      assertGenerationPayload(payload, "openai-chat");
      assertSuccessfulFinishReason(
        readOpenAiChatFinishReason(payload),
        "openai-chat",
      );

      const toolCalls = readOpenAiChatToolCalls(payload);
      const reasoning = readOpenAiChatReasoningContent(payload);
      const reply = splitThinkTags(readOpenAiChatText(payload));
      const reasoningContent = joinReasoning(reasoning?.text, reply.reasoning);
      const providerContinuation = reasoningContinuation(
        reasoning?.field ?? (reply.sawThink ? "think" : undefined),
        params.model,
        config,
      );
      return {
        ...(diagnostics ? { diagnostics } : {}),
        text: reply.text,
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
        ...(toolCalls ? { toolCalls } : {}),
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(providerContinuation ? { providerContinuation } : {}),
      };
    },

    async generateObject(config, params, context) {
      const messages = applyCapabilityFallback(
        withResponseFormatInstruction(
          params.messages,
          objectResponseFormat(params.schema, "openai-chat"),
        ),
        context,
      );
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(messages, params.model, config),
        response_format: { type: "json_object" },
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      });
      const payload = await parseJson(response);
      const diagnostics = readResponseDiagnostics(
        payload,
        "chat",
        "openai-chat",
      );
      assertSuccess(response, payload, "openai-chat");
      assertGenerationPayload(payload, "openai-chat");
      assertSuccessfulFinishReason(
        readOpenAiChatFinishReason(payload),
        "openai-chat",
      );

      const reply = splitThinkTags(readOpenAiChatText(payload));
      let rawObject: unknown;
      try {
        rawObject = JSON.parse(reply.text);
      } catch {
        throw createStructuredOutputError("openai-chat");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-chat");
      }

      return {
        ...(diagnostics ? { diagnostics } : {}),
        object: validation.data,
        reasoningContent: joinReasoning(
          readOpenAiChatReasoningContent(payload)?.text,
          reply.reasoning,
        ),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
      };
    },

    async *streamText(config, params, context) {
      params = withTextRequestDefaults(params);
      const messages = applyCapabilityFallback(
        withResponseFormatInstruction(params.messages, params.responseFormat),
        context,
      );
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(messages, params.model, config),
        stream: true,
        // OpenAI Chat only includes a final usage chunk when this option is
        // explicit. Compatible providers that support usage follow the same
        // shape; malformed/absent counters remain safely normalized to zero.
        stream_options: { include_usage: true },
        ...(params.responseFormat
          ? { response_format: { type: "json_object" } }
          : {}),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
        ...extractOpenAiParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      };
      attachOpenAiTools(
        body,
        params.tools,
        params.model,
        context,
        params.defaults,
      );
      const response = await postJson(config, "/chat/completions", body);

      // Check HTTP status before parsing SSE — a non-2xx response won't be SSE
      if (!response.ok) {
        const payload = await parseJson(response);
        readResponseDiagnostics(payload, "chat", "openai-chat");
        assertSuccess(response, payload, "openai-chat");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";
      let completed = false;
      let reasoningAcc = "";
      let reasoningWireField: OpenAiChatReasoningField | undefined;
      const thinkSplitter = createThinkTagSplitter();
      const replyParts = function* (
        parts: ReturnType<typeof thinkSplitter.push>,
      ) {
        for (const part of parts) {
          if (part.type === "reasoning") {
            reasoningAcc += part.text;
            yield {
              type: "reasoning-delta" as const,
              reasoningDelta: part.text,
            };
          } else {
            yield { type: "text-delta" as const, textDelta: part.text };
          }
        }
      };
      const diagnostics = new ResponseDiagnostics("chat");
      // Accumulate tool_call deltas by index across chunks.
      const toolCallAcc = new Map<
        number,
        { id: string | null; name: string | null; arguments: string }
      >();

      try {
        for await (const payload of iterateSsePayloads(response)) {
          diagnostics.push(payload);
          if (payload.error) diagnostics.assertNotRefused("openai-chat");
          assertGenerationPayload(payload, "openai-chat");
          const reasoning = readOpenAiChatStreamReasoningDelta(payload);
          if (reasoning) {
            reasoningAcc += reasoning.text;
            reasoningWireField ??= reasoning.field;
            yield { type: "reasoning-delta", reasoningDelta: reasoning.text };
          }

          const delta = readOpenAiChatStreamDelta(payload);
          if (delta) yield* replyParts(thinkSplitter.push(delta));

          const toolCallDeltas = readOpenAiChatStreamToolCallDeltas(payload);
          if (toolCallDeltas) {
            for (const tcd of toolCallDeltas) {
              const existing = toolCallAcc.get(tcd.index) ?? {
                id: null,
                name: null,
                arguments: "",
              };
              if (tcd.id) existing.id = tcd.id;
              if (tcd.name) existing.name = tcd.name;
              if (tcd.argumentsDelta) existing.arguments += tcd.argumentsDelta;
              toolCallAcc.set(tcd.index, existing);
              // The call is emitted whole at the end; until then this tells
              // the caller the model is still writing.
              if (tcd.argumentsDelta) yield { type: "tool-argument-delta" };
            }
          }

          if (payload.usage && typeof payload.usage === "object") {
            usage = readOpenAiChatUsage(payload);
          }

          const reason = readOpenAiChatStreamFinishReason(payload);
          if (reason) {
            finishReason = reason;
            completed = true;
          }
        }
      } catch (error) {
        diagnostics.assertNotRefused("openai-chat");
        throw error;
      }
      diagnostics.assertNotRefused("openai-chat");
      assertStreamCompleted(completed, "openai-chat");
      yield* replyParts(thinkSplitter.flush());

      // Emit accumulated tool calls before done.
      if (toolCallAcc.size > 0) {
        const sorted = [...toolCallAcc.entries()].sort((a, b) => a[0] - b[0]);
        for (const [, tc] of sorted) {
          if (!tc.id || !tc.name) continue;
          yield {
            type: "tool-call",
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments || "{}",
          };
        }
      }

      const providerContinuation = reasoningContinuation(
        reasoningWireField ?? (thinkSplitter.sawThink ? "think" : undefined),
        params.model,
        config,
      );
      yield {
        type: "done",
        ...(diagnostics.diagnostics()
          ? { diagnostics: diagnostics.diagnostics() }
          : {}),
        finishReason,
        usage,
        ...(reasoningAcc ? { reasoningContent: reasoningAcc } : {}),
        ...(providerContinuation ? { providerContinuation } : {}),
      };
    },

    async embed(config, params) {
      // Slot-level `embeddingFormat` (from llm.toml) is propagated here via
      // params.providerRequestMetadata.embeddingFormat. Default is the
      // standard OpenAI `input: string[]` shape. Custom formats wrap values
      // into provider-specific content shapes — mirrors the imageApi
      // dispatch pattern further below.
      const meta = params.providerRequestMetadata ?? {};
      const embeddingFormat =
        (meta.embeddingFormat as string | undefined) ?? "openai";

      const input = buildEmbeddingInput(params.values, embeddingFormat);

      const response = await postJson(config, "/embeddings", {
        model: params.model,
        input,
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const data = Array.isArray(payload.data) ? payload.data : [];
      return {
        embeddings: data.map(
          (entry: { embedding: number[] }) => entry.embedding,
        ),
        usage: {
          inputTokens: readTokenCount(
            (payload.usage as Record<string, unknown> | undefined)
              ?.prompt_tokens,
          ),
          outputTokens: 0,
        },
      };
    },
  };
}
