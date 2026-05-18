export interface RuntimeBindingTargetLike {
  qualifiedId: string;
  defaultSlot: string;
}

export interface RuntimeBindingSlotLike {
  slotId: string;
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
    Object.entries(bindings).filter(([qualifiedId]) =>
      knownIds.has(qualifiedId),
    ),
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
    Object.entries(bindings).filter(
      ([, slotName]) => typeof slotName === "string" && slotName.length > 0,
    ),
  );
}

/**
 * Fill every currently unbound runtime with the best matching slot.
 * Existing non-empty bindings are preserved.
 *
 * Matching priority (per runtime):
 * 0. Direct name match: slot whose slotId === runtime.defaultSlot.
 * 1. `default` binds to the configured default/first slot.
 * 2. Missing explicit slots are left unbound so the UI can surface
 *    "missing [covel.<slot>]".
 */
export function autoAssignRuntimeBindings(
  bindings: Record<string, string>,
  targets: readonly RuntimeBindingTargetLike[],
  slots: readonly RuntimeBindingSlotLike[],
): Record<string, string> {
  if (slots.length === 0) return { ...bindings };

  const next = { ...bindings };
  const defaultSlot = slots.find((s) => s.slotId === "default") ?? slots[0];

  for (const target of targets) {
    if (next[target.qualifiedId]) continue;

    let chosen: RuntimeBindingSlotLike | undefined;

    // 0. Direct name match: `model: plugin` selects `[covel.plugin]`.
    chosen = slots.find((s) => s.slotId === target.defaultSlot);

    // 1. `default` is a virtual slot name used by some plugins to mean
    //    "the deployment's default text model". It does not require a literal
    //    [covel.default] block; bind it to the configured default/first slot.
    if (!chosen && target.defaultSlot === "default") {
      chosen = defaultSlot;
    }

    // 2. Runtime `model` values are concrete slot names from PLUGIN.md.
    if (!chosen) {
      continue;
    }

    if (chosen) {
      next[target.qualifiedId] = chosen.slotId;
    }
  }

  return next;
}
