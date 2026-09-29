import { AiProviderError } from "../errors.js";

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
    throw new AiProviderError({
      code: "PROVIDER_ERROR",
      message: `${provider} returned a generation error`,
      provider,
      retriable: true,
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
  if (
    finishReason === "refusal" ||
    finishReason === "content_filter" ||
    finishReason === "content-filter"
  ) {
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
  if (finishReason === "error") {
    throw new AiProviderError({
      code: "PROVIDER_ERROR",
      message: `${provider} reported an error finish reason`,
      provider,
      retriable: true,
    });
  }
}
