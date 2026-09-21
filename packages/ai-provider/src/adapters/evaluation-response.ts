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
  const gateway = vercel ? vercelSchema.safeParse(raw) : undefined;
  const systemOne = !vercel ? systemOneSchema.safeParse(raw) : undefined;
  if ((gateway && !gateway.success) || (systemOne && !systemOne.success))
    return invalid();
  const gatewayData = gateway?.data;
  const systemOneData = systemOne?.data;
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
          [protocol === "openrouter-decisions-v1" ? "openrouter" : "typesafe"]:
            {
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
