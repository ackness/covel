import { z } from "zod";
import type { ModelProviderAdapter } from "./adapter.js";
import type { ProviderConfig, ModelRequestContext } from "../types.js";
import type {
  EvaluationParams,
  EvaluationQuestions,
  EvaluationResult,
} from "../evaluation/types.js";
import { AiProviderError } from "../errors.js";
import { postJson } from "./http/request.js";
import { normalizeTokenUsage } from "./usage.js";
import { parseEvaluationResponse } from "./evaluation-response.js";

const value = z.union([
  z.string(),
  z.null(),
  z.array(z.json()),
  z.record(z.string(), z.json()),
]);
const requestSchema = z.object({
  model: z.string().min(1),
  state: value,
  questions: z
    .record(
      z.string().min(1),
      z.discriminatedUnion("type", [
        z.object({
          type: z.literal("boolean"),
          instructions: value.optional(),
          criteria: z
            .object({ true: value.optional(), false: value.optional() })
            .optional(),
        }),
        z.object({
          type: z.literal("choice"),
          instructions: value.optional(),
          criteria: z
            .record(z.string().min(1), value)
            .refine(
              (criteria) =>
                Object.keys(criteria).length >= 1 &&
                Object.keys(criteria).length <= 255,
            ),
        }),
        z.object({
          type: z.literal("score"),
          instructions: value.optional(),
          criteria: z.array(value).min(2).max(10),
        }),
      ]),
    )
    .refine((questions) => Object.keys(questions).length > 0),
});

export type EvaluationProtocol =
  "typesafe-systemone-v1" | "openrouter-decisions-v1" | "vercel-evaluation-v4";

/** Wire selection depends on configuration, never on provider or model IDs. */
export function createEvaluationAdapter(
  protocol: EvaluationProtocol,
): ModelProviderAdapter {
  async function evaluate<const Q extends EvaluationQuestions>(
    config: ProviderConfig,
    params: EvaluationParams<Q>,
    context?: ModelRequestContext,
  ): Promise<EvaluationResult<Q>> {
    const provider =
      context?.preset?.provider ?? context?.profile.provider ?? protocol;
    const parsed = requestSchema.safeParse(params);
    if (!parsed.success) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message:
          "Invalid evaluation request: require JSON state, nonempty questions, 1-255 choice options, and 2-10 score levels.",
        provider,
        model: params.model,
        retriable: false,
      });
    }
    const request = parsed.data;
    const vercel = protocol === "vercel-evaluation-v4";
    const body = {
      ...(!vercel ? { model: request.model } : {}),
      state: request.state,
      questions: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          !vercel && question.type === "boolean"
            ? { ...question, type: "noul" }
            : question,
        ]),
      ),
    };
    let baseUrl = config.baseUrl;
    let path: string | { append: string } = "/v1/systemone";
    if (baseUrl && protocol !== "typesafe-systemone-v1") {
      const url = new URL(baseUrl);
      // Accept the shared chat base or the evaluation API base, preserving proxy prefixes.
      url.pathname = url.pathname
        .replace(/\/+$/, "")
        .replace(vercel ? /\/(?:v1|v4\/ai)$/ : /\/api(?:\/(?:v1|alpha))?$/, "");
      baseUrl = url.toString();
      path = {
        append: vercel ? "/v4/ai/evaluation-model" : "/api/alpha/decisions",
      };
    }
    const response = await postJson(
      { ...config, baseUrl },
      path,
      body,
      undefined,
      vercel
        ? {
            "ai-gateway-protocol-version": "0.0.1",
            "ai-gateway-auth-method": "api-key",
            "ai-evaluation-model-specification-version": "4",
            "ai-model-id": request.model,
          }
        : undefined,
    );
    // Keep status classification even when an upstream proxy returns HTML.
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AiProviderError({
        code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
        message: `${protocol} request failed (HTTP ${response.status}).`,
        provider,
        model: params.model,
        statusCode: response.status,
        retriable: response.status === 429 || response.status >= 500,
      });
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      config.signal?.throwIfAborted();
      throw new AiProviderError({
        code: "SCHEMA_VALIDATION_FAILED",
        message: `${protocol} returned invalid JSON.`,
        provider,
        model: params.model,
        retriable: false,
        cause,
      });
    }
    const result = parseEvaluationResponse(
      raw,
      request.questions,
      provider,
      params.model,
      protocol,
    );
    return {
      ...result,
      answers: result.answers as EvaluationResult<Q>["answers"],
      usage: normalizeTokenUsage(result.usage),
    };
  }

  const unsupported = (): never => {
    throw new AiProviderError({
      code: "CONFIG_ERROR",
      message: `${protocol} models support evaluate() only.`,
      provider: protocol,
      retriable: false,
    });
  };
  return {
    evaluate,
    generateText: async () => unsupported(),
    generateObject: async () => unsupported(),
    embed: async () => unsupported(),
    async *streamText() {
      unsupported();
    },
  };
}
