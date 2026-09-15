import type { DataStore, SnapshotRecord } from "@covel/store";
import type { RuntimeExportRecord } from "@covel/shared";

/** Materialize captured revisions, retaining timestamp fallback only for legacy v3. */
export async function copyForkRuntimeExports(
  store: Pick<DataStore, "listRuntimeExports" | "appendRuntimeExport">,
  snapshot: SnapshotRecord,
  childSessionId: string,
): Promise<RuntimeExportRecord[]> {
  let visible = snapshot.payload.runtimeExports;
  if (visible === undefined) {
    const latest = new Map<string, RuntimeExportRecord>();
    for (const record of await store.listRuntimeExports(snapshot.sessionId)) {
      if (record.committedAt > snapshot.createdAt) continue;
      const key = JSON.stringify([record.producerRuntimeId, record.recordAs]);
      if (!latest.has(key) || record.revision > latest.get(key)!.revision)
        latest.set(key, record);
    }
    visible = [...latest.values()];
  }
  const copied = visible.map((record) => ({
    ...record,
    sessionId: childSessionId,
  }));
  for (const record of copied) await store.appendRuntimeExport(record);
  return copied;
}
