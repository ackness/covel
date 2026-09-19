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
import { parseTypeSafeEvaluation } from "./typesafe-evaluation-response.js";

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

/** Native System One transport. Other providers can implement adapter.evaluate. */
export function createTypeSafeSystemOneAdapter(): ModelProviderAdapter {
  async function evaluate<const Q extends EvaluationQuestions>(
    config: ProviderConfig,
    params: EvaluationParams<Q>,
    context?: ModelRequestContext,
  ): Promise<EvaluationResult<Q>> {
    const provider =
      context?.preset?.provider ?? context?.profile.provider ?? "typesafe";
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
    const response = await postJson(config, "/v1/systemone", {
      model: request.model,
      state: request.state,
      questions: Object.fromEntries(
        Object.entries(request.questions).map(([id, question]) => [
          id,
          question.type === "boolean"
            ? { ...question, type: "noul" }
            : question,
        ]),
      ),
    });
    // Keep status classification even when an upstream proxy returns HTML.
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AiProviderError({
        code: response.status === 429 ? "RATE_LIMITED" : "PROVIDER_ERROR",
        message: `System One request failed (HTTP ${response.status}).`,
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
        message: "System One returned invalid JSON.",
        provider,
        model: params.model,
        retriable: false,
        cause,
      });
    }
    const result = parseTypeSafeEvaluation(
      raw,
      request.questions,
      provider,
      params.model,
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
      message: "System One models support evaluate() only.",
      provider: "typesafe",
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
