import { randomUUID } from "node:crypto";
import type { DataStore, SessionRecord } from "@covel/store";
import {
  DIMENSION_DATA_NAMESPACE,
  dimensionRecordSchema,
  resolveDimensionRecordLocale,
} from "@covel/shared";

/** The dimension records as they were before the repair, by the same keys. */
export const DIMENSION_LOCALE_BACKUP_NAMESPACE =
  "_legacy.dimension-locale-maps";

// One look per session per process: after it, the records are current.
const current = new Set<string>();

/**
 * A session created while session state still held the world package's
 * locale maps has them in its dimension records. Every read of such a record
 * fails validation now, so the session could not be opened at all. The text
 * of the session's language is in each map, so the records are rewritten
 * with it. The records as they were are kept under
 * `DIMENSION_LOCALE_BACKUP_NAMESPACE`.
 *
 * Returns the ids of the rewritten dimensions. A record that is not valid
 * for another reason is left as it is.
 */
export async function repairSessionDimensionLocale(
  store: DataStore,
  session: SessionRecord,
): Promise<readonly string[]> {
  if (current.has(session.id)) return [];
  const provider = session.metadata?._dimensionProviderPluginId;
  if (typeof provider !== "string" || !store.listPluginData) {
    current.add(session.id);
    return [];
  }
  const rows = await store.listPluginData(
    session.id,
    provider,
    DIMENSION_DATA_NAMESPACE,
  );
  const repaired = rows.flatMap((row) => {
    if (dimensionRecordSchema.safeParse(row.value).success) return [];
    const record = resolveDimensionRecordLocale(row.value, session.locale);
    return record ? [{ row, record }] : [];
  });
  if (repaired.length > 0) {
    const now = new Date().toISOString();
    // One batch: the copy and the rewritten record land together or not at all.
    await store.setPluginDataBatch([
      ...repaired.map(({ row }) => ({
        ...row,
        id: randomUUID(),
        namespace: DIMENSION_LOCALE_BACKUP_NAMESPACE,
        createdAt: now,
        updatedAt: now,
      })),
      ...repaired.map(({ row, record }) => ({
        ...row,
        value: record,
        updatedAt: now,
      })),
    ]);
    console.warn(
      `[session] ${session.id}: resolved locale maps in ${repaired.length} dimension record(s) to ${session.locale}: ${repaired.map(({ row }) => row.key).join(", ")}`,
    );
  }
  current.add(session.id);
  return repaired.map(({ row }) => row.key);
}
