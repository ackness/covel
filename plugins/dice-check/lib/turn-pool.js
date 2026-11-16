/**
 * The dice of the turns that this process is running.
 *
 * The roller rolls in the `pre-turn` stage. Its dice reach the recorder as a
 * runtime input and reach the store when the turn commits, so neither is
 * there for the hooks that run while the narrative runs. This map is their
 * copy. It is never the record: a turn that is not here is simply not
 * checked early, and the recorder checks it as always.
 *
 * Each turn keeps its dice, its check plan (the modifiers and the harder
 * checks the narrative was told), the cost plan of failed checks, and, once
 * a receipt was recorded, that receipt: the review hook compares the prose
 * with the costs of the receipt's failed checks.
 */
const turns = new Map();
const LIMIT = 500;

function keyOf(sessionId, turnId) {
  return `${sessionId}\n${turnId}`;
}

/**
 * @param {string} sessionId
 * @param {string} turnId
 * @param {ReadonlyArray<number>} dice
 * @param {{ costPlan?: unknown, checkPlan?: unknown }} [plans]
 */
export function rememberPool(sessionId, turnId, dice, plans = {}) {
  if (!sessionId || !turnId) return;
  const key = keyOf(sessionId, turnId);
  turns.delete(key);
  turns.set(key, {
    dice: [...dice],
    plan: plans.costPlan ?? null,
    checkPlan: plans.checkPlan ?? null,
  });
  // Turns end; the oldest entries are of turns that are over.
  while (turns.size > LIMIT) turns.delete(turns.keys().next().value);
}

/**
 * The dice and the check plan that a receipt of this turn is checked
 * against, or undefined when the turn is not known here or a receipt of it
 * was already let through.
 *
 * @returns {{ dice: ReadonlyArray<number>, checkPlan: any } | undefined}
 */
export function poolOf(sessionId, turnId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  return turn && !turn.receipt
    ? { dice: turn.dice, checkPlan: turn.checkPlan }
    : undefined;
}

/**
 * A receipt of this turn was recorded. `emit-event` records one event of a
 * topic in a turn, so a later receipt of the turn changes nothing and is not
 * sent back a second time.
 *
 * @param {{ runtimeId: string, checks: ReadonlyArray<unknown> }} receipt
 */
export function acceptReceipt(sessionId, turnId, receipt) {
  const turn = turns.get(keyOf(sessionId, turnId));
  if (turn) turn.receipt = receipt;
}

/**
 * What the review hook needs for this turn: the dice, both plans and the
 * recorded receipt. Undefined when there is no receipt, no cost plan, or the
 * prose was already sent back once for it.
 */
export function reviewOf(sessionId, turnId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  if (!turn?.receipt || !turn.plan || turn.reviewed) return undefined;
  return {
    plan: turn.plan,
    checkPlan: turn.checkPlan,
    dice: turn.dice,
    receipt: turn.receipt,
  };
}

/** The prose of this turn was sent back once; it is not sent back again. */
export function markReviewed(sessionId, turnId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  if (turn) turn.reviewed = true;
}

export function forgetPool(sessionId, turnId) {
  turns.delete(keyOf(sessionId, turnId));
}
