import { applyPagination } from "../common/pagination.js";
import type {
  InteractionRecordFilters,
  InteractionRecordRow,
  PaginationOpts,
  RuntimeOutputFilters,
  RuntimeOutputRecord,
} from "../types.js";
import type { BrowserIdbDatabase, IdbStoreName } from "./idb-db.js";
import type { IdbMutationTracker } from "./idb-transaction.js";

type IndexedRow = object;

export async function putClonedRecord<T extends IndexedRow>(
  mutations: IdbMutationTracker,
  storeName: IdbStoreName,
  record: T,
): Promise<void> {
  await mutations.putAndTrack(storeName, structuredClone(record));
}

export async function listBySession<T extends { readonly sessionId: string }>(
  db: BrowserIdbDatabase,
  storeName: IdbStoreName,
  sessionId: string,
): Promise<T[]> {
  return (await db.getAllFromIndex(storeName, "sessionId", sessionId)) as T[];
}

export async function getSessionScopedRecord<
  T extends { readonly sessionId: string },
>(
  db: BrowserIdbDatabase,
  storeName: IdbStoreName,
  sessionId: string,
  id: string,
): Promise<T | null> {
  const row = (await db.get(storeName, id)) as T | undefined;
  return row?.sessionId === sessionId ? row : null;
}

export function sortByCreatedAtAsc<T extends { readonly createdAt: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function sortByTimestampDesc<
  T extends { readonly timestamp: string; readonly id: string },
>(rows: readonly T[]): T[] {
  // `id` tie-break mirrors the SQL backends: same-timestamp rows must land in
  // one fixed order, or offset pagination can drop or repeat them.
  return [...rows].sort(
    (a, b) =>
      b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
  );
}

export function limitRows<T>(rows: readonly T[], limit?: number): T[] {
  return limit === undefined ? [...rows] : rows.slice(0, limit);
}

export function paginateRows<T>(
  rows: readonly T[],
  pagination?: PaginationOpts,
): T[] {
  return applyPagination(rows, pagination);
}

export function filterRuntimeOutputs(
  rows: readonly RuntimeOutputRecord[],
  filters?: RuntimeOutputFilters,
): RuntimeOutputRecord[] {
  let filtered = [...rows];
  if (filters?.runtimeId) {
    filtered = filtered.filter((row) => row.runtimeId === filters.runtimeId);
  }
  if (filters?.pluginId) {
    filtered = filtered.filter((row) => row.pluginId === filters.pluginId);
  }
  if (filters?.sinceTimestamp) {
    filtered = filtered.filter(
      (row) => row.timestamp >= filters.sinceTimestamp!,
    );
  }
  const ordered = sortByTimestampDesc(filtered);
  const offset = filters?.offset ?? 0;
  return offset > 0
    ? limitRows(ordered.slice(offset), filters?.limit)
    : limitRows(ordered, filters?.limit);
}

export function filterInteractionRecords(
  rows: readonly InteractionRecordRow[],
  filters?: InteractionRecordFilters,
): InteractionRecordRow[] {
  let filtered = [...rows];
  if (filters?.type) {
    filtered = filtered.filter((row) => row.type === filters.type);
  }
  if (filters?.source) {
    filtered = filtered.filter((row) => row.source === filters.source);
  }
  if (filters?.targetPluginId) {
    filtered = filtered.filter(
      (row) => row.targetPluginId === filters.targetPluginId,
    );
  }
  return limitRows(sortByTimestampDesc(filtered), filters?.limit);
}
