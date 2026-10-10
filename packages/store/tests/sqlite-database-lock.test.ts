import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireSqliteLock,
  sqliteLockPath,
} from "../src/sqlite/database-lock.js";

const lockModule = fileURLToPath(
  new URL("../src/sqlite/database-lock.ts", import.meta.url),
);
const dirs: string[] = [];
const children: ChildProcess[] = [];

function tempDb(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "covel-db-lock-"));
  dirs.push(dir);
  return path.join(dir, "covel.db");
}

// A second process that takes the lock, prints its pid, then waits on stdin.
function holdFromChild(dbPath: string): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { acquireSqliteLock } from ${JSON.stringify(lockModule)};
       acquireSqliteLock(${JSON.stringify(dbPath)});
       process.stdout.write("held\\n");
       process.stdin.resume();`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
    child.stdout!.once("data", () => resolve(child));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("sqlite database lock", () => {
  it("refuses a second process and names the file and the owner's pid", async () => {
    const db = tempDb();
    const child = await holdFromChild(db);
    expect(() => acquireSqliteLock(db)).toThrow(
      new RegExp(
        `pid ${child.pid}.*${sqliteLockPath(db).replace(/\./g, "\\.")}`,
      ),
    );
  });

  it("removes the lock on a clean exit and takes over after a kill", async () => {
    const db = tempDb();
    const clean = await holdFromChild(db);
    clean.stdin!.end();
    await exited(clean);
    expect(existsSync(sqliteLockPath(db))).toBe(false);

    const killed = await holdFromChild(db);
    killed.kill("SIGKILL");
    await exited(killed);
    expect(existsSync(sqliteLockPath(db))).toBe(true);
    const release = acquireSqliteLock(db);
    release();
    expect(existsSync(sqliteLockPath(db))).toBe(false);
  });

  it("treats an unreadable lock file as stale and lets one process open twice", () => {
    const db = tempDb();
    writeFileSync(sqliteLockPath(db), "not json");
    const first = acquireSqliteLock(db);
    const second = acquireSqliteLock(db);
    first();
    expect(existsSync(sqliteLockPath(db))).toBe(true);
    second();
    expect(existsSync(sqliteLockPath(db))).toBe(false);
  });
});
