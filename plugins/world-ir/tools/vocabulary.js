/**
 * Names the session already tracks, published by state plugins through
 * `world-ir.vocabulary@1`: the entries of every provider, in one list.
 *
 * @param {unknown} slot the `vocabulary` input slot of the runtime
 * @returns {Array<{ type: string, name: string, details?: string[] }>}
 */
export function vocabularyEntries(slot) {
  if (slot?.cardinality !== "all" || !Array.isArray(slot.items)) return [];
  return slot.items.flatMap((item) =>
    Array.isArray(item?.value?.entries) ? item.value.entries : [],
  );
}
