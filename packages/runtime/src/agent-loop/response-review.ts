import type { LLMMessage, LLMResponse } from "@covel/shared";
import { runPostLLMResponseHook } from "../hooks/wire-helpers.js";

/** Review the actual response once. The loop owns correlated rejection results. */
export function createResponseReviewer(
  opts: Parameters<typeof runPostLLMResponseHook>[0],
) {
  return async (
    response: LLMResponse,
    requestMessages: readonly LLMMessage[],
  ) => {
    const reviewed = await runPostLLMResponseHook(
      opts,
      response,
      requestMessages,
    );
    return {
      response: {
        ...reviewed.response,
        // A response hook cannot invent provider calls or change their identity.
        // Name/argument rewrites still pass the effective-name authorization gate.
        toolCalls: response.toolCalls.map((call, index) => ({
          ...(reviewed.response.toolCalls[index] ?? call),
          id: call.id,
        })),
        reasoningContent: response.reasoningContent,
        providerContinuation: response.providerContinuation,
      },
      correction: reviewed.correction?.slice(0, 2000),
    };
  };
}
