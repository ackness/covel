import {
  captureContinuation,
  continuationItems,
} from "./provider-continuation.js";
import {
  createThinkTagSplitter,
  joinReasoning,
  splitThinkTags,
} from "./think-tags.js";
import type { ProviderConfig } from "../types.js";
import {
  readResponsesReasoning,
  ResponsesReasoningAccumulator,
} from "./http/reasoning-readers.js";
import { stripPromptCacheMarkers, type LLMResponseFormat } from "@covel/shared";
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
  readOpenAiResponsesUsage,
  readResponsesOutputText,
  readResponsesStreamFunctionCallAdded,
  readResponsesStreamFunctionCallArgsDelta,
  readResponsesStreamFunctionCallArgsDone,
} from "./http.js";
import { applyCapabilityFallback } from "./capability-fallback.js";
import {
  openAiResponsesReasoningFields,
  reasoningRequestFields,
} from "../reasoning-effort.js";
import { createOpenAiChatAdapter } from "./openai-chat.js";
import { objectResponseFormat } from "./structured-output.js";
import { openAiPromptCacheKeyField } from "./prompt-cache-key.js";
import {
  readResponseDiagnostics,
  ResponseDiagnostics,
} from "./response-diagnostics.js";
import {
  createMetadataSanitizer,
  extractParameterOverrides,
  IMAGE_PLACEHOLDER_TEXT,
  imagePartUrl,
  lateSystemMessagesAsUser,
} from "./common.js";
import type {
  ModelRequestContext,
  TextMessage,
  TextMessageContent,
  ToolDefinition,
} from "../types.js";

/** Fields that providerRequestMetadata must never override. */
const RESPONSES_PROTECTED_KEYS = new Set([
  "model",
  "input",
  "stream",
  "text",
  "tools",
  "tool_choice",
  "promptCacheKey",
  "parameterOverrides",
  "reasoning_effort",
  "reasoningEffort",
]);

/** camelCase override key → OpenAI Responses wire field. */
const RESPONSES_PARAMETER_FIELD_MAP = {
  temperature: "temperature",
  topP: "top_p",
  maxOutputTokens: "max_output_tokens",
} as const;

const sanitizeResponsesMetadata = createMetadataSanitizer(
  RESPONSES_PROTECTED_KEYS,
);

function toResponsesJsonSchema(
  responseFormat: LLMResponseFormat,
): Record<string, unknown> {
  const rawName =
    typeof responseFormat.schema.title === "string"
      ? responseFormat.schema.title
      : typeof responseFormat.schema.$id === "string"
        ? responseFormat.schema.$id
        : "structured_output";
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return {
    type: "json_schema",
    name: name || "structured_output",
    schema: responseFormat.schema,
  };
}

function extractResponsesParameterOverrides(
  meta: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  model: string,
): Record<string, unknown> {
  const fields = {
    ...extractParameterOverrides(meta, RESPONSES_PARAMETER_FIELD_MAP),
    ...reasoningRequestFields(
      openAiResponsesReasoningFields,
      meta,
      context,
      "openai-responses-v1",
      model,
    ),
  };
  const knownReasoningModel = /(?:^|[/])(?:gpt-5|o[34](?:-|$))/.test(
    model.toLowerCase(),
  );
  const reasoning =
    fields.reasoning ?? sanitizeResponsesMetadata(meta).reasoning;
  const options =
    reasoning && typeof reasoning === "object" && !Array.isArray(reasoning)
      ? (reasoning as Record<string, unknown>)
      : {};
  if (knownReasoningModel && options.effort !== "none") {
    fields.reasoning = { summary: "auto", ...options };
  }
  return fields;
}

/**
 * Map OpenAI Responses API `status` field to a finish reason string.
 * The Responses API uses: "completed", "failed", "incomplete", "in_progress".
 */
function mapResponseStatus(status: unknown): string {
  switch (status) {
    case "completed":
      return "stop";
    case "incomplete":
      return "length";
    case "failed":
      return "error";
    default:
      return "error";
  }
}

function terminalResponseStatus(eventType: unknown): string | undefined {
  switch (eventType) {
    case "response.completed":
      return "completed";
    case "response.incomplete":
      return "incomplete";
    case "response.failed":
      return "failed";
    default:
      return undefined;
  }
}

function serializeResponsesContent(content: TextMessageContent): unknown {
  if (typeof content === "string") return stripPromptCacheMarkers(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text")
      return { type: "input_text", text: stripPromptCacheMarkers(part.text) };
    return { type: "input_image", image_url: imagePartUrl(part) };
  });
}

/**
 * Flatten message content down to a plain string. Used for tool results,
 * which the Responses API carries as a `function_call_output.output` string
 * rather than a structured content array.
 */
function responsesContentToText(content: TextMessageContent): string {
  if (content == null) return "";
  if (typeof content === "string") return stripPromptCacheMarkers(content);
  return content
    .map((part) =>
      part.type === "text"
        ? stripPromptCacheMarkers(part.text)
        : IMAGE_PLACEHOLDER_TEXT,
    )
    .join("");
}

/**
 * Serialize TextMessage[] into the Responses API `input` array.
 *
 * Most messages map to `{ role, content }`. Tool-loop messages are
 * different: the Responses API does not accept Chat-style `role: "tool"`
 * messages or assistant `tool_calls`. Instead it expects standalone input
 * items — `function_call` (the assistant's request, keyed by `call_id`) and
 * `function_call_output` (the result, keyed by the same `call_id`). Without
 * this round-trip the multi-turn tool loop breaks on the follow-up turn.
 */
function serializeResponsesInput(
  messages: TextMessage[],
  model: string,
  config: ProviderConfig,
  stateless: boolean,
): unknown[] {
  const items: unknown[] = [];
  for (const msg of lateSystemMessagesAsUser(messages)) {
    const native = continuationItems(msg, "openai-responses-v1", model, config);
    if (native) {
      items.push(...(stateless ? statelessReplayItems(native) : native));
      continue;
    }
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      const text = responsesContentToText(msg.content);
      if (text.length > 0) {
        items.push({
          role: "assistant",
          content: serializeResponsesContent(msg.content),
        });
      }
      for (const tc of msg.toolCalls) {
        items.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }
      continue;
    }
    if (msg.role === "tool" && msg.toolCallId) {
      items.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: responsesContentToText(msg.content),
      });
      continue;
    }
    items.push({
      role: msg.role,
      content: serializeResponsesContent(msg.content),
    });
  }
  return items;
}

const ENCRYPTED_REASONING = "reasoning.encrypted_content";

/**
 * Endpoints (base URL and model) that refused `include:
 * ["reasoning.encrypted_content"]`. Later requests leave it out instead of
 * failing once more on every call.
 */
const encryptedReasoningRefused = new Set<string>();

function endpointKey(config: ProviderConfig, model: unknown): string {
  return `${config.baseUrl}\n${String(model)}`;
}

/**
 * Output items of an earlier response, for a request the provider does not
 * store. The provider cannot find a reasoning item by its ID then, so a
 * reasoning item goes back only with its `encrypted_content`. When one cannot
 * be carried it is left out, and the other items go back without their IDs: an
 * ID would point at an item the provider never kept.
 */
function statelessReplayItems(
  items: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  const carried = items.filter(
    (item) =>
      item.type !== "reasoning" ||
      (typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0),
  );
  if (carried.length === items.length) return items;
  return carried.map(({ id: _id, ...item }) => item);
}

/**
 * The fields every Responses request shares. `store` is `false` unless the
 * slot sets it: the provider then keeps neither the prompt nor the reply, and
 * a tool loop carries reasoning between its calls as `encrypted_content`.
 */
function responsesRequestBody(
  config: ProviderConfig,
  params: {
    model: string;
    promptCacheKey?: string;
    providerRequestMetadata?: Record<string, unknown>;
  },
  messages: TextMessage[],
  context: ModelRequestContext | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    store: false,
    ...openAiPromptCacheKeyField(config, params),
    ...sanitizeResponsesMetadata(params.providerRequestMetadata),
    ...extractResponsesParameterOverrides(
      params.providerRequestMetadata,
      context,
      params.model,
    ),
  };
  const stateless = body.store !== true;
  const reasoning = body.reasoning as { effort?: unknown } | null | undefined;
  if (
    stateless &&
    reasoning?.effort !== "none" &&
    !encryptedReasoningRefused.has(endpointKey(config, params.model))
  ) {
    body.include = [
      ...new Set([
        ...(Array.isArray(body.include) ? body.include : []),
        ENCRYPTED_REASONING,
      ]),
    ];
  }
  body.input = serializeResponsesInput(
    messages,
    params.model,
    config,
    stateless,
  );
  return body;
}

/** True when a 400 response says the model does not take encrypted reasoning. */
async function refusesEncryptedReasoning(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const payload = (await response.clone().json()) as {
      error?: { param?: unknown; message?: unknown };
      message?: unknown;
    };
    const message = payload.error?.message ?? payload.message;
    return (
      payload.error?.param === "include" ||
      (typeof message === "string" && /encrypted[ _]content/i.test(message))
    );
  } catch {
    return false;
  }
}

/**
 * Send a Responses request. A model without reasoning rejects the request for
 * encrypted reasoning; the request is then sent once more without it, and the
 * reasoning items of this endpoint are left out of later replays.
 */
async function postResponses(
  config: ProviderConfig,
  body: Record<string, unknown>,
): Promise<Response> {
  const response = await postJson(config, "/responses", body);
  const include = Array.isArray(body.include) ? body.include : [];
  if (
    !include.includes(ENCRYPTED_REASONING) ||
    !(await refusesEncryptedReasoning(response))
  )
    return response;
  const { include: _include, ...rest } = body;
  const kept = include.filter((entry) => entry !== ENCRYPTED_REASONING);
  const retried = await postJson(config, "/responses", {
    ...rest,
    ...(kept.length ? { include: kept } : {}),
  });
  // Remembered only when leaving it out was what the endpoint wanted.
  if (retried.ok)
    encryptedReasoningRefused.add(endpointKey(config, body.model));
  return retried;
}

/**
 * Convert Chat-style `ToolDefinition[]` into the Responses API tool shape.
 * The Responses API flattens the `function` envelope: `name`, `description`,
 * and `parameters` live at the top level of each tool object.
 *
 * `strict: false` is explicit: the Responses API treats a function tool as
 * strict when the field is absent (Chat does the opposite), and a strict
 * schema makes every optional property required, so the model fills each one
 * with an empty value that the tool then rejects.
 */
function serializeResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    parameters: tool.function.parameters ?? {},
    strict: false,
  }));
}

/**
 * OpenAI Responses v1 adapter.
 * Uses the /responses endpoint with different streaming format.
 * Falls back to OpenAI Chat adapter for non-text operations.
 */
function readResponseToolCalls(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.output)) return [];
  return payload.output.flatMap((item: unknown) => {
    if (item === null || typeof item !== "object") return [];
    const call = item as Record<string, unknown>;
    return call.type === "function_call" &&
      typeof call.call_id === "string" &&
      typeof call.name === "string" &&
      typeof call.arguments === "string"
      ? [{ id: call.call_id, name: call.name, arguments: call.arguments }]
      : [];
  });
}

export function createOpenAiResponsesAdapter(): ModelProviderAdapter {
  const chatAdapter = createOpenAiChatAdapter();

  return {
    async generateText(config, params, context) {
      params = withTextRequestDefaults(params);
      const messages = applyCapabilityFallback(params.messages, context);
      const body = responsesRequestBody(config, params, messages, context);
      if (params.responseFormat)
        body.text = { format: toResponsesJsonSchema(params.responseFormat) };
      if (params.tools?.length) {
        body.tools = serializeResponsesTools(params.tools);
        body.tool_choice = defaultToolChoice(
          params.defaults,
          body,
          "responses",
        );
      }
      const response = await postResponses(config, body);
      const payload = await parseJson(response);
      const diagnostics = readResponseDiagnostics(
        payload,
        "responses",
        "openai-responses",
      );
      assertSuccess(response, payload, "openai-responses");
      assertGenerationPayload(payload, "openai-responses");
      assertSuccessfulFinishReason(
        mapResponseStatus(payload.status),
        "openai-responses",
      );

      const reply = splitThinkTags(readResponsesOutputText(payload));
      return {
        ...(diagnostics ? { diagnostics } : {}),
        text: reply.text,
        finishReason: mapResponseStatus(payload.status),
        usage: readOpenAiResponsesUsage(payload),
        reasoningContent: joinReasoning(
          readResponsesReasoning(payload),
          reply.reasoning,
        ),
        providerContinuation: captureContinuation(
          "openai-responses-v1",
          params.model,
          config,
          payload.output,
        ),
        toolCalls: readResponseToolCalls(payload),
      };
    },

    async generateObject(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const response = await postResponses(config, {
        ...responsesRequestBody(config, params, messages, context),
        text: {
          format: toResponsesJsonSchema(
            objectResponseFormat(params.schema, "openai-responses"),
          ),
        },
      });
      const payload = await parseJson(response);
      const diagnostics = readResponseDiagnostics(
        payload,
        "responses",
        "openai-responses",
      );
      assertSuccess(response, payload, "openai-responses");
      assertGenerationPayload(payload, "openai-responses");
      assertSuccessfulFinishReason(
        mapResponseStatus(payload.status),
        "openai-responses",
      );

      const reply = splitThinkTags(readResponsesOutputText(payload));
      let rawObject: unknown;
      try {
        rawObject = JSON.parse(reply.text);
      } catch {
        throw createStructuredOutputError(
          "openai-responses",
          readOpenAiResponsesUsage(payload),
        );
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError(
          "openai-responses",
          readOpenAiResponsesUsage(payload),
        );
      }

      return {
        ...(diagnostics ? { diagnostics } : {}),
        object: validation.data,
        finishReason: mapResponseStatus(payload.status),
        usage: readOpenAiResponsesUsage(payload),
        reasoningContent: joinReasoning(
          readResponsesReasoning(payload),
          reply.reasoning,
        ),
        providerContinuation: captureContinuation(
          "openai-responses-v1",
          params.model,
          config,
          payload.output,
        ),
      };
    },

    async *streamText(config, params, context) {
      params = withTextRequestDefaults(params);
      const messages = applyCapabilityFallback(params.messages, context);
      const body = responsesRequestBody(config, params, messages, context);
      body.stream = true;
      if (params.responseFormat)
        body.text = { format: toResponsesJsonSchema(params.responseFormat) };
      if (params.tools && params.tools.length > 0) {
        body.tools = serializeResponsesTools(params.tools);
        body.tool_choice = defaultToolChoice(
          params.defaults,
          body,
          "responses",
        );
      }
      const response = await postResponses(config, body);

      if (!response.ok) {
        const payload = await parseJson(response);
        readResponseDiagnostics(payload, "responses", "openai-responses");
        assertSuccess(response, payload, "openai-responses");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let streamFinishReason = "stop";
      let completed = false;
      const reasoning = new ResponsesReasoningAccumulator();
      const thinkSplitter = createThinkTagSplitter();
      let thinkReasoning = "";
      const replyParts = function* (
        parts: ReturnType<typeof thinkSplitter.push>,
      ) {
        for (const part of parts) {
          if (part.type === "reasoning") {
            thinkReasoning += part.text;
            yield {
              type: "reasoning-delta" as const,
              reasoningDelta: part.text,
            };
          } else {
            yield { type: "text-delta" as const, textDelta: part.text };
          }
        }
      };
      const diagnostics = new ResponseDiagnostics("responses");
      const outputItems = new Map<number, unknown>();
      let completedOutput: unknown;
      // Accumulate streaming function-call items keyed by the Responses item
      // id. Insertion order (first `output_item.added`) drives emission order.
      const toolCallAcc = new Map<
        string,
        { callId: string | null; name: string | null; arguments: string }
      >();

      try {
        for await (const payload of iterateSsePayloads(response)) {
          diagnostics.push(payload);
          if (payload.error || payload.type === "response.failed")
            diagnostics.assertNotRefused("openai-responses");
          assertGenerationPayload(payload, "openai-responses");
          if (payload.type === "response.output_item.done")
            outputItems.set(Number(payload.output_index ?? 0), payload.item);
          const reasoningDelta = reasoning.push(payload);
          if (reasoningDelta) yield { type: "reasoning-delta", reasoningDelta };
          if (
            payload.type === "response.output_text.delta" &&
            typeof payload.delta === "string"
          ) {
            yield* replyParts(thinkSplitter.push(payload.delta as string));
          }

          const added = readResponsesStreamFunctionCallAdded(payload);
          if (added) {
            const existing = toolCallAcc.get(added.id);
            toolCallAcc.set(added.id, {
              callId: added.callId ?? existing?.callId ?? null,
              name: added.name ?? existing?.name ?? null,
              arguments: added.arguments || existing?.arguments || "",
            });
          }

          const argsDelta = readResponsesStreamFunctionCallArgsDelta(payload);
          if (argsDelta) {
            const existing = toolCallAcc.get(argsDelta.itemId) ?? {
              callId: null,
              name: null,
              arguments: "",
            };
            existing.arguments += argsDelta.delta;
            toolCallAcc.set(argsDelta.itemId, existing);
            if (argsDelta.delta) yield { type: "tool-argument-delta" };
          }

          const argsDone = readResponsesStreamFunctionCallArgsDone(payload);
          if (argsDone) {
            const existing = toolCallAcc.get(argsDone.itemId) ?? {
              callId: null,
              name: null,
              arguments: "",
            };
            // The `done` event carries the authoritative full argument string.
            existing.arguments = argsDone.arguments;
            if (argsDone.name) existing.name = argsDone.name;
            toolCallAcc.set(argsDone.itemId, existing);
          }

          const terminalStatus = terminalResponseStatus(payload.type);
          if (terminalStatus) {
            const responseObj = payload.response as
              Record<string, unknown> | undefined;
            usage = readOpenAiResponsesUsage(responseObj);
            // Some endpoints end the stream with an empty `output` and send
            // the items only as `output_item.done` events.
            if (Array.isArray(responseObj?.output) && responseObj.output.length)
              completedOutput = responseObj.output;
            streamFinishReason = mapResponseStatus(
              responseObj?.status ?? terminalStatus,
            );
            assertGenerationPayload(
              { error: streamFinishReason === "error" },
              "openai-responses",
            );
            completed = true;
          }
        }
      } catch (error) {
        diagnostics.assertNotRefused("openai-responses");
        throw error;
      }
      diagnostics.assertNotRefused("openai-responses");
      assertStreamCompleted(completed, "openai-responses");
      yield* replyParts(thinkSplitter.flush());

      // Emit accumulated tool calls before done. The Responses API references
      // tool results by `call_id`, so that is the canonical id we surface;
      // fall back to the item id if the provider omitted call_id.
      for (const [itemId, tc] of toolCallAcc) {
        if (!tc.name) continue;
        yield {
          type: "tool-call",
          id: tc.callId ?? itemId,
          name: tc.name,
          arguments: tc.arguments || "{}",
        };
      }

      yield {
        type: "done",
        ...(diagnostics.diagnostics()
          ? { diagnostics: diagnostics.diagnostics() }
          : {}),
        finishReason: streamFinishReason,
        usage,
        reasoningContent: joinReasoning(reasoning.text(), thinkReasoning),
        providerContinuation: captureContinuation(
          "openai-responses-v1",
          params.model,
          config,
          completedOutput ??
            [...outputItems.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, item]) => item),
        ),
      };
    },

    // Delegate non-text operations to the chat adapter
    embed: (config, params, context) =>
      chatAdapter.embed(config, params, context),
  };
}
