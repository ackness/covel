import { drop } from "./budget.js";

/**
 * SessionEnd — drop the session's bucket so the in-process map does not leak
 * across ended / deleted sessions. Observe-only (returns `continue`).
 *
 * @param {{ sessionId: string }} ctx
 * @returns {Promise<{ action: "continue" }>}
 */
export default async function cleanup(ctx) {
  drop(ctx.sessionId);
  return { action: "continue" };
}
