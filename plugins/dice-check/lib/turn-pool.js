/**
 * The dice of the turns that this process is running.
 *
 * The roller rolls in the `pre-turn` stage. Its dice reach the recorder as a
 * runtime input and reach the store when the turn commits, so neither is
 * there for the guard that checks a receipt while the narrative runs. This
 * map is the guard's copy. It is never the record: a turn that is not here
 * is simply not checked early, and the recorder checks it as always.
 */
const pools = new Map();
const accepted = new Set();
const LIMIT = 500;

function keyOf(sessionId, turnId) {
  return `${sessionId}\n${turnId}`;
}

/** @param {string} sessionId @param {string} turnId @param {ReadonlyArray<number>} dice */
export function rememberPool(sessionId, turnId, dice) {
  if (!sessionId || !turnId) return;
  const key = keyOf(sessionId, turnId);
  pools.set(key, [...dice]);
  accepted.delete(key);
  // Turns end; the oldest entries are of turns that are over.
  while (pools.size > LIMIT) {
    const oldest = pools.keys().next().value;
    pools.delete(oldest);
    accepted.delete(oldest);
  }
}

/**
 * The dice that a receipt of this turn is checked against, or undefined when
 * the turn is not known here or a receipt of it was already let through.
 *
 * @returns {ReadonlyArray<number> | undefined}
 */
export function poolOf(sessionId, turnId) {
  const key = keyOf(sessionId, turnId);
  return accepted.has(key) ? undefined : pools.get(key);
}

/**
 * A receipt of this turn agreed with the dice. `emit-event` records one
 * event of a topic in a turn, so a later receipt of the turn changes nothing
 * and is not sent back a second time.
 */
export function acceptReceipt(sessionId, turnId) {
  const key = keyOf(sessionId, turnId);
  if (pools.has(key)) accepted.add(key);
}

export function forgetPool(sessionId, turnId) {
  const key = keyOf(sessionId, turnId);
  pools.delete(key);
  accepted.delete(key);
}
