import type { MediaStore } from "@covel/shared";
import { BROWSER_STORAGE_DB_NAME } from "./data-store.js";

export const BROWSER_MEDIA_STORE_DB_NAME = BROWSER_STORAGE_DB_NAME;

export async function createBrowserMediaStore(
  dbName = BROWSER_MEDIA_STORE_DB_NAME,
): Promise<MediaStore> {
  const { createIndexedDbMediaStore } = await import("@covel/store/idb");
  return createIndexedDbMediaStore({ dbName });
}
