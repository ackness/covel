import { unifyFinishReason, type LLMFinishReason } from "@covel/shared";
import { AiProviderError } from "../errors.js";
import type { UsageSummary } from "../types.js";
import { providerErrorKind } from "./provider-error-kind.js";

/**
 * `details.usage` for a failed generation: the tokens the provider had
 * already reported. A failed answer may be billed, and traces count it from
 * here. No usage, or a usage of nothing, is left out rather than written as
 * zero: the provider did not say.
 */
export function failureUsageDetails(
  usage: UsageSummary | undefined,
): { usage: UsageSummary } | Record<string, never> {
  return usage && usage.inputTokens + usage.outputTokens > 0 ? { usage } : {};
}

/**
 * Give a failure from a generation the usage the provider had reported
 * before it, unless the failure already carries one. Other errors pass
 * through unchanged.
 */
export function withFailureUsage(
  error: unknown,
  usage: UsageSummary | undefined,
): unknown {
  if (!(error instanceof AiProviderError) || error.details?.usage) return error;
  const known = failureUsageDetails(usage);
  if (!("usage" in known)) return error;
  const withUsage = new AiProviderError({
    code: error.code,
    message: error.message,
    provider: error.provider,
    ...(error.model !== undefined ? { model: error.model } : {}),
    retriable: error.retriable,
    ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
    details: { ...error.details, ...known },
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
  if (error.stack) withUsage.stack = error.stack;
  return withUsage;
}

/** HTTP 200 does not imply that a generation completed successfully. */
export function assertGenerationPayload(
  payload: Record<string, unknown>,
  provider: string,
  usage?: UsageSummary,
): void {
  if (
    payload.error ||
    payload.type === "error" ||
    payload.type === "response.failed" ||
    payload.status === "failed" ||
    payload.status === "cancelled"
  ) {
    const error =
      payload.error !== null && typeof payload.error === "object"
        ? (payload.error as Record<string, unknown>)
        : payload;
    const providerCode =
      typeof error.code === "string" ? error.code : undefined;
    const providerType =
      typeof error.type === "string" ? error.type : undefined;
    const detail =
      typeof error.message === "string"
        ? error.message
        : typeof payload.error === "string"
          ? payload.error
          : undefined;
    // Every kind the provider names is a fault a second send would repeat.
    const kind = providerErrorKind(providerCode, providerType);
    const refusal = kind === "refusal";
    const permanent = kind !== undefined;
    throw new AiProviderError({
      code: refusal ? "REFUSAL" : "PROVIDER_ERROR",
      message: `${provider} returned a generation error${detail ? `: ${detail}` : ""}`,
      provider,
      retriable: !permanent && payload.status !== "cancelled",
      details: {
        ...failureUsageDetails(usage),
        ...(providerCode ? { providerCode } : {}),
        ...(providerType ? { providerType } : {}),
        ...(refusal
          ? {
              diagnostics: {
                refusal: { reason: "content-filter", message: detail },
              },
            }
          : {}),
      },
    });
  }
}

export function assertStreamCompleted(
  completed: boolean,
  provider: string,
  usage?: UsageSummary,
): void {
  if (!completed) {
    const known = failureUsageDetails(usage);
    throw new AiProviderError({
      code: "PROVIDER_ERROR",
      message: `${provider} stream ended before its terminal event`,
      provider,
      retriable: true,
      ...("usage" in known ? { details: known } : {}),
    });
  }
}

/** Keep custom adapters behind the same success boundary as built-in wires. */
export function assertSuccessfulFinishReason(
  finishReason: string,
  provider: string,
  usage?: UsageSummary,
): void {
  const unified = unifyFinishReason(finishReason);
  if (unified === "content_filter") {
    throw new AiProviderError({
      code: "REFUSAL",
      message: `${provider} refused the generation`,
      provider,
      retriable: false,
      details: {
        ...failureUsageDetails(usage),
        diagnostics: {
          refusal: {
            reason: finishReason === "refusal" ? "refusal" : "content-filter",
          },
        },
      },
    });
  }
  if (unified === "error") {
    throw new AiProviderError({
      code: "PROVIDER_ERROR",
      message: `${provider} reported an error finish reason (${finishReason})`,
      provider,
      retriable: true,
      details: { ...failureUsageDetails(usage), rawFinishReason: finishReason },
    });
  }
}

/**
 * Give a result one finish-reason vocabulary whatever its adapter returned.
 * The provider's own word stays in `rawFinishReason`.
 */
export function withUnifiedFinishReason<T extends { finishReason: string }>(
  result: T,
): T & { finishReason: LLMFinishReason; rawFinishReason: string } {
  return {
    ...result,
    finishReason: unifyFinishReason(result.finishReason),
    rawFinishReason: result.finishReason,
  };
}
