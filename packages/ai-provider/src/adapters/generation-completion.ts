import { unifyFinishReason, type LLMFinishReason } from "@covel/shared";
import { AiProviderError } from "../errors.js";
import { providerErrorKind } from "./provider-error-kind.js";

/** HTTP 200 does not imply that a generation completed successfully. */
export function assertGenerationPayload(
  payload: Record<string, unknown>,
  provider: string,
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
): void {
  if (!completed) {
    throw new AiProviderError({
      code: "PROVIDER_ERROR",
      message: `${provider} stream ended before its terminal event`,
      provider,
      retriable: true,
    });
  }
}

/** Keep custom adapters behind the same success boundary as built-in wires. */
export function assertSuccessfulFinishReason(
  finishReason: string,
  provider: string,
): void {
  const unified = unifyFinishReason(finishReason);
  if (unified === "content_filter") {
    throw new AiProviderError({
      code: "REFUSAL",
      message: `${provider} refused the generation`,
      provider,
      retriable: false,
      details: {
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
      message: `${provider} reported an error finish reason`,
      provider,
      retriable: true,
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
