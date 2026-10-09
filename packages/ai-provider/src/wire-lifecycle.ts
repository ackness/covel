import { AsyncLocalStorage } from "node:async_hooks";

interface WireEntry {
  readonly wire: unknown;
}
const live = new Map<string, WireEntry>();
const snapshots = new AsyncLocalStorage<ReadonlyMap<string, WireEntry>>();

/** Capture wire identities for an admitted execution; mutations remain live. */
export function withWireRegistrySnapshot<T>(fn: () => T): T {
  return snapshots.getStore() ? fn() : snapshots.run(new Map(live), fn);
}

/** Synchronous publication participates in the host's cross-registry transaction. */
export function replacePluginWires<T>(pluginId: string, publish: () => T): T {
  const belongs = (key: string) =>
    key.slice(key.indexOf(":") + 1).startsWith(`${pluginId}/`);
  const previous = [...live].filter(([key]) => belongs(key));
  for (const [key] of previous) live.delete(key);
  try {
    return publish();
  } catch (error) {
    for (const key of live.keys()) if (belongs(key)) live.delete(key);
    for (const [key, value] of previous) live.set(key, value);
    throw error;
  }
}

export function registerWire<T extends { id: string }>(
  kind: string,
  wire: T,
): () => void {
  const key = `${kind}:${wire.id}`;
  if (live.has(key))
    throw new Error(`${kind} wire "${wire.id}" already registered`);
  const entry = { wire };
  live.set(key, entry);
  return () => {
    if (live.get(key) === entry) live.delete(key);
  };
}
export function getWire<T>(kind: string, id: string): T | null {
  return (
    ((snapshots.getStore() ?? live).get(`${kind}:${id}`)?.wire as
      T | undefined) ?? null
  );
}
export function listWires<T>(kind: string): T[] {
  return [...(snapshots.getStore() ?? live)]
    .filter(([key]) => key.startsWith(`${kind}:`))
    .map(([, entry]) => entry.wire as T);
}
