import { total, limits } from "./budget.js";

/**
 * TurnStart — once the session reaches the hard cap, abort the whole turn.
 * The abort reason surfaces to the client so the UI can show "budget reached".
 *
 * @param {{ sessionId: string }} ctx
 * @returns {Promise<{ action: "continue" } | { action: "abort", reason: string }>}
 */
export default async function enforceCap(ctx) {
  if (total(ctx.sessionId) >= limits.hard) {
    return {
      action: "abort",
      reason: "cost-gate: session token budget exhausted",
    };
  }
  return { action: "continue" };
}
