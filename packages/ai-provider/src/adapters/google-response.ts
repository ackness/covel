import { z } from "zod";
import type { LLMDiagnostics } from "@covel/shared";
import { AiProviderError } from "../errors.js";
import type { ProviderConfig, TextGenerationResult } from "../types.js";
import { normalizeTokenUsage, sumTokenCounts } from "./usage.js";

export const GOOGLE_PROTOCOL = "google-generative-ai-v1";
export const GOOGLE_PROVIDER = "google-generative-ai";

export function googleError(
  message: string,
  configuration = false,
): AiProviderError {
  return new AiProviderError({
    code: configuration ? "CONFIG_ERROR" : "PROVIDER_ERROR",
    message,
    provider: GOOGLE_PROVIDER,
    retriable: !configuration,
  });
}

// GenerateContent wire contract: https://ai.google.dev/api/generate-content
// Unknown additive fields are retained; known fields must have valid types.
export const googlePartSchema = z
  .object({
    text: z.string().optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
    functionCall: z
      .object({
        id: z.string().optional(),
        name: z.string().min(1),
        args: z.record(z.string(), z.json()).optional(),
        partialArgs: z.unknown().optional(),
        willContinue: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough()
  .refine(
    (part) =>
      part.text !== undefined ||
      part.functionCall !== undefined ||
      part.thoughtSignature !== undefined,
    "Unsupported or empty Gemini content part",
  );
export type GooglePart = z.infer<typeof googlePartSchema>;

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const citationSchema = z
  .object({
    uri: z.string().optional(),
    title: z.string().optional(),
    startIndex: count.optional(),
    endIndex: count.optional(),
  })
  .passthrough();
const payloadSchema = z
  .object({
    candidates: z
      .array(
        z
          .object({
            index: count.optional(),
            content: z
              .object({
                role: z.string().optional(),
                parts: z.array(googlePartSchema).optional(),
              })
              .passthrough()
              .optional(),
            finishReason: z.string().optional(),
            finishMessage: z.string().optional(),
            citationMetadata: z
              .object({ citationSources: z.array(citationSchema).optional() })
              .passthrough()
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
    promptFeedback: z
      .object({
        blockReason: z.string().optional(),
        blockReasonMessage: z.string().optional(),
      })
      .passthrough()
      .optional(),
    usageMetadata: z
      .object({
        promptTokenCount: count.optional(),
        candidatesTokenCount: count.optional(),
        thoughtsTokenCount: count.optional(),
        cachedContentTokenCount: count.optional(),
      })
      .passthrough()
      .optional(),
    error: z
      .object({ message: z.string().optional(), code: z.number().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const FILTERED = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
  "ESCALATION",
  "PUP_LIMITED_DISABLED",
]);

/** Accumulates one candidate; tool calls become visible only after finish validation. */
export class GoogleResponse {
  private readonly parts: GooglePart[] = [];
  private finish?: string;
  private usage: z.infer<typeof payloadSchema>["usageMetadata"] = {};
  private readonly citations = new Map<
    string,
    z.infer<typeof citationSchema>
  >();

  push(raw: unknown): GooglePart[] {
    // An authoritative refusal wins over unrelated malformed content. Otherwise
    // a mixed safety response could be misclassified as a retriable parse error.
    const envelope = z
      .object({
        promptFeedback: z.unknown().optional(),
        candidates: z.unknown().optional(),
      })
      .passthrough()
      .safeParse(raw);
    if (envelope.success) {
      const feedback = z
        .object({
          blockReason: z.string(),
          blockReasonMessage: z.unknown().optional(),
        })
        .passthrough()
        .safeParse(envelope.data.promptFeedback);
      if (
        feedback.success &&
        feedback.data.blockReason &&
        feedback.data.blockReason !== "BLOCK_REASON_UNSPECIFIED"
      )
        this.refuse(
          typeof feedback.data.blockReasonMessage === "string"
            ? feedback.data.blockReasonMessage
            : feedback.data.blockReason,
        );
      if (Array.isArray(envelope.data.candidates))
        for (const candidate of envelope.data.candidates) {
          const finish = z
            .object({
              finishReason: z.string(),
              finishMessage: z.unknown().optional(),
            })
            .passthrough()
            .safeParse(candidate);
          if (finish.success && FILTERED.has(finish.data.finishReason))
            this.refuse(
              typeof finish.data.finishMessage === "string"
                ? finish.data.finishMessage
                : finish.data.finishReason,
            );
        }
    }
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success)
      throw googleError("Gemini returned an invalid generateContent payload");
    const payload = parsed.data;
    if (payload.error)
      throw googleError(payload.error.message ?? "Gemini returned an error");
    const block = payload.promptFeedback?.blockReason;
    if (block && block !== "BLOCK_REASON_UNSPECIFIED") {
      this.refuse(payload.promptFeedback?.blockReasonMessage ?? block);
    }
    if ((payload.candidates?.length ?? 0) > 1)
      throw googleError(
        "Gemini returned multiple candidates; exactly one is supported",
      );
    const candidate = payload.candidates?.[0];
    if (candidate?.index !== undefined && candidate.index !== 0)
      throw googleError("Gemini returned an unexpected candidate index");
    if (!candidate && !payload.usageMetadata)
      throw googleError("Gemini returned no candidate");
    const reason = candidate?.finishReason;
    if (reason && FILTERED.has(reason))
      this.refuse(candidate?.finishMessage ?? reason);
    if (
      reason &&
      !["STOP", "MAX_TOKENS", "FINISH_REASON_UNSPECIFIED"].includes(reason)
    ) {
      throw googleError(`Gemini generation failed: ${reason}`);
    }
    const parts = candidate?.content?.parts ?? [];
    if (this.finish && parts.length)
      throw googleError("Gemini returned content after its finish reason");
    for (const part of parts) {
      if (
        part.functionCall?.partialArgs !== undefined ||
        part.functionCall?.willContinue === true
      ) {
        throw googleError(
          "Gemini partial function arguments are not supported",
        );
      }
      this.parts.push(part);
    }
    if (reason && reason !== "FINISH_REASON_UNSPECIFIED") this.finish = reason;
    if (payload.usageMetadata)
      this.usage = { ...this.usage, ...payload.usageMetadata };
    for (const citation of candidate?.citationMetadata?.citationSources ?? []) {
      if (citation.uri) this.citations.set(JSON.stringify(citation), citation);
    }
    return parts;
  }

  result(
    config: ProviderConfig,
    model: string,
    fallbackId: (index: number) => string,
  ): TextGenerationResult {
    if (!this.finish)
      throw googleError("Gemini response ended without a finish reason");
    const toolParts = this.parts.filter(
      (part) => part.functionCall !== undefined,
    );
    if (toolParts.length && this.finish !== "STOP")
      throw googleError("Gemini tool calls were not completed successfully");
    // A call without a native id gets one that no other call of the
    // conversation has (`fallbackToolCallIds`).
    const toolCalls = toolParts.map((part, index) => ({
      id: part.functionCall!.id ?? fallbackId(index),
      name: part.functionCall!.name,
      arguments: JSON.stringify(part.functionCall!.args ?? {}),
    }));
    const text = this.parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? "")
      .join("");
    const reasoningContent = this.parts
      .filter((part) => part.thought)
      .map((part) => part.text ?? "")
      .join("");
    const diagnostics = this.diagnostics();
    // Capture every part, including empty text with a trailing signature. Do not
    // merge signed/unsigned parts or replace the provider's native call IDs.
    const preserveNative = this.parts.some(
      (part) =>
        part.thoughtSignature !== undefined || part.functionCall !== undefined,
    );
    return {
      text,
      finishReason: toolCalls.length
        ? "tool_calls"
        : this.finish === "MAX_TOKENS"
          ? "length"
          : "stop",
      usage: normalizeTokenUsage({
        inputTokens: this.usage?.promptTokenCount ?? 0,
        outputTokens: sumTokenCounts(
          this.usage?.candidatesTokenCount ?? 0,
          this.usage?.thoughtsTokenCount ?? 0,
        ),
        cachedInputTokens: this.usage?.cachedContentTokenCount,
      }),
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(preserveNative
        ? {
            providerContinuation: {
              protocol: GOOGLE_PROTOCOL,
              model,
              baseUrl: config.baseUrl ?? "",
              items: this.parts,
            },
          }
        : {}),
    };
  }

  private diagnostics(): LLMDiagnostics | undefined {
    if (!this.citations.size) return undefined;
    const sources = new Map<
      string,
      { type: "url"; id: string; url: string; title?: string }
    >();
    const citations = [...this.citations.values()].map((citation) => {
      const sourceId = `url:${citation.uri!}`;
      sources.set(sourceId, {
        type: "url",
        id: sourceId,
        url: citation.uri!,
        ...(citation.title ? { title: citation.title } : {}),
      });
      return {
        sourceId,
        location: "response" as const,
        ...(citation.startIndex !== undefined
          ? { startIndex: citation.startIndex }
          : {}),
        ...(citation.endIndex !== undefined
          ? { endIndex: citation.endIndex }
          : {}),
      };
    });
    return { sources: [...sources.values()], citations };
  }

  private refuse(message: string): never {
    throw new AiProviderError({
      code: "REFUSAL",
      message: "Gemini refused the generation",
      provider: GOOGLE_PROVIDER,
      retriable: false,
      details: {
        diagnostics: {
          ...this.diagnostics(),
          refusal: { reason: "content-filter", message },
        },
      },
    });
  }
}
