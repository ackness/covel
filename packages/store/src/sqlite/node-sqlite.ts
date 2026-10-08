/**
 * The SQLite connection is Node's built-in `node:sqlite` (`DatabaseSync`).
 *
 * It is synchronous, ships with Node, and needs no native npm package, so an
 * install never compiles anything and the desktop sidecar needs no rebuild.
 * This module holds the few helpers the store needs on top of it: opening a
 * configured connection, loading an extension, and nesting transactions.
 */

import { DatabaseSync } from "node:sqlite";

export type SqliteConnection = DatabaseSync;

export type SqliteTransactionBehavior = "deferred" | "immediate" | "exclusive";

/** How long a statement waits for another connection's write lock. */
const BUSY_TIMEOUT_MS = 5_000;

let savepointSequence = 0;

/**
 * Open a connection in WAL mode with foreign keys on. Extension loading stays
 * off except inside {@link loadSqliteExtension}.
 */
export function openSqliteConnection(path: string): SqliteConnection {
  const db = new DatabaseSync(path, {
    timeout: BUSY_TIMEOUT_MS,
    allowExtension: true,
  });
  db.enableLoadExtension(false);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Run `load` with extension loading enabled, and disable it again after. */
export function loadSqliteExtension(
  db: SqliteConnection,
  load: (db: SqliteConnection) => void,
): void {
  db.enableLoadExtension(true);
  try {
    load(db);
  } finally {
    db.enableLoadExtension(false);
  }
}

/**
 * Run `fn` atomically: BEGIN…COMMIT, or a savepoint when a transaction is
 * already open, so a caller inside `withTransaction` nests instead of failing.
 * `fn` must be synchronous — a statement awaited after it returned would run
 * outside the transaction.
 */
export function runSqliteTransaction<T>(
  db: SqliteConnection,
  fn: () => T,
  behavior: SqliteTransactionBehavior = "deferred",
): T {
  const savepoint = db.isTransaction
    ? `covel_tx_${++savepointSequence}`
    : undefined;
  db.exec(
    savepoint ? `SAVEPOINT ${savepoint}` : `BEGIN ${behavior.toUpperCase()}`,
  );
  try {
    const result = fn();
    if (
      result !== null &&
      typeof result === "object" &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      throw new TypeError("A SQLite transaction function must not be async");
    }
    db.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
    return result;
  } catch (err) {
    // SQLite may already have rolled back (e.g. SQLITE_FULL); a failed
    // rollback must not mask the original error.
    if (db.isTransaction) {
      try {
        db.exec(
          savepoint
            ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`
            : "ROLLBACK",
        );
      } catch {
        // Keep the original error.
      }
    }
    throw err;
  }
}
