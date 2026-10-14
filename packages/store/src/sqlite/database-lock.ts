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

import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

interface LockOwner {
  pid: number;
  startedAt: string;
}

// A process may open the same database more than once (a restart inside one
// process, tests); only another process is a conflict.
const held = new Map<string, { count: number; owner: LockOwner }>();
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
  for (const [lockPath, entry] of held) {
    if (sameOwner(readOwner(lockPath), entry.owner))
      rmSync(lockPath, { force: true });
  }
}

function sameOwner(actual: LockOwner | null, expected: LockOwner): boolean {
  return (
    actual?.pid === expected.pid && actual.startedAt === expected.startedAt
  );
}

/**
 * Takes the lock for `dbPath` and returns a function that releases it.
 * Throws when another live process holds it.
 */
export function acquireSqliteLock(dbPath: string): () => void {
  const lockPath = resolve(sqliteLockPath(dbPath));
  const entry = held.get(lockPath);
  if (entry !== undefined) {
    entry.count += 1;
    return releaseOnce(lockPath);
  }
  // The store creates the directory later; the lock goes in first.
  mkdirSync(dirname(dbPath), { recursive: true });
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const content = JSON.stringify(owner);
  const releaseClaim = acquireLockClaim(lockPath);
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        writeFileSync(lockPath, content, { flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readOwner(lockPath);
        if (existing && existing.pid !== process.pid && isAlive(existing.pid))
          throw new Error(
            `The database ${dbPath} is already in use by another Covel process (pid ${existing.pid}, started ${existing.startedAt}; lock file ${lockPath}). Stop that process, or point this one at a different SQLITE_PATH or COVEL_HOME.`,
          );
        // Stale: the owner is gone, the file is unreadable, or this pid left it.
        if (attempt >= 2) throw error;
        const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        try {
          renameSync(lockPath, stalePath);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT")
            continue;
          throw renameError;
        }
        rmSync(stalePath);
      }
    }
    if (!sameOwner(readOwner(lockPath), owner)) {
      throw new Error(
        `The database lock ${lockPath} changed while being acquired. Retry startup.`,
      );
    }
    held.set(lockPath, { count: 1, owner });
  } finally {
    releaseClaim();
  }
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
    const entry = held.get(lockPath);
    if (entry === undefined) return;
    if (entry.count > 1) {
      entry.count -= 1;
      return;
    }
    held.delete(lockPath);
    if (sameOwner(readOwner(lockPath), entry.owner))
      rmSync(lockPath, { force: true });
  };
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    // A contender may already have published a new, nonempty directory here.
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}

/**
 * Serialize lock-file inspection, stale rename and publication. Renaming a
 * stale lock file alone is not a CAS: a delayed contender could move the new
 * owner's lock after that owner has already read it back and started serving.
 *
 * Publish a nonempty directory atomically. Its unique marker names the owning
 * process, so recovery renames only the exact dead owner's marker, never a
 * replacement's. Cleanup uses rmdir, which cannot remove a new nonempty claim.
 */
function acquireLockClaim(lockPath: string): () => void {
  const claimPath = `${lockPath}.claim`;
  const marker = `${process.pid}-${randomUUID()}`;
  const candidate = `${claimPath}-${marker}`;
  mkdirSync(candidate);
  try {
    writeFileSync(join(candidate, marker), "", { flag: "wx" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        renameSync(candidate, claimPath);
        return () => {
          rmSync(join(claimPath, marker), { force: true });
          removeEmptyDirectory(claimPath);
        };
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
      let markers: string[];
      try {
        markers = readdirSync(claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const staleMarker of markers) {
        const pid = Number(/^([1-9]\d*)-[0-9a-f-]+$/.exec(staleMarker)?.[1]);
        if (!Number.isSafeInteger(pid) || isAlive(pid)) {
          throw new Error(
            `The database lock ${lockPath} is already being acquired by another Covel process (pid ${pid || "unknown"}). Retry after that process finishes starting.`,
          );
        }
        try {
          // Two reclaimers of this generation name the same source. Only one
          // can move it; a later generation has a different marker name.
          renameSync(
            join(claimPath, staleMarker),
            join(candidate, staleMarker),
          );
          rmSync(join(candidate, staleMarker));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      removeEmptyDirectory(claimPath);
    }
    throw new Error(
      `The database lock ${lockPath} changed while being acquired. Retry startup.`,
    );
  } finally {
    // This private path is never reused by another contender. After successful
    // publication it no longer exists; never recursively remove claimPath.
    rmSync(candidate, { recursive: true, force: true });
  }
}
