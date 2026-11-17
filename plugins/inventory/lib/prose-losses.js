/**
 * Losses the ledger took from the story's prose, per story turn.
 *
 * In one execution the ledger skips a prose loss that a write-service removal
 * already paid (`lib/applied-operations.js`). A scoped retry runs in a later
 * execution: a removal it pays through `inventory.change@1` cannot be seen by
 * the ledger that already ran, so the ledger records what it took here, keyed
 * by the story turn, and the change service settles a retry's removals
 * against that record before it takes anything from the bag.
 *
 * Value: `{ losses: [{ item, quantity, attempt }] }`, where `item` is the
 * normalized name, `quantity` what is still unclaimed, and `attempt` the
 * execution's turn that took it.
 */

export const PROSE_LOSSES_NAMESPACE = "prose-losses";

const normalized = (name) => name.trim().toLowerCase();

/** The losses with `taken` appended. `taken` lists `{ name, quantity }`. */
export function recordProseLosses(record, taken, attempt) {
  return {
    losses: [
      ...(Array.isArray(record?.losses) ? record.losses : []),
      ...taken.map(({ name, quantity }) => ({
        item: normalized(name),
        quantity,
        attempt,
      })),
    ],
  };
}

/**
 * Settle the removals in `changes` against losses another execution of the
 * same story turn already took. Returns the changes still to apply, the
 * removals fully settled, and the updated record (`undefined` when nothing
 * was settled).
 */
export function settleWithProseLosses(record, changes, attempt) {
  const losses = (Array.isArray(record?.losses) ? record.losses : []).map(
    (loss) => ({ ...loss }),
  );
  const remaining = [];
  const settled = [];
  let changed = false;
  for (const change of changes) {
    if (change.op !== "remove") {
      remaining.push(change);
      continue;
    }
    let owed = change.quantity ?? 1;
    for (const loss of losses) {
      if (owed === 0) break;
      if (
        loss.attempt === attempt ||
        loss.item !== normalized(change.name) ||
        !(loss.quantity > 0)
      )
        continue;
      const claimed = Math.min(owed, loss.quantity);
      loss.quantity -= claimed;
      owed -= claimed;
      changed = true;
    }
    if (owed === 0) settled.push(change);
    else remaining.push({ ...change, quantity: owed });
  }
  return {
    changes: remaining,
    settled,
    record: changed
      ? { losses: losses.filter((loss) => loss.quantity > 0) }
      : undefined,
  };
}
