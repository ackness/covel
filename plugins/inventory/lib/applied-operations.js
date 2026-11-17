const normalized = (name) => name.trim().toLowerCase();

/** Exclude changes the bag operations have already accounted for. */
export function unappliedInventoryChanges(changes, operations = []) {
  const remaining = [...changes];
  let alreadyApplied = 0;
  for (const operation of operations) {
    if (operation.contract !== "inventory.change@1") continue;
    // Request and result are bounded independently. Long descriptions can
    // hide the request while the service's compact result still names every
    // handled change. Its quantity is the final holding, not a delta.
    const request = operation.request?.changes;
    const hasRequest = Array.isArray(request);
    const handled = hasRequest ? request : operation.result?.results;
    if (!Array.isArray(handled)) continue;
    for (const applied of handled) {
      if (typeof applied?.item !== "string") continue;
      const item = normalized(applied.item);
      const match = (change) =>
        change.op === applied.op && normalized(change.name) === item;
      let index = remaining.findIndex(match);
      if (index === -1) continue;
      alreadyApplied += 1;
      if (!hasRequest || applied.op !== "remove") {
        remaining.splice(index, 1);
        continue;
      }
      let paid = applied.quantity ?? 1;
      while (index !== -1 && paid > 0) {
        const change = remaining[index];
        const quantity = change.quantity ?? 1;
        if (quantity > paid) {
          remaining[index] = { ...change, quantity: quantity - paid };
          break;
        }
        paid -= quantity;
        remaining.splice(index, 1);
        index = remaining.findIndex(match);
      }
    }
  }
  return { changes: remaining, alreadyApplied };
}
