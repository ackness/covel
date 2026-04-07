export interface RuntimeBindingTargetLike {
  qualifiedId: string;
  providerTag: string;
  /** Runtime kind (e.g. "story", "plugin") — used for slot name hinting when tags are ambiguous. */
  kind?: string;
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
 * Fill every currently unbound runtime with the best matching slot.
 * Existing non-empty bindings are preserved.
 *
 * Matching priority (per runtime):
 * 0. Direct name match: slot whose slotId === runtime.providerTag (highest priority)
 * 1. Exact tag match (slot.tag === runtime.providerTag, only when tags are distinct)
 * 2. Slot name matches runtime kind (e.g. kind="story" → slot named "story")
 * 3. Slot named "plugin" or "fast" for non-story plugin runtimes
 * 4. Default slot (slotId === "default") or first available slot
 */
export function autoAssignRuntimeBindings(
  bindings: Record<string, string>,
  targets: readonly RuntimeBindingTargetLike[],
  slots: readonly RuntimeBindingSlotLike[],
): Record<string, string> {
  if (slots.length === 0) return { ...bindings };

  const next = { ...bindings };
  const defaultSlot = slots.find((s) => s.slotId === "default") ?? slots[0];

  // Check whether all slots have the same tag (ambiguous — rely on name hints)
  const uniqueTags = new Set(slots.map((s) => s.tag));
  const tagsAreAmbiguous = uniqueTags.size <= 1;

  for (const target of targets) {
    if (next[target.qualifiedId]) continue;

    let chosen: RuntimeBindingSlotLike | undefined;

    // 0. Direct name match — slot named exactly as the providerTag takes highest priority
    //    e.g. providerTag: "plugin" → slot named "plugin", providerTag: "image" → slot named "image"
    chosen = slots.find((s) => s.slotId === target.providerTag);

    // 1. For non-story plugin runtimes, prefer "plugin"/"fast" slot over first tag match.
    //    This ensures runtimes with providerTag: "text" and kind: "plugin" use the dedicated
    //    plugin slot (e.g. a larger model) rather than the default text slot.
    if (!chosen && target.kind !== "story" && target.kind !== "background") {
      chosen = slots.find((s) => s.slotId === "plugin") ?? slots.find((s) => s.slotId === "fast");
    }

    // 2. Exact tag match (only meaningful when tags are distinct)
    if (!chosen && !tagsAreAmbiguous) {
      chosen = slots.find((s) => s.tag === target.providerTag);
    }

    // 3. Slot name matches runtime kind
    if (!chosen && target.kind) {
      chosen = slots.find((s) => s.slotId === target.kind);
    }

    // 4. Fallback to default slot
    if (!chosen) {
      chosen = defaultSlot;
    }

    if (chosen) {
      next[target.qualifiedId] = chosen.slotId;
    }
  }

  return next;
}
