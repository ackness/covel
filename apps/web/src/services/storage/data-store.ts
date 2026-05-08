import type { DataStore } from "@covel/store";

export const BROWSER_STORAGE_DB_NAME = "covel-browser";
export const BROWSER_DATA_DB_NAME = BROWSER_STORAGE_DB_NAME;

export async function createBrowserDataStore(
  dbName = BROWSER_DATA_DB_NAME,
): Promise<DataStore> {
  const { createIdbStore } = await import("@covel/store/idb");
  return createIdbStore(dbName);
}
