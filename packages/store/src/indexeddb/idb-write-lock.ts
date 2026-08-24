/**
 * Serialize snapshot-backed IDB writes for one database.
 *
 * Web Locks coordinate every tab/worker in the same origin. The module-level
 * queue keeps tests and older single-realm environments safe when Web Locks
 * are unavailable; it cannot coordinate separate tabs, so supported browsers
 * should use the Web Locks path.
 */

type WriteLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive" },
    callback: () => Promise<T>,
  ): Promise<T>;
};

const fallbackChains = new Map<string, Promise<void>>();

function resolveLockManager(): WriteLockManager | undefined {
  const browserNavigator = (
    globalThis as typeof globalThis & {
      navigator?: { locks?: WriteLockManager };
    }
  ).navigator;
  return browserNavigator?.locks;
}

function enqueueFallback<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const previous = fallbackChains.get(name) ?? Promise.resolve();
  const task = previous.then(fn);
  const settled = task.then(
    () => undefined,
    () => undefined,
  );
  fallbackChains.set(name, settled);
  void settled.then(() => {
    if (fallbackChains.get(name) === settled) fallbackChains.delete(name);
  });
  return task;
}

export function withIdbDatabaseWriteLock<T>(
  dbName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockName = `covel:idb-write:${dbName}`;
  const manager = resolveLockManager();
  return manager
    ? manager.request(lockName, { mode: "exclusive" }, fn)
    : enqueueFallback(lockName, fn);
}
