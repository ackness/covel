import type { Context } from "hono";

export function memoryIngestLockId(sessionId: string): string {
  return `memory-ingest:${JSON.stringify([sessionId])}`;
}

/**
 * Lifecycle order: session -> world (if needed) -> ingestion -> transaction.
 * Ingestion never acquires session/world locks; ordinary commits do not wait
 * for embeddings. Replacement/deletion waits for every delayed index write.
 */
export function withMemoryIngestLock<T>(
  c: Context,
  sessionId: string,
  task: () => Promise<T>,
): Promise<T> {
  const lock = c.get("memoryIngestLock");
  return lock ? lock.withLock(memoryIngestLockId(sessionId), task) : task();
}
