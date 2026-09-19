import {
  BROWSER_IDB_SCHEMA_VERSION,
  upgradeBrowserIdbSchema,
} from "@covel/store/idb-schema";
import { BROWSER_STORAGE_DB_NAME } from "./data-store.js";

const DB_NAME = BROWSER_STORAGE_DB_NAME;
const DB_VERSION = BROWSER_IDB_SCHEMA_VERSION;

// Shared by frontend app state and the optional render-blob cache.
let dbPromise: Promise<IDBDatabase> | null = null;

export function openBrowserCacheDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  let abandoned = false;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => {
      abandoned = true;
      reject(
        new DOMException(
          "Browser cache database is blocked",
          "InvalidStateError",
        ),
      );
    };
    req.onupgradeneeded = (event) => {
      const transaction = req.transaction!;
      if (abandoned) {
        transaction.abort();
        return;
      }
      const abortUpgrade = () => {
        // Reject the open request instead of allowing a partially migrated
        // schema to commit after an asynchronous upgrade failure.
        try {
          transaction.abort();
        } catch {
          // The transaction already aborted or completed.
        }
      };
      try {
        void upgradeBrowserIdbSchema(
          req.result,
          event.oldVersion,
          transaction,
        ).catch(abortUpgrade);
      } catch {
        abortUpgrade();
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // A blocked open can succeed after its caller has already fallen back.
      if (abandoned) {
        db.close();
        forgetConnection();
        return;
      }
      db.onversionchange = () => {
        db.close();
        forgetConnection();
      };
      db.onclose = forgetConnection;
      resolve(db);
    };
    req.onerror = () => {
      reject(req.error);
      forgetConnection();
    };
  });
  function forgetConnection() {
    // An older handle must not invalidate a replacement connection.
    if (dbPromise === opening) dbPromise = null;
  }
  dbPromise = opening;
  // Report this operation's failure; let the next caller try opening again.
  void opening.catch(() => {
    // IDB cannot cancel a blocked open yet. Reuse its rejection until the
    // request settles, otherwise later opens queue behind it and hang again.
    if (!abandoned) forgetConnection();
  });
  return opening;
}
