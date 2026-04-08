import type { RecordQueryService, RecordQueryInput, RecordQueryResult, PublishedRecord } from "./types.js";

/**
 * In-memory record store.
 * In production this would be backed by PostgreSQL.
 */
export function createRecordQueryService(): RecordQueryService & {
  /** Append a record to the store (used by kernel after runtime commit). */
  publish(record: PublishedRecord): void;
  /** Get all records (for testing). */
  getAll(): PublishedRecord[];
} {
  const records: PublishedRecord[] = [];

  function publish(record: PublishedRecord): void {
    records.push(record);
  }

  async function query(input: RecordQueryInput): Promise<RecordQueryResult> {
    let filtered = records.filter((r) => r.sessionId === input.sessionId);

    if (input.pluginId) filtered = filtered.filter((r) => r.pluginId === input.pluginId);
    if (input.runtimeId) filtered = filtered.filter((r) => r.runtimeId === input.runtimeId);
    if (input.status && input.status.length > 0) {
      filtered = filtered.filter((r) => input.status!.includes(r.status));
    }
    if (input.recordType) filtered = filtered.filter((r) => r.recordType === input.recordType);

    // Cursor-based pagination (cursor = index in filtered results)
    let startIndex = 0;
    if (input.cursor) {
      startIndex = parseInt(input.cursor, 10);
      if (isNaN(startIndex)) startIndex = 0;
    }

    const limit = input.limit ?? 20;
    const page = filtered.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < filtered.length
      ? String(startIndex + limit)
      : undefined;

    return { records: page, nextCursor };
  }

  function getAll(): PublishedRecord[] {
    return [...records];
  }

  return { query, publish, getAll };
}
