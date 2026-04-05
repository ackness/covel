const DEEP_MERGE_MAX_DEPTH = 20;

/**
 * Recursively merge plain objects; non-object values (including arrays) are overwritten.
 * Returns a new object — inputs are never mutated.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  return merge(target, source, 0);
}

function merge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth >= DEEP_MERGE_MAX_DEPTH) return { ...target, ...source };
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const tVal = result[key];
    const sVal = source[key];
    if (
      tVal && sVal &&
      typeof tVal === "object" && !Array.isArray(tVal) &&
      typeof sVal === "object" && !Array.isArray(sVal)
    ) {
      result[key] = merge(
        tVal as Record<string, unknown>,
        sVal as Record<string, unknown>,
        depth + 1,
      );
    } else {
      result[key] = Array.isArray(sVal) ? [...sVal as unknown[]] : sVal;
    }
  }
  return result;
}
