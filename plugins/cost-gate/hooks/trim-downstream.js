import { total, limits } from "./budget.js";

/**
 * PreSchedule — once the session crosses the soft cap, drop every non-story
 * runtime from this turn's schedule so only the main narrative keeps running.
 *
 * Story runtimes are identified by `manifest.outputKind === "story"` — never by
 * hardcoded plugin ids (framework / plugin isolation rule). Pre-Game runtimes
 * (priority <= 99) are force-retained by the framework regardless, so this only
 * ever trims the main loop. Returns plain `continue` (same `triggered`
 * reference) when there is nothing to drop, so the no-change fast path stays
 * byte-identical and the Pre-Game retain guard is not engaged needlessly.
 *
 * @param {{ sessionId: string }} ctx
 * @param {{ triggered: ReadonlyArray<{ outputKind?: string }> }} payload
 * @returns {Promise<{ action: "continue", replace?: { triggered: ReadonlyArray<unknown> } }>}
 */
export default async function trimDownstream(ctx, payload) {
  if (total(ctx.sessionId) < limits.soft) return { action: "continue" };
  const triggered = payload?.triggered ?? [];
  const onlyStory = triggered.filter((m) => m && m.outputKind === "story");
  if (onlyStory.length === triggered.length) return { action: "continue" };
  return { action: "continue", replace: { triggered: onlyStory } };
}
