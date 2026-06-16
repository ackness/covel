/** Appended to system prompt for Anthropic generateObject (no native JSON mode). */
const ANTHROPIC_JSON_DIRECTIVE = "Respond with JSON only.";

import {
  PROMPT_CACHE_BREAKPOINT_MARKER,
  stripPromptCacheMarkers,
} from "@covel/shared";

import type { ModelProviderAdapter } from "./adapter.js";
import type { ProviderConfig, UsageSummary } from "../types.js";
import { applyCapabilityFallback } from "./capability-fallback.js";
import {
  createMetadataSanitizer,
  extractParameterOverrides,
} from "./common.js";
import {
  postJson,
  parseJson,
  iterateSsePayloads,
  assertSuccess,
  createStructuredOutputError,
  createUnsupportedModeError,
  readAnthropicText,
  toAnthropicMessages,
} from "./http.js";

const ANTHROPIC_DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Anthropic Messages API caps explicit prompt cache breakpoints at 4 per
 * request. The context assembler (S2-T3) currently emits at most 3
 * breakpoints inside the system prompt (segments 1, 3, 6). We defensively
 * clamp here so we never exceed the limit even if a future assembler
 * change adds more sentinels.
 */
const ANTHROPIC_MAX_CACHE_BREAKPOINTS = 4;

/** Fields that providerRequestMetadata must never override. */
const ANTHROPIC_PROTECTED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "max_tokens",
  "system",
  "parameterOverrides",
]);

/**
 * Shape of an Anthropic `system` field element when caching is enabled.
 * The API also accepts a plain string for `system`, which we use when the
 * cache strategy is `"none"` or the sentinel is absent.
 */
interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

/** camelCase override key → Anthropic Messages wire field. */
const ANTHROPIC_PARAMETER_FIELD_MAP = {
  temperature: "temperature",
  topP: "top_p",
  maxOutputTokens: "max_tokens",
} as const;

function extractAnthropicParameterOverrides(
  meta: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return extractParameterOverrides(meta, ANTHROPIC_PARAMETER_FIELD_MAP);
}

/**
 * Build the `system` field for an Anthropic request.
 *
 * When the provider config advertises `cacheStrategy === 'anthropic-explicit'`
 * AND the concatenated system string contains `PROMPT_CACHE_BREAKPOINT_MARKER`
 * sentinels emitted by the context assembler, the system prompt is split into
 * labelled text blocks and `cache_control: { type: 'ephemeral' }` is attached
 * to each break boundary up to the Anthropic maximum.
 *
 * For any other strategy, or when the sentinel is absent, the function
 * returns a plain string so the request body is byte-identical to the
 * pre-S2-T3 path.
 *
 * `optionalSuffix` is appended to the final segment when present — used
 * by `generateObject` to inject the JSON directive without breaking the
 * cache boundary of preceding segments.
 */
function buildAnthropicSystemField(
  systemPrompt: string,
  config: ProviderConfig,
  optionalSuffix?: string,
): string | AnthropicSystemBlock[] {
  if (!systemPrompt) {
    return optionalSuffix ?? "";
  }

  const useExplicitCache =
    config.cacheStrategy === "anthropic-explicit" &&
    systemPrompt.includes(PROMPT_CACHE_BREAKPOINT_MARKER);

  if (!useExplicitCache) {
    // Strip sentinels even for non-cacheable paths so we never emit
    // invisible PUA bytes we did not intentionally opt into. When there
    // are no sentinels in the string, stripPromptCacheMarkers is a no-op.
    const cleaned = stripPromptCacheMarkers(systemPrompt);
    const merged = optionalSuffix
      ? [cleaned, optionalSuffix].filter(Boolean).join("\n\n")
      : cleaned;
    return merged;
  }

  // Explicit cache path: split on sentinels. Each sentinel marks the end
  // of a cacheable segment (the segment IMMEDIATELY preceding it). If the
  // input ends in a sentinel there is no "open tail" and every non-empty
  // segment is cacheable; if it does not, the final segment is the open
  // tail and never cacheable.
  const endsWithSentinel = systemPrompt.endsWith(
    PROMPT_CACHE_BREAKPOINT_MARKER,
  );

  const splitSegments = systemPrompt
    .split(PROMPT_CACHE_BREAKPOINT_MARKER)
    .map((seg) => seg.replace(/\s+$/u, ""));

  // Drop only the trailing empty string produced by a trailing sentinel;
  // keep any leading/middle empties dropped too (they cannot carry text
  // nor a cache breakpoint).
  const nonEmpty = splitSegments.filter((seg) => seg.length > 0);
  if (nonEmpty.length === 0) {
    return optionalSuffix ?? "";
  }

  // When an `optionalSuffix` is supplied (used by `generateObject` for the
  // JSON directive) and the prompt ends in a sentinel — meaning every
  // non-empty segment is otherwise cacheable — we must append the suffix
  // as a NEW trailing non-cacheable block so it does not poison the
  // preceding segment's cache hash. Doing so effectively turns the last
  // sentinel into an "open-tail" boundary.
  const suffixBecomesTail = Boolean(optionalSuffix) && endsWithSentinel;

  // cacheableCount = number of segments that directly precede a sentinel,
  // clamped to Anthropic's maximum breakpoint count.
  const hasOpenTail = !endsWithSentinel || suffixBecomesTail;
  const segmentCount = nonEmpty.length + (suffixBecomesTail ? 1 : 0);
  const cacheableCount = Math.min(
    hasOpenTail ? segmentCount - 1 : segmentCount,
    ANTHROPIC_MAX_CACHE_BREAKPOINTS,
  );

  const blocks: AnthropicSystemBlock[] = [];
  for (let i = 0; i < nonEmpty.length; i++) {
    const isCacheable = i < cacheableCount;
    let text = nonEmpty[i]!;
    // In-place suffix merge when there's an open tail already.
    if (!suffixBecomesTail && i === nonEmpty.length - 1 && optionalSuffix) {
      text = text.length > 0 ? `${text}\n\n${optionalSuffix}` : optionalSuffix;
    }
    const block: AnthropicSystemBlock = { type: "text", text };
    if (isCacheable) {
      block.cache_control = { type: "ephemeral" };
    }
    blocks.push(block);
  }

  if (suffixBecomesTail && optionalSuffix) {
    blocks.push({ type: "text", text: optionalSuffix });
  }

  return blocks;
}

const sanitizeAnthropicMetadata = createMetadataSanitizer(
  ANTHROPIC_PROTECTED_KEYS,
);

function anthropicHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "anthropic-version": ANTHROPIC_VERSION };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

function readAnthropicUsage(payload: Record<string, unknown>): UsageSummary {
  const usage = payload.usage as Record<string, unknown> | undefined;
  return {
    inputTokens: Number(usage?.input_tokens ?? 0),
    outputTokens: Number(usage?.output_tokens ?? 0),
  };
}

/**
 * Narrow helper — we only want to emit a `system` key on the wire when the
 * value is non-empty. Treats the string "" and the array [] as absent and
 * returns true otherwise. Keeps the original "omit empty system" contract
 * from the pre-S2-T3 adapter.
 */
function hasSystem(value: string | AnthropicSystemBlock[]): boolean {
  if (typeof value === "string") return value.length > 0;
  return value.length > 0;
}

/**
 * Anthropic Messages v1 adapter.
 * Handles the Anthropic-specific streaming format and message structure.
 */
export function createAnthropicMessagesAdapter(): ModelProviderAdapter {
  return {
    async generateText(config, params, context) {
      const { system, messages } = toAnthropicMessages(
        applyCapabilityFallback(params.messages, context),
      );
      const systemField = buildAnthropicSystemField(system, config);
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(
        configNoKey,
        "/messages",
        {
          model: params.model,
          max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
          ...(hasSystem(systemField) ? { system: systemField } : {}),
          messages,
          ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
          ...extractAnthropicParameterOverrides(params.providerRequestMetadata),
        },
        undefined,
        headers,
      );
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      return {
        text: readAnthropicText(payload),
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: readAnthropicUsage(payload),
      };
    },

    async generateObject(config, params, context) {
      const { system, messages } = toAnthropicMessages(
        applyCapabilityFallback(params.messages, context),
      );
      const systemField = buildAnthropicSystemField(
        system,
        config,
        ANTHROPIC_JSON_DIRECTIVE,
      );
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(
        configNoKey,
        "/messages",
        {
          model: params.model,
          max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
          system: systemField,
          messages,
          ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
          ...extractAnthropicParameterOverrides(params.providerRequestMetadata),
        },
        undefined,
        headers,
      );
      const payload = await parseJson(response);
      assertSuccess(response, payload, "anthropic");

      let rawObject: unknown;
      try {
        rawObject = JSON.parse(readAnthropicText(payload));
      } catch {
        throw createStructuredOutputError("anthropic");
      }
      const validation = params.schema.safeParse(rawObject);
      if (!validation.success) {
        throw createStructuredOutputError("anthropic");
      }

      return {
        object: validation.data,
        finishReason: String(payload.stop_reason ?? "stop"),
        usage: readAnthropicUsage(payload),
      };
    },

    async *streamText(config, params, context) {
      const { system, messages } = toAnthropicMessages(
        applyCapabilityFallback(params.messages, context),
      );
      const systemField = buildAnthropicSystemField(system, config);
      const headers = anthropicHeaders(config.apiKey);
      const configNoKey = { ...config, apiKey: undefined };
      const response = await postJson(
        configNoKey,
        "/messages",
        {
          model: params.model,
          max_tokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
          stream: true,
          ...(hasSystem(systemField) ? { system: systemField } : {}),
          messages,
          ...sanitizeAnthropicMetadata(params.providerRequestMetadata),
          ...extractAnthropicParameterOverrides(params.providerRequestMetadata),
        },
        undefined,
        headers,
      );

      if (!response.ok) {
        const payload = await parseJson(response);
        assertSuccess(response, payload, "anthropic-messages");
      }

      let usage: UsageSummary = { inputTokens: 0, outputTokens: 0 };
      let finishReason = "stop";

      for await (const payload of iterateSsePayloads(response)) {
        const delta = payload.delta as Record<string, unknown> | undefined;
        if (
          payload.type === "content_block_delta" &&
          delta?.type === "text_delta" &&
          typeof delta.text === "string"
        ) {
          yield { type: "text-delta", textDelta: delta.text };
        }

        if (payload.type === "message_start") {
          const msgUsage = (
            payload.message as Record<string, unknown> | undefined
          )?.usage as Record<string, unknown> | undefined;
          if (msgUsage) {
            usage = {
              inputTokens: Number(msgUsage.input_tokens ?? 0),
              outputTokens: usage.outputTokens,
            };
          }
        }

        if (payload.type === "message_delta") {
          finishReason = String(delta?.stop_reason ?? finishReason);
          const usageObj = payload.usage as Record<string, unknown> | undefined;
          usage = {
            inputTokens: usage.inputTokens,
            outputTokens: Number(usageObj?.output_tokens ?? usage.outputTokens),
          };
        }
      }

      yield { type: "done", finishReason, usage };
    },

    async embed() {
      throw createUnsupportedModeError("anthropic", "embed");
    },
    async synthesizeSpeech() {
      throw createUnsupportedModeError("anthropic", "speech");
    },
    async transcribeAudio() {
      throw createUnsupportedModeError("anthropic", "transcription");
    },
  };
}
