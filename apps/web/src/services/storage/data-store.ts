import type { DataStore } from "@covel/store";

export const BROWSER_STORAGE_DB_NAME = "covel-browser";

export async function createBrowserDataStore(
  dbName = BROWSER_STORAGE_DB_NAME,
): Promise<DataStore> {
  const { createIdbStore } = await import("@covel/store/idb");
  return createIdbStore(dbName);
}
