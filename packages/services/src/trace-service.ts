import type { TraceService, TraceEntry } from "./types.js";

/**
 * In-memory trace service for audit logging.
 */
export function createTraceService(): TraceService & {
  /** Get all trace entries (for testing/debugging). */
  getAll(): TraceEntry[];
  /** Get entries by session. */
  getBySession(sessionId: string): TraceEntry[];
  /** Get entries by trace ID. */
  getByTraceId(traceId: string): TraceEntry[];
} {
  const entries: TraceEntry[] = [];

  async function append(entry: TraceEntry): Promise<void> {
    entries.push({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
  }

  function getAll(): TraceEntry[] {
    return [...entries];
  }

  function getBySession(sessionId: string): TraceEntry[] {
    return entries.filter((e) => e.sessionId === sessionId);
  }

  function getByTraceId(traceId: string): TraceEntry[] {
    return entries.filter((e) => e.traceId === traceId);
  }

  return { append, getAll, getBySession, getByTraceId };
}
