/**
 * Per-session token accounting for cost-gate.
 *
 * In-process and non-persistent:
 *   - resets on server restart;
 *   - NOT shared across processes (PostgreSQL / multi-instance T3 tier) — there
 *     it is a per-process soft signal, not a global hard cap. A single-process
 *     T1/T2 self-host gets a true cap. See README.
 *   - bounded to MAX_TRACKED_SESSIONS so sessions that never reach SessionEnd
 *     (abandoned / paused) cannot grow the map without limit.
 *
 * Thresholds resolve through a three-tier fallback chain, evaluated per hook
 * invocation:
 *   1. per-session userSettings — the plugin's own resolved `userSettings`,
 *      read in-hook via `HookContext.getOwnSettings()` (the runtime hook
 *      pipeline injects a frozen snapshot of manifest defaults merged with the
 *      player's saved values). Lets the budget be configured per-session /
 *      per-player.
 *   2. env var — `COST_GATE_SOFT_TOKENS` / `COST_GATE_HARD_TOKENS`. Kept as a
 *      deployment-wide fallback so installs that set only the env keep working.
 *   3. hardcoded default — 400000 / 600000.
 * The env and defaults are read lazily (per call) so a deployment can change
 * them without restarting and tests can override per-case.
 */

/** @type {Map<string, { input: number, output: number }>} */
const buckets = new Map();

/**
 * Upper bound on tracked sessions. SessionEnd drops a session's bucket, so this
 * only bites when sessions are abandoned / paused and never end. At this size
 * the footprint stays trivial; eviction (oldest-first) merely resets the budget
 * of a very old session, which would re-accumulate on its next LLM call.
 */
const MAX_TRACKED_SESSIONS = 10_000;

/**
 * Last-resort thresholds when neither userSettings nor env supply a value.
 * Calibrated to be GENEROUS: `total()` tracks CUMULATIVE session tokens, and a
 * multi-runtime turn spends tens of thousands, so the old 150k/200k aborted a
 * normal session after only ~5 turns (mistport already overrode them to
 * 400k/600k for exactly this reason). These match that tested-generous band so
 * cost-gate catches runaway loops without trimming ordinary play.
 *
 * ponytail: cumulative-total model, fixed default; a very long legit session
 * still eventually hits any fixed cap. A per-turn / sliding-window spike model
 * would separate "long session" from "runaway" — upgrade there if long
 * playthroughs start hitting the cap.
 */
const DEFAULT_SOFT_TOKENS = 400_000;
const DEFAULT_HARD_TOKENS = 600_000;

let warnedMisconfig = false;

/**
 * Coerce a candidate to a strictly-positive finite number, or `undefined` when
 * it is absent / blank / non-numeric / non-positive. Shared by every tier of
 * the fallback chain so userSettings, env, and defaults are validated
 * identically.
 *
 * @param {unknown} value
 * @returns {number | undefined}
 */
function positiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve a single threshold through the fallback chain:
 *   per-session userSettings → env var → hardcoded default.
 *
 * @param {unknown} settingValue  per-session userSettings value (may be undefined)
 * @param {string} envName
 * @param {number} fallback
 * @returns {number}
 */
function resolveOne(settingValue, envName, fallback) {
  return (
    positiveNumber(settingValue) ??
    positiveNumber(process.env[envName]) ??
    fallback
  );
}

/**
 * Resolve both thresholds together for a single hook invocation and warn once
 * if misconfigured: when the soft cap is not strictly below the hard cap,
 * `trim-downstream` can never fire before `enforce-cap` aborts the turn, so
 * graceful downstream trimming is effectively disabled. The hard cap still
 * protects spend — this surfaces the misconfig instead of degrading silently.
 *
 * `ownSettings` is the plugin's per-session resolved `userSettings`, i.e. the
 * value of `ctx.getOwnSettings?.()` inside a hook. Pass `undefined` (or omit)
 * to resolve from env + defaults only — the path tests and scope-less callers
 * exercise.
 *
 * @param {Record<string, unknown>} [ownSettings]
 * @returns {{ soft: number, hard: number }}
 */
export function resolveLimits(ownSettings) {
  const hard = resolveOne(
    ownSettings?.hardTokens,
    "COST_GATE_HARD_TOKENS",
    DEFAULT_HARD_TOKENS,
  );
  const soft = resolveOne(
    ownSettings?.softTokens,
    "COST_GATE_SOFT_TOKENS",
    DEFAULT_SOFT_TOKENS,
  );
  if (!warnedMisconfig && soft >= hard) {
    warnedMisconfig = true;
    console.warn(
      `[cost-gate] soft cap (${soft}) >= hard cap (${hard}); ` +
        "the soft cap will never trim before the hard cap aborts the turn. " +
        "Set the soft cap below the hard cap to enable graceful downstream trimming.",
    );
  }
  return { soft, hard };
}

/**
 * @param {string} sessionId
 * @param {{ inputTokens?: number, outputTokens?: number }} usage
 */
export function add(sessionId, usage) {
  if (!sessionId || !usage) return;
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  if (input === 0 && output === 0) return;
  const prev = buckets.get(sessionId);
  if (!prev && buckets.size >= MAX_TRACKED_SESSIONS) {
    // Evict the oldest tracked session (Map preserves insertion order) so an
    // unbounded stream of never-ended sessions cannot grow the map forever.
    const oldest = buckets.keys().next().value;
    if (oldest !== undefined) buckets.delete(oldest);
  }
  const base = prev ?? { input: 0, output: 0 };
  buckets.set(sessionId, {
    input: base.input + input,
    output: base.output + output,
  });
}

/**
 * @param {string} sessionId
 * @returns {number} total tokens (input + output) accounted for this session
 */
export function total(sessionId) {
  const b = buckets.get(sessionId);
  return b ? b.input + b.output : 0;
}

/** @param {string} sessionId */
export function drop(sessionId) {
  buckets.delete(sessionId);
}

/** Test-only: clear all buckets and reset one-time warnings. */
export function _reset() {
  buckets.clear();
  warnedMisconfig = false;
}
