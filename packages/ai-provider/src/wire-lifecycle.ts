import { AsyncLocalStorage } from "node:async_hooks";
import { readRuntimeEnv } from "@covel/shared";

/** The plugin that provides a wire, when the wire is limited to sessions that run it. */
export interface WireOwner {
  readonly pluginId: string;
  /** Builtin plugin code may serve a request that has no session on any tier. */
  readonly builtin: boolean;
}

interface WireEntry {
  readonly wire: unknown;
  readonly owner?: WireOwner;
}
interface WireSnapshot {
  readonly entries: ReadonlyMap<string, WireEntry>;
  /** Plugins active in the session; absent when the snapshot has no session scope. */
  readonly activePlugins?: ReadonlySet<string>;
}
const live = new Map<string, WireEntry>();
const snapshots = new AsyncLocalStorage<WireSnapshot>();

/**
 * Capture wire identities for an admitted execution; mutations remain live.
 * With `activePlugins`, a wire that has an owner is visible only when its
 * plugin is in that set.
 */
export function withWireRegistrySnapshot<T>(
  fn: () => T,
  activePlugins?: readonly string[],
): T {
  return snapshots.getStore()
    ? fn()
    : snapshots.run(
        {
          entries: new Map(live),
          ...(activePlugins ? { activePlugins: new Set(activePlugins) } : {}),
        },
        fn,
      );
}

function usable(entry: WireEntry, snapshot: WireSnapshot | undefined): boolean {
  const { owner } = entry;
  if (!owner) return true;
  if (snapshot?.activePlugins) {
    return snapshot.activePlugins.has(owner.pluginId);
  }
  // No session: on the self tier the one player approved every loaded plugin,
  // so the settings page can test a model that uses its protocol. On a hosted
  // tier another player's approval must not serve this request.
  return owner.builtin || readRuntimeEnv().deploymentTier === "self";
}

/**
 * The plugin that provides wire `id` when the current scope may not use it, so
 * the caller can tell the player what to enable. `null` when the wire is
 * usable or does not exist.
 */
export function describeUnavailableWire(
  kind: string,
  id: string,
): { pluginId: string; inSession: boolean } | null {
  const snapshot = snapshots.getStore();
  const entry = (snapshot?.entries ?? live).get(`${kind}:${id}`);
  if (!entry?.owner || usable(entry, snapshot)) return null;
  return {
    pluginId: entry.owner.pluginId,
    inSession: Boolean(snapshot?.activePlugins),
  };
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
  owner?: WireOwner,
): () => void {
  const key = `${kind}:${wire.id}`;
  if (live.has(key))
    throw new Error(`${kind} wire "${wire.id}" already registered`);
  const entry: WireEntry = owner ? { wire, owner } : { wire };
  live.set(key, entry);
  return () => {
    if (live.get(key) === entry) live.delete(key);
  };
}
export function getWire<T>(kind: string, id: string): T | null {
  const snapshot = snapshots.getStore();
  const entry = (snapshot?.entries ?? live).get(`${kind}:${id}`);
  return entry && usable(entry, snapshot) ? (entry.wire as T) : null;
}
export function listWires<T>(kind: string): T[] {
  return [...(snapshots.getStore()?.entries ?? live)]
    .filter(([key]) => key.startsWith(`${kind}:`))
    .map(([, entry]) => entry.wire as T);
}
