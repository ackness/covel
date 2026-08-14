import type { ModelProviderAdapter } from "./adapter.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  readResponsesOutputText,
  readResponsesStreamFunctionCallAdded,
  readResponsesStreamFunctionCallArgsDelta,
  readResponsesStreamFunctionCallArgsDone,
} from "./http.js";
import { applyCapabilityFallback } from "./capability-fallback.js";
import { extractReasoningRequestFields } from "../reasoning-effort.js";
import { createOpenAiChatAdapter } from "./openai-chat.js";
import {
  createMetadataSanitizer,
  extractParameterOverrides,
  mediaRefFallbackText,
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

function extractResponsesParameterOverrides(
  meta: Record<string, unknown> | undefined,
  context: ModelRequestContext | undefined,
  model: string,
): Record<string, unknown> {
  return {
    ...extractParameterOverrides(meta, RESPONSES_PARAMETER_FIELD_MAP),
    ...extractReasoningRequestFields(
      meta,
      context,
      "openai-responses-v1",
      model,
    ),
  };
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
      return "stop";
  }
}

function serializeResponsesContent(content: TextMessageContent): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "input_text", text: part.text };
    if (part.image.url)
      return { type: "input_image", image_url: part.image.url };
    return { type: "input_text", text: mediaRefFallbackText(part) };
  });
}

/**
 * Flatten message content down to a plain string. Used for tool results,
 * which the Responses API carries as a `function_call_output.output` string
 * rather than a structured content array.
 */
function responsesContentToText(content: TextMessageContent): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text" ? part.text : mediaRefFallbackText(part),
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
function serializeResponsesInput(messages: TextMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const msg of messages) {
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

/**
 * Convert Chat-style `ToolDefinition[]` into the Responses API tool shape.
 * The Responses API flattens the `function` envelope: `name`, `description`,
 * and `parameters` live at the top level of each tool object.
 */
function serializeResponsesTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    ...(tool.function.description
      ? { description: tool.function.description }
      : {}),
    parameters: tool.function.parameters ?? {},
  }));
}

/**
 * OpenAI Responses v1 adapter.
 * Uses the /responses endpoint with different streaming format.
 * Falls back to OpenAI Chat adapter for non-text operations.
 */
export function createOpenAiResponsesAdapter(): ModelProviderAdapter {
  const chatAdapter = createOpenAiChatAdapter();

  return {
    async generateText(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: serializeResponsesInput(messages),
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      const genTextUsage = payload.usage as Record<string, unknown> | undefined;
      return {
        text: readResponsesOutputText(payload),
        finishReason: mapResponseStatus(payload.status),
        usage: {
          inputTokens: Number(genTextUsage?.input_tokens ?? 0),
          outputTokens: Number(genTextUsage?.output_tokens ?? 0),
        },
      };
    },

    async generateObject(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const response = await postJson(config, "/responses", {
        model: params.model,
        input: serializeResponsesInput(messages),
        text: { format: { type: "json_schema" } },
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-responses");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readResponsesOutputText(payload));
      } catch {
        throw createStructuredOutputError("openai-responses");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-responses");
      }

      const genObjUsage = payload.usage as Record<string, unknown> | undefined;
      return {
        object: validation.data,
        finishReason: mapResponseStatus(payload.status),
        usage: {
          inputTokens: Number(genObjUsage?.input_tokens ?? 0),
          outputTokens: Number(genObjUsage?.output_tokens ?? 0),
        },
      };
    },

    async *streamText(config, params, context) {
      const messages = applyCapabilityFallback(params.messages, context);
      const body: Record<string, unknown> = {
        model: params.model,
        input: serializeResponsesInput(messages),
        stream: true,
        ...sanitizeResponsesMetadata(params.providerRequestMetadata),
        ...extractResponsesParameterOverrides(
          params.providerRequestMetadata,
          context,
          params.model,
        ),
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = serializeResponsesTools(params.tools);
        body.tool_choice = "auto";
      }
      const response = await postJson(config, "/responses", body);

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-responses");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let streamFinishReason = "stop";
      // Accumulate streaming function-call items keyed by the Responses item
      // id. Insertion order (first `output_item.added`) drives emission order.
      const toolCallAcc = new Map<
        string,
        { callId: string | null; name: string | null; arguments: string }
      >();

      for await (const payload of iterateSsePayloads(response)) {
        if (
          payload.type === "response.output_text.delta" &&
          typeof payload.delta === "string"
        ) {
          yield { type: "text-delta", textDelta: payload.delta as string };
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

        if (payload.type === "response.completed") {
          const responseObj = payload.response as
            Record<string, unknown> | undefined;
          const responseUsage = responseObj?.usage as
            Record<string, unknown> | undefined;
          usage = {
            inputTokens: Number(responseUsage?.input_tokens ?? 0),
            outputTokens: Number(responseUsage?.output_tokens ?? 0),
          };
          streamFinishReason = mapResponseStatus(responseObj?.status);
        }
      }

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

      yield { type: "done", finishReason: streamFinishReason, usage };
    },

    // Delegate non-text operations to the chat adapter
    embed: (config, params, context) =>
      chatAdapter.embed(config, params, context),
  };
}
