import { BROWSER_IDB_DATABASE_NAME } from "@covel/store/idb-schema";

/** Frontend-only KV/media cache database; game data lives in BrowserVault. */
export const BROWSER_STORAGE_DB_NAME = BROWSER_IDB_DATABASE_NAME;
