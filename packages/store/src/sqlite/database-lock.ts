/**
 * Single-writer lock for a SQLite database file.
 *
 * Two server processes on one file (the desktop app and a dev server pointed
 * at the same Covel home) break each other's assumptions: session locks,
 * background-job claims and caches only hold inside one process. The lock is a
 * file next to the database holding the owner's pid and start time, created
 * exclusively and removed on clean exit. A lock whose pid is no longer alive
 * is stale (the owner was killed) and is taken over.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface LockOwner {
  pid: number;
  startedAt: string;
}

// A process may open the same database more than once (a restart inside one
// process, tests); only another process is a conflict.
const held = new Map<string, number>();
let exitHookInstalled = false;

export function sqliteLockPath(dbPath: string): string {
  return `${dbPath}.lock`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(
      readFileSync(lockPath, "utf8"),
    ) as Partial<LockOwner>;
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid)
      ? { pid: parsed.pid, startedAt: String(parsed.startedAt ?? "unknown") }
      : null;
  } catch {
    return null;
  }
}

function removeHeldLocks(): void {
  for (const lockPath of held.keys()) {
    if (readOwner(lockPath)?.pid === process.pid)
      rmSync(lockPath, { force: true });
  }
}

/**
 * Takes the lock for `dbPath` and returns a function that releases it.
 * Throws when another live process holds it.
 */
export function acquireSqliteLock(dbPath: string): () => void {
  const lockPath = sqliteLockPath(dbPath);
  const count = held.get(lockPath);
  if (count !== undefined) {
    held.set(lockPath, count + 1);
    return releaseOnce(lockPath);
  }
  // The store creates the directory later; the lock goes in first.
  mkdirSync(dirname(dbPath), { recursive: true });
  const content = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      writeFileSync(lockPath, content, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readOwner(lockPath);
      if (owner && owner.pid !== process.pid && isAlive(owner.pid))
        throw new Error(
          `The database ${dbPath} is already in use by another Covel process (pid ${owner.pid}, started ${owner.startedAt}; lock file ${lockPath}). Stop that process, or point this one at a different SQLITE_PATH or COVEL_HOME.`,
        );
      // Stale: the owner is gone, the file is unreadable, or this pid left it.
      if (attempt >= 2) throw error;
      rmSync(lockPath, { force: true });
    }
  }
  held.set(lockPath, 1);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", removeHeldLocks);
  }
  return releaseOnce(lockPath);
}

function releaseOnce(lockPath: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = held.get(lockPath);
    if (count === undefined) return;
    if (count > 1) {
      held.set(lockPath, count - 1);
      return;
    }
    held.delete(lockPath);
    if (readOwner(lockPath)?.pid === process.pid)
      rmSync(lockPath, { force: true });
  };
}
