/** Display fallback only; authoritative game state is never capped. */
const STATE_PATCH_CACHE_LIMIT = 256;
const STATE_PATCH_RECENT_IDS_LIMIT = 256;

interface Patch {
  id: string;
  data?: unknown;
}

/** Keep the most recently updated fields, with one value per table/field. */
export function compactStatePatches<T extends Patch>(
  patches: readonly T[],
): T[] {
  const latest = new Map<string, T>();
  for (const patch of patches) {
    let hasField = false;
    if (patch.data && typeof patch.data === "object") {
      for (const [table, fields] of Object.entries(patch.data)) {
        if (!fields || typeof fields !== "object" || Array.isArray(fields))
          continue;
        for (const [field, value] of Object.entries(fields)) {
          hasField = true;
          const key = JSON.stringify([table, field]);
          latest.delete(key);
          latest.set(key, { ...patch, data: { [table]: { [field]: value } } });
        }
      }
    }
    if (!hasField) {
      const key = JSON.stringify([patch.id]);
      latest.delete(key);
      latest.set(key, patch);
    }
    while (latest.size > STATE_PATCH_CACHE_LIMIT) {
      const oldest = latest.keys().next().value;
      if (oldest === undefined) break;
      latest.delete(oldest);
    }
  }
  return [...latest.values()];
}

export function rememberStatePatchIds(ids: readonly string[]): string[] {
  return [...new Set([...ids].reverse())]
    .slice(0, STATE_PATCH_RECENT_IDS_LIMIT)
    .reverse();
}
