import type {
  PluginDataBatchCasEntry,
  PluginDataRecord,
  PluginDataStore,
} from "../types.js";

export function pluginDataVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "version"))
    return undefined;
  const version = (value as { version: unknown }).version;
  return typeof version === "number" && Number.isInteger(version) && version > 0
    ? version
    : undefined;
}

export function validatePluginDataCasEntries(
  entries: readonly PluginDataBatchCasEntry[],
): void {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.namespace, entry.key]);
    if (
      !entry.namespace ||
      !entry.key ||
      keys.has(key) ||
      (entry.expectedVersion !== null &&
        (!Number.isInteger(entry.expectedVersion) || entry.expectedVersion < 1))
    ) {
      throw new Error("Invalid or duplicate plugin-data CAS entry");
    }
    keys.add(key);
  }
}

/** Caller owns a transaction and the per-session write barrier before any read. */
export async function applyPluginDataBatchCas(
  store: Pick<PluginDataStore, "getPluginData" | "setPluginDataBatch">,
  sessionId: string,
  pluginId: string,
  entries: readonly PluginDataBatchCasEntry[],
): Promise<boolean> {
  validatePluginDataCasEntries(entries);
  const rows: PluginDataRecord[] = [];
  for (const entry of entries) {
    const existing = await store.getPluginData(
      sessionId,
      pluginId,
      entry.namespace,
      entry.key,
    );
    if (
      entry.expectedVersion === null
        ? existing !== null
        : !existing ||
          pluginDataVersion(existing.value) !== entry.expectedVersion
    )
      return false;
    rows.push({
      id: existing?.id ?? crypto.randomUUID(),
      sessionId,
      pluginId,
      namespace: entry.namespace,
      key: entry.key,
      value: structuredClone(entry.value),
      createdAt: existing?.createdAt ?? entry.timestamp,
      updatedAt: entry.timestamp,
    });
  }
  await store.setPluginDataBatch(rows);
  return true;
}
