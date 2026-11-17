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
 * checks the narrative was told), the cost plan of failed checks, and the
 * receipts each runtime recorded: the review hook compares the prose with the
 * costs of the failed checks in the receipt the recorder settles.
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
 * The receipts of one runtime in a turn, in the order the kernel chooses the
 * one event of a topic that it delivers (see `selectedReceipt`).
 *
 * @param {any} turn
 * @param {string} runtimeId
 */
function receiptsOf(turn, runtimeId) {
  turn.receipts ??= new Map();
  let entry = turn.receipts.get(runtimeId);
  if (!entry) {
    entry = {};
    turn.receipts.set(runtimeId, entry);
  }
  return entry;
}

/**
 * The receipt of a runtime that the recorder settles. An agent's events are
 * delivered in this order: events in its tool results first, then those it
 * emitted (`emit-event` or a tool's emitted events), each in call order, and
 * only the first event of a topic is delivered. The review hook reads the
 * same receipt, so it asks for the costs the recorder pays.
 *
 * @param {{ result?: unknown, emitted?: unknown } | undefined} entry
 */
function selectedReceipt(entry) {
  return entry?.result ?? entry?.emitted;
}

/**
 * The dice and the check plan that a receipt of this runtime is checked
 * against, or undefined when the turn is not known here or a receipt of the
 * runtime was already recorded.
 *
 * @returns {{ dice: ReadonlyArray<number>, checkPlan: any } | undefined}
 */
export function poolOf(sessionId, turnId, runtimeId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  return turn && !selectedReceipt(turn.receipts?.get(runtimeId))
    ? { dice: turn.dice, checkPlan: turn.checkPlan }
    : undefined;
}

/**
 * A runtime's tool recorded a receipt of this turn. `channel` is `result`
 * for an event in a tool's result and `emitted` for an emitted event. Only
 * the first of each channel counts: the kernel drops a later event of the
 * same topic.
 *
 * @param {"result" | "emitted"} channel
 * @param {{ runtimeId: string, checks: ReadonlyArray<unknown> }} receipt
 */
export function acceptReceipt(sessionId, turnId, channel, receipt) {
  const turn = turns.get(keyOf(sessionId, turnId));
  if (!turn) return;
  const entry = receiptsOf(turn, receipt.runtimeId);
  entry[channel] ??= receipt;
}

/**
 * What the review hook needs for this runtime's story: the dice, both plans
 * and the selected receipt. Undefined when there is no receipt, no cost
 * plan, or the prose was already sent back once for it.
 */
export function reviewOf(sessionId, turnId, runtimeId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  const entry = turn?.receipts?.get(runtimeId);
  const receipt = selectedReceipt(entry);
  if (!receipt || !turn.plan || entry.reviewed) return undefined;
  return {
    plan: turn.plan,
    checkPlan: turn.checkPlan,
    dice: turn.dice,
    receipt,
  };
}

/** This runtime's prose was sent back once; it is not sent back again. */
export function markReviewed(sessionId, turnId, runtimeId) {
  const turn = turns.get(keyOf(sessionId, turnId));
  if (turn) receiptsOf(turn, runtimeId).reviewed = true;
}

export function forgetPool(sessionId, turnId) {
  turns.delete(keyOf(sessionId, turnId));
}
