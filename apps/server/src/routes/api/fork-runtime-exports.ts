import type { DataStore, SnapshotRecord } from "@covel/store";
import type { RuntimeExportRecord } from "@covel/shared";

/** Materialize exactly the revisions captured in the snapshot. */
export async function copyForkRuntimeExports(
  store: Pick<DataStore, "appendRuntimeExport">,
  snapshot: SnapshotRecord,
  childSessionId: string,
): Promise<RuntimeExportRecord[]> {
  const copied = snapshot.payload.runtimeExports.map((record) => ({
    ...record,
    sessionId: childSessionId,
  }));
  for (const record of copied) await store.appendRuntimeExport(record);
  return copied;
}
