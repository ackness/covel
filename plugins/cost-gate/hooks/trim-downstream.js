import { total, resolveLimits } from "./budget.js";

/**
 * PreSchedule — once the session crosses the soft cap, drop the background
 * runtimes that run after the narrative so only the story and its inputs keep
 * running.
 *
 * Story runtimes are identified by `manifest.outputKind === "story"` — never by
 * hardcoded plugin ids (framework / plugin isolation rule). `pre-turn`
 * runtimes are kept too: they prepare the narrative's inputs (dice pools,
 * checks, dimension and world-time context, hidden story cues), so dropping
 * them would change the story rather than save background spend. Setup-stage runtimes
 * are force-retained by the framework regardless, so this only ever trims the
 * main loop. Returns plain `continue` (same `triggered` reference) when there is
 * nothing to drop, so the no-change fast path stays byte-identical and the
 * setup retain guard is not engaged needlessly.
 *
 * The soft cap is resolved per-invocation through the fallback chain
 * per-session `userSettings` → env → default (see budget.js `resolveLimits`).
 * `ctx.getOwnSettings()` is injected by the runtime hook pipeline and returns
 * this plugin's resolved settings; it is absent outside an active hook scope,
 * so the optional-call degrades to env + defaults.
 *
 * @param {{ sessionId: string, getOwnSettings?: () => Record<string, unknown> }} ctx
 * @param {{ triggered: ReadonlyArray<{ outputKind?: string, stage?: string }> }} payload
 * @returns {Promise<{ action: "continue", replace?: { triggered: ReadonlyArray<unknown> } }>}
 */
export default async function trimDownstream(ctx, payload) {
  const { soft } = resolveLimits(ctx.getOwnSettings?.());
  if (total(ctx.sessionId) < soft) return { action: "continue" };
  const triggered = payload?.triggered ?? [];
  const kept = triggered.filter(
    (m) => m && (m.outputKind === "story" || m.stage === "pre-turn"),
  );
  if (kept.length === triggered.length) return { action: "continue" };
  return { action: "continue", replace: { triggered: kept } };
}
