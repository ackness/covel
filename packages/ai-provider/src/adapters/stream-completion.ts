import { AiProviderError } from "../errors.js";

/** HTTP 200 does not imply that an SSE generation completed successfully. */
export function assertStreamPayload(
  payload: Record<string, unknown>,
  provider: string,
): void {
  if (
    payload.error ||
    payload.type === "error" ||
    payload.type === "response.failed"
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
