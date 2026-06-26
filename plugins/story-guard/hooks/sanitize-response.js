import { sanitize } from "./_rules.js";

/**
 * PostLLMResponse — deterministically sanitise the narrative text before tool
 * dispatch. PostLLMResponse only honours `replace.response` (abort is a no-op
 * here), so any rewrite must hand back a *complete* LLMResponse: we spread the
 * original and swap `content` only, preserving `toolCalls` / `finishReason` /
 * `usage` / `reasoningContent`.
 *
 * Returns a plain `continue` (no replace) when there is nothing to change:
 *   - content is not a non-empty string,
 *   - sanitisation left it unchanged, or
 *   - sanitisation would blank the narrative (conservative: never replace real
 *     content with whitespace-only output).
 *
 * @param {import("@covel/runtime").HookContext} _ctx
 * @param {{ response?: { content?: string | null } & Record<string, unknown> }} payload
 * @returns {Promise<{ action: "continue" } | { action: "continue", replace: { response: Record<string, unknown> } }>}
 */
export default async function sanitizeResponse(_ctx, payload) {
  const response = payload?.response;
  const content = response?.content;
  if (typeof content !== "string" || content === "") {
    return { action: "continue" };
  }

  const cleaned = sanitize(content);
  if (cleaned === content || cleaned.trim() === "") {
    return { action: "continue" };
  }

  return {
    action: "continue",
    replace: { response: { ...response, content: cleaned } },
  };
}
