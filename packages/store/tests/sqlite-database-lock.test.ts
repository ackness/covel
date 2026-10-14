import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
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

// Pause after reading the stale owner, before the takeover mutates the path.
// A real second process runs to completion in that gap; no timing sleeps.
function contender(db: string, pause: "owner" | "claim" | "published" | false) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    let pause = ${JSON.stringify(pause)};
    for (const [method, phase, filePath] of [
      ["readFileSync", "owner", ${JSON.stringify(sqliteLockPath(db))}],
      ["readdirSync", "claim", ${JSON.stringify(`${sqliteLockPath(db)}.claim`)}],
      ["writeFileSync", "published", ${JSON.stringify(sqliteLockPath(db))}],
    ]) {
      const original = fs[method];
      fs[method] = function (file, ...args) {
        const value = original.call(this, file, ...args);
        if (pause === phase && file === filePath) {
          pause = false;
          process.stdout.write("observed\\n");
          fs.readSync(0, Buffer.alloc(1), 0, 1, null);
        }
        return value;
      };
    }
    syncBuiltinESMExports();
    const { acquireSqliteLock } = await import(${JSON.stringify(lockModule)});
    try { acquireSqliteLock(${JSON.stringify(db)}); process.stdout.write("held\\n"); }
    catch { process.stdout.write("blocked\\n"); }
    process.stdin.resume();
  `,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  children.push(child);
  const lines: string[] = [];
  let receive: ((line: string) => void) | undefined;
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (receive) {
      const resolve = receive;
      receive = undefined;
      resolve(line);
    } else lines.push(line);
  });
  return {
    child,
    next: () =>
      new Promise<string>((resolve, reject) => {
        const line = lines.shift();
        if (line !== undefined) resolve(line);
        else receive = resolve;
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("contender exited before its result")),
        );
      }),
  };
}

afterEach(async () => {
  const active = children.splice(0);
  for (const child of active) child.kill("SIGKILL");
  await Promise.all(active.map(exited));
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("sqlite database lock", () => {
  it("does not let two processes take over the same stale observation", async () => {
    const db = tempDb();
    const previous = await holdFromChild(db);
    previous.kill("SIGKILL");
    await exited(previous);
    const first = contender(db, "owner");
    expect(await first.next()).toBe("observed");
    const second = contender(db, false);
    const secondResult = await second.next();
    first.child.stdin!.write("x");
    const firstResult = await first.next();
    expect(
      [firstResult, secondResult].filter((result) => result === "held"),
    ).toHaveLength(1);
    expect(JSON.parse(readFileSync(sqliteLockPath(db), "utf8")).pid).toBe(
      first.child.pid,
    );
    expect(() => acquireSqliteLock(db)).toThrow("already in use");
    expect(readdirSync(path.dirname(db))).toEqual(["covel.db.lock"]);
  });

  it("recovers a claim whose process died during stale takeover", async () => {
    const db = tempDb();
    writeFileSync(sqliteLockPath(db), "not json");
    const interrupted = contender(db, "owner");
    expect(await interrupted.next()).toBe("observed");
    expect(existsSync(`${sqliteLockPath(db)}.claim`)).toBe(true);
    interrupted.child.kill("SIGKILL");
    await exited(interrupted.child);
    const release = acquireSqliteLock(db);
    try {
      expect(JSON.parse(readFileSync(sqliteLockPath(db), "utf8")).pid).toBe(
        process.pid,
      );
      expect(readdirSync(path.dirname(db))).toEqual(["covel.db.lock"]);
    } finally {
      release();
    }
    expect(readdirSync(path.dirname(db))).toEqual([]);
  });

  it("does not release another generation with the same pid", () => {
    const db = tempDb();
    const release = acquireSqliteLock(db);
    const replacement = JSON.stringify({
      pid: process.pid,
      startedAt: "another-generation",
    });
    writeFileSync(sqliteLockPath(db), replacement);
    release();
    expect(readFileSync(sqliteLockPath(db), "utf8")).toBe(replacement);
  });

  it("does not let a delayed claim reclaimer remove a new owner", async () => {
    const db = tempDb();
    writeFileSync(sqliteLockPath(db), "not json");
    const interrupted = contender(db, "owner");
    expect(await interrupted.next()).toBe("observed");
    interrupted.child.kill("SIGKILL");
    await exited(interrupted.child);
    const delayed = contender(db, "claim");
    expect(await delayed.next()).toBe("observed");
    const winner = contender(db, false);
    expect(await winner.next()).toBe("held");
    delayed.child.stdin!.write("x");
    expect(await delayed.next()).toBe("blocked");
    expect(JSON.parse(readFileSync(sqliteLockPath(db), "utf8")).pid).toBe(
      winner.child.pid,
    );
    expect(readdirSync(path.dirname(db))).toEqual(["covel.db.lock"]);
  });

  it("rejects a changed ownership read-back without deleting the replacement", async () => {
    const db = tempDb();
    const pending = contender(db, "published");
    expect(await pending.next()).toBe("observed");
    const replacement = JSON.stringify({
      pid: pending.child.pid,
      startedAt: "replaced-before-read-back",
    });
    writeFileSync(sqliteLockPath(db), replacement);
    pending.child.stdin!.write("x");
    expect(await pending.next()).toBe("blocked");
    expect(readFileSync(sqliteLockPath(db), "utf8")).toBe(replacement);
    expect(readdirSync(path.dirname(db))).toEqual(["covel.db.lock"]);
  });

  it("counts relative and absolute paths as the same lock", () => {
    const db = tempDb();
    const first = acquireSqliteLock(db);
    const second = acquireSqliteLock(path.relative(process.cwd(), db));
    try {
      first();
      expect(existsSync(sqliteLockPath(db))).toBe(true);
    } finally {
      first();
      second();
    }
    expect(existsSync(sqliteLockPath(db))).toBe(false);
  });
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
