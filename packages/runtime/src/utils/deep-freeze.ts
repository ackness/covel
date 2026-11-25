/**
 * Deeply freezes an object graph in place, tracking visited objects so cyclic
 * references do not trigger unbounded recursion.
 */
export function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const inner of Object.values(value as Record<string, unknown>)) {
      deepFreeze(inner, seen);
    }
    Object.freeze(value);
  }
  return value;
}
