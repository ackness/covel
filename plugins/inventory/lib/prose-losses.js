/**
 * Losses the ledger took from the story's prose, per story turn and item.
 *
 * In one execution the ledger skips a prose loss that a write-service removal
 * already paid (`lib/applied-operations.js`). A scoped retry runs in a later
 * execution: a removal it pays through `inventory.change@1` cannot be seen by
 * the ledger that already ran, so the ledger records what it took here and
 * the change service claims a retry's removals from it before it takes
 * anything from the bag.
 *
 * One key per story turn and item (`<turnId>/<normalized item>`), whose value
 * is the unclaimed quantity. Both sides write only `inc` operations, which
 * apply to the latest value at commit: recording and claiming different items,
 * or different parts of one item's credit, from separate runs commit together.
 * A claim keeps `min: 0`, so two runs that both claimed the last unit cannot
 * both commit; the second one's operation is refused as a conflict.
 */

export const PROSE_LOSSES_NAMESPACE = "prose-losses";

const normalized = (name) => name.trim().toLowerCase();

/** The key of one item's credit for a story turn. */
function proseLossKey(turnId, name) {
  return `${turnId}/${normalized(name)}`;
}

/** `{ key, by }` for each item in `taken` (`{ name, quantity }`), summed. */
export function proseLossCredits(turnId, taken) {
  const credits = new Map();
  for (const { name, quantity } of taken) {
    const key = proseLossKey(turnId, name);
    credits.set(key, (credits.get(key) ?? 0) + quantity);
  }
  return [...credits].map(([key, by]) => ({ key, by }));
}

/**
 * Claim the removals in `changes` from the story turn's credit. `creditOf`
 * reads one key's unclaimed quantity. Returns the changes still to apply, the
 * removals fully settled, and the claims to write as `{ key, by }` (negative).
 */
export async function claimProseLosses(turnId, changes, creditOf) {
  const claimedByKey = new Map();
  const credits = new Map();
  const remaining = [];
  const settled = [];
  for (const change of changes) {
    if (change.op !== "remove") {
      remaining.push(change);
      continue;
    }
    const key = proseLossKey(turnId, change.name);
    if (!credits.has(key)) {
      const credit = await creditOf(key);
      credits.set(key, typeof credit === "number" && credit > 0 ? credit : 0);
    }
    const owed = change.quantity ?? 1;
    const claimed = Math.min(owed, credits.get(key));
    credits.set(key, credits.get(key) - claimed);
    if (claimed > 0)
      claimedByKey.set(key, (claimedByKey.get(key) ?? 0) + claimed);
    if (claimed === owed) settled.push(change);
    else
      remaining.push(
        claimed > 0 ? { ...change, quantity: owed - claimed } : change,
      );
  }
  const claims = [...claimedByKey].map(([key, claimed]) => ({
    key,
    by: -claimed,
  }));
  return { changes: remaining, settled, claims };
}
