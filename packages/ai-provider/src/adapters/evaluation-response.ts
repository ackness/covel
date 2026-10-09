import { z } from "zod";
import { AiProviderError } from "../errors.js";
import type {
  EvaluationAnswer,
  EvaluationQuestions,
  EvaluationResult,
} from "../evaluation/types.js";
import type { EvaluationProtocol } from "./evaluation.js";

const probability = z.number().min(0).max(1);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const choice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), probability).optional(),
  confidence: probability.nullish(),
});
const score = z.object({
  type: z.literal("score"),
  score: z.number(),
  probabilities: z.record(z.string(), probability).optional(),
  confidence: probability.nullish(),
});
const systemOneSchema = z.object({
  model: z.string().min(1).nullish(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("noul"), noul: probability }),
      choice,
      score,
    ]),
  ),
  usage: z
    .object({
      input_tokens: tokenCount.nullish(),
      output_tokens: tokenCount.nullish(),
      cost: z.number().nonnegative().optional(),
    })
    .nullish(),
  id: z.string().optional(),
  provider: z.string().optional(),
});
const vercelSchema = z.object({
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("boolean"), probability }),
      choice,
      score,
    ]),
  ),
  usage: z
    .object({
      inputTokens: tokenCount.optional(),
      outputTokens: tokenCount.optional(),
    })
    .optional(),
  rounding: z
    .object({
      probabilityDecimals: z.number().int().min(0).max(15).optional(),
      scoreDecimals: z.number().int().min(0).max(15).optional(),
    })
    .optional(),
  providerMetadata: z
    .record(z.string(), z.record(z.string(), z.json()))
    .optional(),
  warnings: z.array(z.record(z.string(), z.json())).optional(),
});

/** OpenAI Decisions: answers are a list, and each distribution is a list. */
const openAiSchema = z.object({
  model: z.string().min(1).nullish(),
  answers: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("refusal"), name: z.string().nullable() }),
      z.object({
        type: z.literal("predicate"),
        name: z.string(),
        probability,
      }),
      z.object({
        type: z.literal("choice"),
        name: z.string(),
        choice: z.string(),
        confidence: probability.nullish(),
        probabilities: z.array(z.object({ value: z.string(), probability })),
      }),
      z.object({
        type: z.literal("score"),
        name: z.string(),
        score: z.number(),
        confidence: probability.nullish(),
        probabilities: z.array(
          z.object({ value: z.number().int().nonnegative(), probability }),
        ),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: tokenCount.nullish(),
      output_tokens: tokenCount.nullish(),
      input_tokens_details: z
        .object({
          cached_tokens: tokenCount.nullish(),
          cache_write_tokens: tokenCount.nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

/**
 * Bring an OpenAI Decisions response to the keyed shape the other protocols
 * return, so one check covers them all. A refused question fails the call:
 * the public contract has an answer for every question.
 */
function openAiAnswers(
  raw: unknown,
  provider: string,
  requestedModel: string,
):
  | (z.infer<typeof systemOneSchema> & {
      cache?: {
        cached_tokens?: number | null;
        cache_write_tokens?: number | null;
      } | null;
    })
  | undefined {
  const parsed = openAiSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const answers: z.infer<typeof systemOneSchema>["answers"] = Object.create(
    null,
  ) as z.infer<typeof systemOneSchema>["answers"];
  for (const answer of parsed.data.answers) {
    if (answer.type === "refusal") {
      throw new AiProviderError({
        code: "REFUSAL",
        message: `OpenAI Decisions declined to answer${answer.name ? ` "${answer.name}"` : " a question"}.`,
        provider,
        model: requestedModel,
        retriable: false,
        details: {
          diagnostics: { refusal: { reason: "refusal" } },
          ...(answer.name ? { question: answer.name } : {}),
        },
      });
    }
    // A name that comes twice cannot be one answer for every question.
    if (Object.hasOwn(answers, answer.name)) return undefined;
    if (answer.type === "predicate") {
      answers[answer.name] = { type: "noul", noul: answer.probability };
      continue;
    }
    const probabilities = Object.fromEntries(
      answer.probabilities.map((entry) => [
        String(entry.value),
        entry.probability,
      ]),
    );
    if (Object.keys(probabilities).length !== answer.probabilities.length)
      return undefined;
    answers[answer.name] =
      answer.type === "choice"
        ? {
            type: "choice",
            choice: answer.choice,
            probabilities,
            confidence: answer.confidence,
          }
        : {
            type: "score",
            score: answer.score,
            probabilities,
            confidence: answer.confidence,
          };
  }
  return {
    model: parsed.data.model,
    answers,
    usage: parsed.data.usage,
    cache: parsed.data.usage?.input_tokens_details,
  };
}

export function parseEvaluationResponse(
  raw: unknown,
  questions: EvaluationQuestions,
  provider: string,
  requestedModel: string,
  protocol: EvaluationProtocol,
): EvaluationResult {
  const invalid = (): never => {
    throw new AiProviderError({
      code: "SCHEMA_VALIDATION_FAILED",
      message: `${protocol} returned answers that do not match the evaluation questions.`,
      provider,
      model: requestedModel,
      retriable: false,
    });
  };
  const vercel = protocol === "vercel-evaluation-v4";
  const openai = protocol === "openai-decisions-v1";
  const gateway = vercel ? vercelSchema.safeParse(raw) : undefined;
  const systemOne =
    vercel || openai ? undefined : systemOneSchema.safeParse(raw);
  if ((gateway && !gateway.success) || (systemOne && !systemOne.success))
    return invalid();
  const gatewayData = gateway?.data;
  const openAiData = openai
    ? (openAiAnswers(raw, provider, requestedModel) ?? invalid())
    : undefined;
  const systemOneData = openAiData ?? systemOne?.data;
  const cache = openAiData?.cache;
  const responseAnswers = gatewayData?.answers ?? systemOneData?.answers;
  if (
    !responseAnswers ||
    Object.keys(responseAnswers).length !== Object.keys(questions).length
  )
    return invalid();
  const confidence: Record<string, number> = Object.create(null);
  const decimals = vercel ? gatewayData?.rounding?.probabilityDecimals : 2;
  const answers = Object.fromEntries(
    Object.entries(questions).map(
      ([id, question]): [string, EvaluationAnswer] => {
        if (!Object.hasOwn(responseAnswers, id)) return invalid();
        const answer = responseAnswers[id]!;
        if (question.type === "boolean") {
          if (answer.type === "noul")
            return [id, { type: "boolean", probability: answer.noul }];
          if (answer.type === "boolean") return [id, answer];
          return invalid();
        }
        if (
          answer.type === "noul" ||
          answer.type === "boolean" ||
          answer.type !== question.type
        )
          return invalid();
        const keys =
          question.type === "choice"
            ? Object.keys(question.criteria)
            : question.criteria.map((_, index) => String(index));
        if (answer.probabilities) {
          if (
            Object.keys(answer.probabilities).length !== keys.length ||
            keys.some((key) => !Object.hasOwn(answer.probabilities!, key))
          )
            return invalid();
          const sum = Object.values(answer.probabilities).reduce(
            (total, p) => total + p,
            0,
          );
          const tolerance =
            decimals === undefined
              ? 1e-8
              : keys.length * 0.5 * 10 ** -decimals + 1e-8;
          if (Math.abs(sum - 1) > tolerance) return invalid();
        }
        if (answer.confidence != null) confidence[id] = answer.confidence;
        const distribution = answer.probabilities
          ? { probabilities: answer.probabilities }
          : {};
        if (answer.type === "choice") {
          if (!keys.includes(answer.choice)) return invalid();
          return [
            id,
            { type: "choice", choice: answer.choice, ...distribution },
          ];
        }
        if (answer.score < 0 || answer.score > keys.length - 1)
          return invalid();
        return [id, { type: "score", score: answer.score, ...distribution }];
      },
    ),
  );
  return {
    model: systemOneData?.model ?? requestedModel,
    answers,
    usage: {
      inputTokens:
        gatewayData?.usage?.inputTokens ??
        systemOneData?.usage?.input_tokens ??
        0,
      outputTokens:
        gatewayData?.usage?.outputTokens ??
        systemOneData?.usage?.output_tokens ??
        0,
      ...(cache?.cached_tokens != null
        ? { cachedInputTokens: cache.cached_tokens }
        : {}),
      ...(cache?.cache_write_tokens != null
        ? { cacheWriteInputTokens: cache.cache_write_tokens }
        : {}),
    },
    providerMetadata: vercel
      ? {
          ...gatewayData?.providerMetadata,
          vercel: {
            ...gatewayData?.providerMetadata?.vercel,
            rounding: gatewayData?.rounding,
            warnings: gatewayData?.warnings,
          },
        }
      : {
          [protocol === "openrouter-decisions-v1"
            ? "openrouter"
            : openai
              ? "openai"
              : "typesafe"]: {
            confidence,
            probabilityDecimals: 2,
            scoreDecimals: 2,
            ...(systemOneData?.id ? { id: systemOneData.id } : {}),
            ...(systemOneData?.provider
              ? { provider: systemOneData.provider }
              : {}),
            ...(systemOneData?.usage?.cost != null
              ? { cost: systemOneData.usage.cost }
              : {}),
          },
        },
  };
}
