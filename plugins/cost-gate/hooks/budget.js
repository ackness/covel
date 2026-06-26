/**
 * Per-session token accounting for cost-gate.
 *
 * In-process and non-persistent:
 *   - resets on server restart;
 *   - NOT shared across processes (PostgreSQL / multi-instance T3 tier) — there
 *     it is a per-process soft signal, not a global hard cap. A single-process
 *     T1/T2 self-host gets a true cap. See README.
 *
 * Thresholds come from env because hooks cannot read SettingsStore /
 * userSettings. They are read lazily (getters) so a deployment can change them
 * without restarting and tests can override per-case.
 */

/** @type {Map<string, { input: number, output: number }>} */
const buckets = new Map();

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

export const limits = {
  /** TurnStart aborts the turn at/above this total. */
  get hard() {
    return readLimit("COST_GATE_HARD_TOKENS", 200_000);
  },
  /** PreSchedule trims background runtimes at/above this total. */
  get soft() {
    return readLimit("COST_GATE_SOFT_TOKENS", 150_000);
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
  const prev = buckets.get(sessionId) ?? { input: 0, output: 0 };
  buckets.set(sessionId, {
    input: prev.input + input,
    output: prev.output + output,
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

/** Test-only: clear all buckets. */
export function _reset() {
  buckets.clear();
}
