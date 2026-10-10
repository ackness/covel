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
import {
  ProviderResponseTooLargeError,
  readResponseJson,
} from "./http/response.js";
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
  | "typesafe-systemone-v1"
  | "openrouter-decisions-v1"
  | "vercel-evaluation-v4"
  | "openai-decisions-v1";

type EvaluationRequest = z.infer<typeof requestSchema>;

/** The Decisions API takes text; state and rubrics that are JSON go as JSON. */
function decisionText(input: z.infer<typeof value>): string {
  return typeof input === "string" ? input : JSON.stringify(input);
}

/**
 * OpenAI Decisions (`POST /v1/decisions`): questions are a list that carries
 * each name, a boolean is a `predicate`, choices and score levels are lists.
 */
function openAiDecisionsBody(request: EvaluationRequest) {
  return {
    model: request.model,
    input: decisionText(request.state),
    questions: Object.entries(request.questions).map(([name, question]) => {
      const instructions = decisionText(question.instructions ?? "");
      if (question.type === "boolean") {
        // A predicate has one text field, so the two rubrics join it.
        const rubric = (["true", "false"] as const).flatMap((side) =>
          question.criteria?.[side] == null
            ? []
            : [
                `Criteria for ${side}:\n${decisionText(question.criteria[side])}`,
              ],
        );
        return {
          type: "predicate",
          name,
          instructions: [instructions, ...rubric]
            .filter((part) => part !== "")
            .join("\n\n"),
        };
      }
      if (question.type === "choice")
        return {
          type: "choice",
          name,
          instructions,
          choices: Object.entries(question.criteria).map(
            ([choice, description]) => ({
              value: choice,
              ...(description == null
                ? {}
                : { description: decisionText(description) }),
            }),
          ),
        };
      return {
        type: "score",
        name,
        instructions,
        // A level has no name of its own here; its index identifies it.
        levels: question.criteria.map((description, index) => ({
          label: String(index),
          ...(description == null
            ? {}
            : { description: decisionText(description) }),
        })),
      };
    }),
  };
}

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
    const openai = protocol === "openai-decisions-v1";
    if (
      openai &&
      Object.values(request.questions).some(
        (question) =>
          question.type === "choice" &&
          Object.keys(question.criteria).length < 2,
      )
    ) {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        message: "OpenAI Decisions requires 2-255 options for a choice.",
        provider,
        model: params.model,
        retriable: false,
      });
    }
    const body = openai
      ? openAiDecisionsBody(request)
      : {
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
    if (openai) {
      // The base is the chat base (`…/v1`) or the endpoint itself.
      path = "/decisions";
      if (baseUrl) {
        const url = new URL(baseUrl);
        url.pathname = url.pathname
          .replace(/\/+$/, "")
          .replace(/\/decisions$/, "");
        baseUrl = url.toString();
      }
    } else if (baseUrl && protocol === "typesafe-systemone-v1") {
      // A base that already includes the endpoint stays idempotent — without
      // this strip, buildProviderUrl would append `/v1/systemone` again.
      const url = new URL(baseUrl);
      url.pathname = url.pathname
        .replace(/\/+$/, "")
        .replace(/\/(?:v1\/)?systemone$/, "");
      baseUrl = url.toString();
    } else if (baseUrl) {
      const url = new URL(baseUrl);
      const evalPath = vercel
        ? "/v4/ai/evaluation-model"
        : "/api/alpha/decisions";
      // Accept the shared chat base or the evaluation API base, preserving
      // proxy prefixes. Strip the eval endpoint itself first so a base that
      // already points at it does not get the path appended twice.
      let pathname = url.pathname.replace(/\/+$/, "");
      if (pathname.endsWith(evalPath)) {
        pathname = pathname.slice(0, -evalPath.length);
      }
      url.pathname = pathname.replace(
        vercel ? /\/(?:v1|v4\/ai)$/ : /\/api(?:\/(?:v1|alpha))?$/,
        "",
      );
      baseUrl = url.toString();
      path = { append: evalPath };
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
      raw = await readResponseJson(response);
    } catch (cause) {
      config.signal?.throwIfAborted();
      if (cause instanceof ProviderResponseTooLargeError) throw cause;
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
