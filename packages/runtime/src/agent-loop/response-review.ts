import { instructionLocaleFor } from "@covel/shared";
import type { LLMMessage, LLMResponse } from "../llm/llm-adapter.js";
import { runPostLLMResponseHook } from "../hooks/wire-helpers.js";

/** Rejected drafts never dispatch tools or become the committed narrative. */
export function createResponseReviewer(
  opts: Parameters<typeof runPostLLMResponseHook>[0],
  transcript: LLMMessage[],
  locale?: string,
) {
  let corrections = 0;
  const notAccepted =
    instructionLocaleFor(locale) === "zh"
      ? "草稿未被接受。改正后重新发送完整的回复——被拒绝的草稿不会被执行，也不会被提交。不要描述改正的过程。"
      : "The draft was not accepted. Correct it and resend the complete response — the rejected draft will not be executed or committed. Do not describe the correction process.";
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
    // The reasoning goes back with the draft: thinking-mode providers
    // (DeepSeek, DashScope Qwen) reject an assistant turn without it, and the
    // continuation tells the adapter which wire field carries it.
    if (reviewed.response.content) {
      const { reasoningContent, providerContinuation } = reviewed.response;
      transcript.push({
        role: "assistant",
        content: reviewed.response.content,
        ...(reasoningContent ? { reasoningContent } : {}),
        ...(providerContinuation ? { providerContinuation } : {}),
      });
    }
    transcript.push({
      role: "system",
      content: `${notAccepted}\n${reviewed.correction}`,
    });
    return undefined;
  };
}
