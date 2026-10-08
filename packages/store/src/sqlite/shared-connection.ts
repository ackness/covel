/**
 * Process-shared SQLite connections, keyed by resolved file path.
 *
 * The main DataStore and the "mirror" media store both target the same
 * `covel.db` when `STORE_BACKEND=sqlite` + `MEDIA_BACKEND=mirror`. Opening two
 * separate connections to one file deadlocks: `withTransaction` holds a write
 * lock on connection A across an async import, and the media store writing
 * world portraits on connection B can never acquire the lock — it waits out
 * `busy_timeout` and throws `SQLITE_BUSY: database is locked` (a 500 on
 * `POST /api/sessions`).
 *
 * Sharing one connection per file makes those media writes run on the same
 * connection, so they simply join the open transaction (and commit/rollback
 * atomically with the session — exactly what the session-import path intends).
 *
 * `:memory:` is never shared: each `:memory:` open is a distinct database, so
 * callers that want an isolated in-memory db must keep getting their own.
 */

import { resolve } from "node:path";
import {
  createSerializedWriteGate,
  type SerializedWriteGate,
} from "../serialized-write-gate.js";
import { openSqliteConnection, type SqliteConnection } from "./node-sqlite.js";

const gates = new WeakMap<SqliteConnection, SerializedWriteGate>();

/**
 * The write-serialization gate for a connection. Everything that mutates
 * through this handle — DataStore methods, the vector capability, the mirror
 * media store — must share ONE gate, otherwise an ungated write still lands
 * inside another caller's open transaction and disappears on its rollback.
 * Keyed on the handle so `:memory:` connections (never pooled) work too.
 */
export function getConnectionWriteGate(
  db: SqliteConnection,
): SerializedWriteGate {
  const existing = gates.get(db);
  if (existing) return existing;
  const gate = createSerializedWriteGate();
  gates.set(db, gate);
  return gate;
}

interface PoolEntry {
  db: SqliteConnection;
  refs: number;
}

const pool = new Map<string, PoolEntry>();

/**
 * Acquire a shared connection for `dbPath`. Increments the ref count for an
 * already-open file. Call {@link releaseSqliteConnection} with the returned
 * handle exactly once per acquire to release it.
 */
export function acquireSqliteConnection(dbPath: string): SqliteConnection {
  if (dbPath === ":memory:") return openSqliteConnection(dbPath);

  const key = resolve(dbPath);
  const existing = pool.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.db;
  }

  const db = openSqliteConnection(key);
  pool.set(key, { db, refs: 1 });
  return db;
}

/**
 * Release a connection obtained from {@link acquireSqliteConnection}. The
 * underlying handle is closed only when the last holder releases it. A handle
 * that isn't pooled (e.g. a `:memory:` connection) is closed directly.
 */
export function releaseSqliteConnection(db: SqliteConnection): void {
  for (const [key, entry] of pool) {
    if (entry.db === db) {
      entry.refs -= 1;
      if (entry.refs <= 0) {
        pool.delete(key);
        db.close();
      }
      return;
    }
  }
  // Not pooled (e.g. an isolated `:memory:` connection) — close directly.
  try {
    db.close();
  } catch {
    // Already closed — releasing twice is a no-op.
  }
}
