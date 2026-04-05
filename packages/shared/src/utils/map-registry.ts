/**
 * Lightweight generic Map-based registry.
 *
 * Provides the common boilerplate (get/list/has/size/remove/clear/entries)
 * that every registry in the codebase duplicates. Domain-specific logic
 * (validation, scoping, qualified IDs) stays in the consumer.
 */
export interface MapRegistry<T> {
  /** Add an item. Throws if key already exists (unless `overwrite` is true). */
  add(key: string, value: T, overwrite?: boolean): void;
  /** Get by key. */
  get(key: string): T | undefined;
  /** Check existence. */
  has(key: string): boolean;
  /** Remove by key. Returns true if found. */
  remove(key: string): boolean;
  /** List all values. */
  list(): T[];
  /** Number of entries. */
  readonly size: number;
  /** Remove all entries. */
  clear(): void;
  /** Iterate [key, value] pairs. */
  entries(): IterableIterator<[string, T]>;
  /** List all keys. */
  keys(): string[];
}

export function createMapRegistry<T>(): MapRegistry<T> {
  const map = new Map<string, T>();

  return {
    add(key: string, value: T, overwrite = false): void {
      if (!overwrite && map.has(key)) {
        throw new Error(`Key "${key}" is already registered.`);
      }
      map.set(key, value);
    },

    get(key: string): T | undefined {
      return map.get(key);
    },

    has(key: string): boolean {
      return map.has(key);
    },

    remove(key: string): boolean {
      return map.delete(key);
    },

    list(): T[] {
      return [...map.values()];
    },

    get size(): number {
      return map.size;
    },

    clear(): void {
      map.clear();
    },

    entries(): IterableIterator<[string, T]> {
      return map.entries();
    },

    keys(): string[] {
      return [...map.keys()];
    },
  };
}
