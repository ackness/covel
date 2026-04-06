export interface RuntimeBindingTargetLike {
  qualifiedId: string;
  providerTag: string;
}

export interface RuntimeBindingSlotLike {
  slotId: string;
  tag: string;
}

/**
 * Keep only bindings for runtimes that still exist in the current UI model.
 * Empty-string values are preserved so an explicitly unbound runtime can stay unbound.
 */
export function filterRuntimeBindingsForKnownRuntimes(
  bindings: Record<string, string>,
  knownRuntimeIds: Iterable<string>,
): Record<string, string> {
  const knownIds = new Set(knownRuntimeIds);
  return Object.fromEntries(
    Object.entries(bindings).filter(([qualifiedId]) => knownIds.has(qualifiedId)),
  );
}

/**
 * Remove empty-string runtime bindings before serializing them into request headers.
 * The server schema only accepts non-empty slot names.
 */
export function sanitizeRuntimeBindingsForHeader(
  bindings: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bindings).filter(([, slotName]) => typeof slotName === "string" && slotName.length > 0),
  );
}

/**
 * Fill every currently unbound runtime with the first compatible slot.
 * Existing non-empty bindings are preserved.
 */
export function autoAssignRuntimeBindings(
  bindings: Record<string, string>,
  targets: readonly RuntimeBindingTargetLike[],
  slots: readonly RuntimeBindingSlotLike[],
): Record<string, string> {
  const next = { ...bindings };

  for (const target of targets) {
    if (next[target.qualifiedId]) continue;
    const compatibleSlot = slots.find((slot) => slot.tag === target.providerTag);
    if (compatibleSlot) {
      next[target.qualifiedId] = compatibleSlot.slotId;
    }
  }

  return next;
}
