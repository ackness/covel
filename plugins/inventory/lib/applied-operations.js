const normalized = (name) => name.trim().toLowerCase();

/** Remove one extracted change for each change already made by a bag operation. */
export function unappliedInventoryChanges(changes, operations = []) {
  const remaining = [...changes];
  let alreadyApplied = 0;
  for (const operation of operations) {
    if (operation.contract !== "inventory.change@1") continue;
    // Request and result are bounded independently. Long descriptions can
    // hide the request while the service's compact result still names every
    // handled change. Its quantity is the final holding, not a delta.
    const handled = Array.isArray(operation.request?.changes)
      ? operation.request.changes
      : operation.result?.results;
    if (!Array.isArray(handled)) continue;
    for (const applied of handled) {
      if (typeof applied?.item !== "string") continue;
      const index = remaining.findIndex(
        (change) =>
          change.op === applied.op &&
          normalized(change.name) === normalized(applied.item),
      );
      if (index < 0) continue;
      remaining.splice(index, 1);
      alreadyApplied += 1;
    }
  }
  return { changes: remaining, alreadyApplied };
}
