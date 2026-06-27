import { total, resolveLimits } from "./budget.js";

/**
 * TurnStart — once the session reaches the hard cap, abort the whole turn.
 * The abort reason surfaces to the client so the UI can show "budget reached".
 *
 * The hard cap is resolved per-invocation through the fallback chain
 * per-session `userSettings` → env → default (see budget.js `resolveLimits`).
 * `ctx.getOwnSettings()` is injected by the runtime hook pipeline and returns
 * this plugin's resolved settings; it is absent outside an active hook scope,
 * so the optional-call degrades to env + defaults.
 *
 * @param {{ sessionId: string, getOwnSettings?: () => Record<string, unknown> }} ctx
 * @returns {Promise<{ action: "continue" } | { action: "abort", reason: string }>}
 */
export default async function enforceCap(ctx) {
  const { hard } = resolveLimits(ctx.getOwnSettings?.());
  if (total(ctx.sessionId) >= hard) {
    return {
      action: "abort",
      reason: "cost-gate: session token budget exhausted",
    };
  }
  return { action: "continue" };
}
