import { add } from "./budget.js";

/**
 * PostLLMResponse — accumulate this call's token usage into the session bucket.
 * Pure observer: never rewrites the response (returns plain `continue`).
 *
 * @param {{ sessionId: string }} ctx
 * @param {{ response?: { usage?: { inputTokens?: number, outputTokens?: number } } }} payload
 * @returns {Promise<{ action: "continue" }>}
 */
export default async function accumulateUsage(ctx, payload) {
  const usage = payload?.response?.usage;
  if (usage) add(ctx.sessionId, usage);
  return { action: "continue" };
}
