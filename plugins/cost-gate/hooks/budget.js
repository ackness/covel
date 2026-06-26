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
 * Thresholds come from env because hooks cannot read SettingsStore /
 * userSettings. They are read lazily (getters) so a deployment can change them
 * without restarting and tests can override per-case.
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

let warnedMisconfig = false;

/**
 * @param {string} name
 * @param {number} fallback
 * @returns {number}
 */
function readLimit(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve both thresholds together and warn once if misconfigured: when the soft
 * cap is not strictly below the hard cap, `trim-downstream` can never fire before
 * `enforce-cap` aborts the turn, so graceful downstream trimming is effectively
 * disabled. The hard cap still protects spend — this surfaces the misconfig
 * instead of degrading silently.
 *
 * @returns {{ soft: number, hard: number }}
 */
function resolveLimits() {
  const hard = readLimit("COST_GATE_HARD_TOKENS", 200_000);
  const soft = readLimit("COST_GATE_SOFT_TOKENS", 150_000);
  if (!warnedMisconfig && soft >= hard) {
    warnedMisconfig = true;
    console.warn(
      `[cost-gate] COST_GATE_SOFT_TOKENS (${soft}) >= COST_GATE_HARD_TOKENS (${hard}); ` +
        "the soft cap will never trim before the hard cap aborts the turn. " +
        "Set the soft cap below the hard cap to enable graceful downstream trimming.",
    );
  }
  return { soft, hard };
}

export const limits = {
  /** TurnStart aborts the turn at/above this total. */
  get hard() {
    return resolveLimits().hard;
  },
  /** PreSchedule trims background runtimes at/above this total. */
  get soft() {
    return resolveLimits().soft;
  },
};

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
