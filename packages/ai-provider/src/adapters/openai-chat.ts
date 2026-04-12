import type { ModelProviderAdapter } from "./adapter.js";
import type { UsageSummary } from "../types.js";
import {
  postJson,
  postFormData,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  appendProviderMetadata,
  readOpenAiChatText,
  readOpenAiChatFinishReason,
  readOpenAiChatUsage,
  readOpenAiChatToolCalls,
  readOpenAiChatStreamDelta,
  readOpenAiChatStreamReasoningDelta,
  readOpenAiChatStreamFinishReason,
} from "./http.js";

import type { TextMessage } from "../types.js";

/** Fields that providerRequestMetadata must never override. */
const OPENAI_PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "response_format",
  // `input` is protected for embeddings — it is built from params.values.
  "input",
  // Slot-level dispatch hints — consumed by the adapter, not forwarded.
  "embeddingFormat",
  // Image dispatch hint — consumed by generateImage branches.
  "imageFormat",
]);

function sanitizeOpenAiMetadata(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!meta) return {};
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!OPENAI_PROTECTED_KEYS.has(k)) sanitized[k] = v;
  }
  return sanitized;
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
function buildEmbeddingInput(
  values: string[],
  format: string,
): unknown {
  if (format === "nemotron-multimodal") {
    return values.map((text) => ({
      content: [{ type: "text", text }],
    }));
  }
  return values;
}

/**
 * Serialize TextMessage[] to OpenAI wire format.
 * Handles assistant messages with tool_calls and tool role messages.
 */
function serializeMessages(
  messages: TextMessage[]
): Record<string, unknown>[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: msg.content || null,
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
        content: msg.content,
        tool_call_id: msg.toolCallId,
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray<T = unknown>(value: unknown): T[] | undefined {
  return Array.isArray(value) ? (value as T[]) : undefined;
}

// ── DashScope WAN async image generation ──────────────────────────

const DASHSCOPE_POLL_INTERVAL_MS = 2000;
const DASHSCOPE_POLL_MAX_ATTEMPTS = 30; // ~60s

async function generateImageDashscopeWan(
  config: import("../types.js").ProviderConfig,
  params: import("../types.js").ImageGenerationParams,
): Promise<import("../types.js").ImageGenerationResult> {
  const meta = params.providerRequestMetadata ?? {};
  const { imageFormat: _drop, size, n, watermark, thinking_mode, ...restMeta } = meta as Record<string, unknown>;

  // Step 1: Submit async task (pass signal so it can be cancelled)
  const submitResponse = await postJson(
    config,
    "/api/v1/services/aigc/image-generation/generation",
    {
      model: params.model,
      input: {
        messages: [
          { role: "user", content: [{ text: params.prompt }] },
        ],
      },
      parameters: {
        ...(size !== undefined ? { size } : {}),
        n: n ?? 1,
        watermark: watermark ?? false,
        ...(thinking_mode !== undefined ? { thinking_mode } : {}),
        ...sanitizeOpenAiMetadata(restMeta),
      },
    },
    config.signal,
    { "X-DashScope-Async": "enable" },
  );

  const submitPayload = await parseJson(submitResponse);
  assertSuccess(submitResponse, submitPayload, "dashscope-wan");

  const submitOutput = asRecord(submitPayload.output);
  const taskId = typeof submitOutput?.task_id === "string"
    ? submitOutput.task_id
    : undefined;
  if (!taskId) {
    throw new Error("DashScope WAN: no task_id in response");
  }

  // Step 2: Poll until SUCCEEDED or FAILED
  for (let attempt = 0; attempt < DASHSCOPE_POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, DASHSCOPE_POLL_INTERVAL_MS));

    const pollResponse = await fetch(
      `${config.baseUrl}/api/v1/tasks/${taskId}`,
      {
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          ...(config.headers ?? {}),
        },
        signal: config.signal,
      },
    );
    const pollPayload = await parseJson(pollResponse);
    const pollOutput = asRecord(pollPayload.output);

    const status = typeof pollOutput?.task_status === "string"
      ? pollOutput.task_status
      : undefined;

    if (status === "SUCCEEDED") {
      const results = asArray<{ url?: string }>(pollOutput?.results) ?? [];
      return {
        images: results
          .filter((r) => r.url)
          .map((r) => ({ mimeType: "image/png", url: r.url! })),
        usage: null,
      };
    }

    if (status === "FAILED") {
      const msg = typeof pollOutput?.message === "string"
        ? pollOutput.message
        : "Task FAILED";
      throw new Error(`DashScope WAN generation FAILED: ${msg}`);
    }
    // PENDING / RUNNING → keep polling
  }

  throw new Error("DashScope WAN: polling timed out");
}

// ── OpenAI chat completions image format ──────────────────────────

async function generateImageOpenAiChat(
  config: import("../types.js").ProviderConfig,
  params: import("../types.js").ImageGenerationParams,
): Promise<import("../types.js").ImageGenerationResult> {
  const meta = params.providerRequestMetadata ?? {};
  const { imageFormat: _drop, ...restMeta } = meta as Record<string, unknown>;

  const response = await postJson(config, "/chat/completions", {
    model: params.model,
    stream: false,
    messages: [{ role: "user", content: params.prompt }],
    ...sanitizeOpenAiMetadata(restMeta),
  });
  const payload = await parseJson(response);
  assertSuccess(response, payload, "openai-chat-image");

  // Some providers return image_url at top level
  if (typeof payload.image_url === "string") {
    return { images: [{ mimeType: "image/png", url: payload.image_url }], usage: null };
  }

  // Some return images array
  if (Array.isArray(payload.images)) {
    return {
      images: (payload.images as Array<{ url?: string; b64_json?: string; mime_type?: string }>)
        .filter((img) => img.url || img.b64_json)
        .map((img) => ({
          mimeType: typeof img.mime_type === "string" ? img.mime_type : "image/png",
          ...(img.url ? { url: img.url } : {}),
          ...(img.b64_json ? { dataBase64: img.b64_json } : {}),
        })),
      usage: readOpenAiChatUsage(payload),
    };
  }

  // Fallback: check choices[0].message.content for URLs
  const firstChoice = asArray(payload.choices)?.[0];
  const firstMessage = asRecord(asRecord(firstChoice)?.message);
  const content = firstMessage?.content;
  if (typeof content === "string") {
    const urlMatch = content.match(/https?:\/\/\S+\.(png|jpg|jpeg|webp|gif)/i);
    if (urlMatch) {
      return { images: [{ mimeType: "image/png", url: urlMatch[0] }], usage: readOpenAiChatUsage(payload) };
    }
  }

  return { images: [], usage: readOpenAiChatUsage(payload) };
}

/**
 * OpenAI Chat Completions v1 adapter.
 * Works with any OpenAI-compatible API (DeepSeek, DashScope, etc.).
 */
export function createOpenAiChatAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params) {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: serializeMessages(params.messages),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      };
      if (params.tools && params.tools.length > 0) {
        body.tools = params.tools;
      }

      const response = await postJson(config, "/chat/completions", body);
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const toolCalls = readOpenAiChatToolCalls(payload);
      return {
        text: readOpenAiChatText(payload),
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
        ...(toolCalls ? { toolCalls } : {}),
      };
    },

    async generateObject(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(params.messages),
        response_format: { type: "json_object" },
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readOpenAiChatText(payload));
      } catch {
        throw createStructuredOutputError("openai-chat");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("openai-chat");
      }

      return {
        object: validation.data,
        finishReason: readOpenAiChatFinishReason(payload),
        usage: readOpenAiChatUsage(payload),
      };
    },

    async *streamText(config, params) {
      const response = await postJson(config, "/chat/completions", {
        model: params.model,
        messages: serializeMessages(params.messages),
        stream: true,
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });

      // Check HTTP status before parsing SSE — a non-2xx response won't be SSE
      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-chat");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const reasoningDelta = readOpenAiChatStreamReasoningDelta(payload);
        if (reasoningDelta) {
          yield { type: "reasoning-delta", reasoningDelta };
        }

        const delta = readOpenAiChatStreamDelta(payload);
        if (delta) {
          yield { type: "text-delta", textDelta: delta };
        }

        if (payload.usage && typeof payload.usage === "object") {
          const usageObj = payload.usage as Record<string, unknown>;
          usage = {
            inputTokens: Number(usageObj.prompt_tokens ?? 0),
            outputTokens: Number(usageObj.completion_tokens ?? 0),
          };
        }

        const reason = readOpenAiChatStreamFinishReason(payload);
        if (reason) finishReason = reason;
      }

      yield { type: "done", finishReason, usage };
    },

    async embed(config, params) {
      // Slot-level `embeddingFormat` (from llm.toml) is propagated here via
      // params.providerRequestMetadata.embeddingFormat. Default is the
      // standard OpenAI `input: string[]` shape. Custom formats wrap values
      // into provider-specific content shapes — mirrors the imageApi
      // dispatch pattern further below.
      const meta = params.providerRequestMetadata ?? {};
      const embeddingFormat = (meta.embeddingFormat as string | undefined) ?? "openai";

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
          (entry: { embedding: number[] }) => entry.embedding
        ),
        usage: {
          inputTokens: Number((payload.usage as Record<string, unknown> | undefined)?.prompt_tokens ?? 0),
          outputTokens: 0,
        },
      };
    },

    async generateImage(config, params) {
      const meta = params.providerRequestMetadata ?? {};
      // imageFormat is set by the kernel from llm.toml's `imageApi` field.
      // Supported: "dashscope-wan" | "openai-chat" (default).
      const imageFormat = (meta.imageFormat as string | undefined) ?? "openai-chat";

      // ── DashScope WAN async task API ─────────────────────────────
      if (imageFormat === "dashscope-wan") {
        return generateImageDashscopeWan(config, params);
      }

      // ── OpenAI chat completions image format (default) ────────────
      return generateImageOpenAiChat(config, params);
    },

    async synthesizeSpeech(config, params) {
      const response = await postJson(config, "/audio/speech", {
        model: params.model,
        input: params.text,
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.format ? { format: params.format } : {}),
        ...sanitizeOpenAiMetadata(params.providerRequestMetadata),
      });

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "openai-chat");
      }

      return {
        audio: {
          mimeType: response.headers.get("content-type") ?? "audio/mpeg",
          data: new Uint8Array(await response.arrayBuffer()),
        },
        usage: null,
      };
    },

    async transcribeAudio(config, params) {
      const formData = new FormData();
      formData.set("model", params.model);
      formData.set(
        "file",
        new Blob([params.audio.data.buffer as ArrayBuffer], {
          type: params.audio.mimeType,
        }),
        params.audio.fileName ?? "audio.bin"
      );
      appendProviderMetadata(formData, params.providerRequestMetadata);

      const response = await postFormData(
        config,
        "/audio/transcriptions",
        formData
      );
      const payload = await parseJson(response);
      assertSuccess(response, payload, "openai-chat");

      const transcriptionUsage =
        payload.usage && typeof payload.usage === "object"
          ? (payload.usage as Record<string, unknown>)
          : null;
      return {
        text: String(payload.text ?? ""),
        usage: transcriptionUsage
          ? {
              inputTokens: Number(transcriptionUsage.prompt_tokens ?? 0),
              outputTokens: Number(transcriptionUsage.completion_tokens ?? 0),
            }
          : null,
      };
    },
  };
}
