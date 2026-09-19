import { z } from "zod";
import { AiProviderError } from "../errors.js";
import type {
  EvaluationAnswer,
  EvaluationQuestions,
  EvaluationResult,
} from "../evaluation/types.js";

const probability = z.number().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const responseSchema = z.object({
  model: z.string().min(1).nullish(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("noul"), noul: probability }),
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        probabilities,
        confidence: probability.nullish(),
      }),
      z.object({
        type: z.literal("score"),
        score: z.number(),
        probabilities,
        confidence: probability.nullish(),
      }),
    ]),
  ),
  usage: z
    .object({
      input_tokens: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .nullish(),
      output_tokens: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .nullish(),
    })
    .nullish(),
});

export function parseTypeSafeEvaluation(
  raw: unknown,
  questions: EvaluationQuestions,
  provider: string,
  requestedModel: string,
): EvaluationResult {
  const invalid = (): never => {
    throw new AiProviderError({
      code: "SCHEMA_VALIDATION_FAILED",
      message:
        "System One returned answers that do not match the evaluation questions.",
      provider,
      model: requestedModel,
      retriable: false,
    });
  };
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) return invalid();
  const response = parsed.data;
  if (Object.keys(response.answers).length !== Object.keys(questions).length)
    return invalid();
  const confidence: Record<string, number> = Object.create(null);
  const answers = Object.fromEntries(
    Object.entries(questions).map(
      ([id, question]): [string, EvaluationAnswer] => {
        const answer = response.answers[id];
        if (!answer) return invalid();
        if (question.type === "boolean") {
          if (answer.type !== "noul") return invalid();
          return [id, { type: "boolean", probability: answer.noul }];
        }
        if (answer.type === "noul" || answer.type !== question.type)
          return invalid();
        const keys =
          question.type === "choice"
            ? Object.keys(question.criteria)
            : question.criteria.map((_, index) => String(index));
        if (
          Object.keys(answer.probabilities).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(answer.probabilities, key))
        )
          return invalid();
        const sum = Object.values(answer.probabilities).reduce(
          (total, p) => total + p,
          0,
        );
        // TypeSafe rounds each probability to two decimals; preserve rounded values.
        if (Math.abs(sum - 1) > keys.length * 0.005 + 1e-8) return invalid();
        if (answer.confidence != null) confidence[id] = answer.confidence;
        if (answer.type === "choice") {
          if (!keys.includes(answer.choice)) return invalid();
          return [
            id,
            {
              type: "choice",
              choice: answer.choice,
              probabilities: answer.probabilities,
            },
          ];
        }
        if (answer.score < 0 || answer.score > keys.length - 1)
          return invalid();
        return [
          id,
          {
            type: "score",
            score: answer.score,
            probabilities: answer.probabilities,
          },
        ];
      },
    ),
  );
  return {
    model: response.model ?? requestedModel,
    answers,
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
    },
    providerMetadata: {
      typesafe: { confidence, probabilityDecimals: 2, scoreDecimals: 2 },
    },
  };
}
