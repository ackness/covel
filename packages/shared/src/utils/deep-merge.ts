/**
 * Deep merge two objects. Returns a new object without mutating inputs.
 * Arrays are replaced, not merged. Only plain objects are recursively merged.
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Record<string, unknown>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = Object.hasOwn(result, key) ? result[key] : undefined;
    const value =
      isPlainObject(sourceVal) && isPlainObject(targetVal)
        ? deepMerge(targetVal, sourceVal)
        : sourceVal;
    // Preserve JSON keys such as __proto__ without invoking inherited setters.
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
