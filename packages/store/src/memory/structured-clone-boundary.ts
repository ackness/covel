/**
 * MemoryStore must behave like a persistence backend: callers own their input
 * objects and returned records. Clone both sides of every data method so a
 * retained reference cannot mutate the store without an explicit write.
 */
export function withStructuredCloneBoundary<T extends object>(target: T): T {
  const boundary = { ...target } as Record<string, unknown>;
  for (const name of Object.keys(boundary)) {
    const original = boundary[name];
    if (typeof original !== "function") continue;
    const fn = original as (...args: unknown[]) => unknown;
    boundary[name] = async (...args: unknown[]) => {
      const result = await fn.apply(target, structuredClone(args));
      return structuredClone(result);
    };
  }
  return boundary as T;
}
