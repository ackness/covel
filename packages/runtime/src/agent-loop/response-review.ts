import type { LLMMessage, LLMResponse } from "../llm/llm-adapter.js";
import { runPostLLMResponseHook } from "../hooks/wire-helpers.js";

/** Rejected drafts never dispatch tools or become the committed narrative. */
export function createResponseReviewer(
  opts: Parameters<typeof runPostLLMResponseHook>[0],
  transcript: LLMMessage[],
) {
  let corrections = 0;
  return async (
    response: LLMResponse,
    requestMessages: readonly LLMMessage[],
  ): Promise<LLMResponse | undefined> => {
    const reviewed = await runPostLLMResponseHook(
      opts,
      response,
      requestMessages,
    );
    if (!reviewed.correction) return reviewed.response;
    if (++corrections > 2) {
      throw new Error(`Response validation failed: ${reviewed.correction}`);
    }
    // No tool-call IDs: this rejected batch was deliberately not executed.
    if (reviewed.response.content) {
      transcript.push({
        role: "assistant",
        content: reviewed.response.content,
      });
    }
    transcript.push({
      role: "system",
      content: `The draft was not accepted. Correct it and resend the complete response — the rejected draft will not be executed or committed. Do not describe the correction process.\n${reviewed.correction}`,
    });
    return undefined;
  };
}
