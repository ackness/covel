/** Bounded, single-flight cache for JSON data. Each reader owns its result. */
export function createRevisionCache<T>(capacity: number) {
  const entries = new Map<
    string,
    { readonly revision: string; readonly value: Promise<T> }
  >();
  return async (
    key: string,
    revision: string,
    load: () => Promise<T>,
  ): Promise<T> => {
    let entry = entries.get(key);
    if (entry?.revision !== revision) {
      entry = { revision, value: load() };
    }
    entries.delete(key);
    entries.set(key, entry);
    if (entries.size > capacity) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    try {
      return structuredClone(await entry.value);
    } catch (error) {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }
  };
}
