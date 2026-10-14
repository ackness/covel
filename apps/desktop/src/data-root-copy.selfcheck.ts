import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  applyPendingDataRootCopy,
  copyDataRoot,
  planDataRootSwitch,
  readPendingDataRootCopy,
  STAGING_DIR,
  writePendingDataRootCopy,
} from "./data-root-copy.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-data-copy-"));
after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

let caseIndex = 0;
/** A fresh directory per test, holding `old/` with data and nothing else. */
function makeCase(): { dir: string; from: string; to: string } {
  const dir = path.join(tempRoot, `case-${caseIndex++}`);
  const from = path.join(dir, "old");
  fs.mkdirSync(path.join(from, "worlds", "my-world", "media"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(from, "logs"));
  fs.writeFileSync(path.join(from, "covel.db"), "database");
  fs.writeFileSync(path.join(from, "covel.db-wal"), "write-ahead log");
  fs.writeFileSync(path.join(from, "covel.db-shm"), "shared memory");
  fs.writeFileSync(path.join(from, "server.port"), "9479");
  fs.writeFileSync(path.join(from, "logs", "server.log"), "log");
  fs.writeFileSync(
    path.join(from, "worlds", "my-world", "world.yaml"),
    "id: my-world\n",
  );
  fs.writeFileSync(
    path.join(from, "worlds", "my-world", "media", "cover.png"),
    "png",
  );
  fs.mkdirSync(path.join(from, "media", "ab", "cd"), { recursive: true });
  fs.writeFileSync(path.join(from, "media", "ab", "cd", "asset.bin"), "media");
  return { dir, from, to: path.join(dir, "new") };
}

/** Every file under `root` with its contents, to compare before and after. */
function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files[`${path.relative(root, file)}/`] = "";
        walk(file);
      } else {
        files[path.relative(root, file)] = fs.readFileSync(file, "utf-8");
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
}

test("copies the database files, worlds and media, and nothing else", async () => {
  const { from, to } = makeCase();
  const before = snapshot(from);
  assert.equal(planDataRootSwitch(from, to), "copy");

  await copyDataRoot(from, to);

  assert.deepEqual(snapshot(to), {
    "covel.db": "database",
    "covel.db-shm": "shared memory",
    "covel.db-wal": "write-ahead log",
    "media/": "",
    "media/ab/": "",
    "media/ab/cd/": "",
    "media/ab/cd/asset.bin": "media",
    "worlds/": "",
    "worlds/my-world/": "",
    "worlds/my-world/media/": "",
    "worlds/my-world/media/cover.png": "png",
    "worlds/my-world/world.yaml": "id: my-world\n",
  });
  assert.deepEqual(snapshot(from), before);
});

test("fills an existing destination that holds no Covel data", async () => {
  const { from, to } = makeCase();
  fs.mkdirSync(path.join(to, "worlds"), { recursive: true });
  fs.mkdirSync(path.join(to, "media"));
  fs.writeFileSync(path.join(to, "notes.txt"), "mine");

  const undo = await copyDataRoot(from, to);
  assert.equal(fs.readFileSync(path.join(to, "covel.db"), "utf-8"), "database");
  assert.ok(fs.existsSync(path.join(to, "worlds", "my-world", "world.yaml")));

  // Undo removes the copy and leaves what was there before.
  await undo();
  assert.deepEqual(snapshot(to), {
    "notes.txt": "mine",
    "worlds/": "",
    "media/": "",
  });
});

test("copies a source containing only media", async () => {
  const { from, to } = makeCase();
  for (const name of ["covel.db", "covel.db-wal", "covel.db-shm", "worlds"])
    fs.rmSync(path.join(from, name), { recursive: true });
  assert.equal(planDataRootSwitch(from, to), "copy");
  await copyDataRoot(from, to);
  assert.equal(
    fs.readFileSync(path.join(to, "media", "ab", "cd", "asset.bin"), "utf-8"),
    "media",
  );
});

test("refuses a destination that already holds Covel data", async () => {
  for (const existing of [
    "covel.db",
    "covel.db-wal",
    "worlds/theirs/x",
    "media/ab/cd/theirs.bin",
  ]) {
    const { from, to } = makeCase();
    const file = path.join(to, existing);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "theirs");
    const before = snapshot(to);

    assert.equal(planDataRootSwitch(from, to), "destination-has-data");
    await assert.rejects(copyDataRoot(from, to), /destination-has-data/);
    assert.deepEqual(snapshot(to), before);
  }
});

test("plans without a copy when there is nothing to copy or nowhere safe", () => {
  const { dir, from } = makeCase();
  assert.equal(planDataRootSwitch(from, path.join(from, ".")), "same");
  assert.equal(planDataRootSwitch(from, path.join(from, "inner")), "nested");
  assert.equal(planDataRootSwitch(from, dir), "nested");
  const empty = path.join(dir, "empty");
  fs.mkdirSync(path.join(empty, "worlds"), { recursive: true });
  assert.equal(
    planDataRootSwitch(empty, path.join(dir, "new")),
    "source-empty",
  );
});

test("a failed copy removes what it created and leaves the source alone", async () => {
  const failAt = (name: string) => ({
    copyFile: async (source: string, destination: string) => {
      if (path.basename(source) === name) throw new Error("disk full");
      await fs.promises.copyFile(source, destination);
    },
  });

  // The destination did not exist: it is gone again.
  const fresh = makeCase();
  const before = snapshot(fresh.from);
  await assert.rejects(
    copyDataRoot(fresh.from, fresh.to, failAt("covel.db-shm")),
    /disk full/,
  );
  assert.equal(fs.existsSync(fresh.to), false);
  assert.deepEqual(snapshot(fresh.from), before);

  // The destination existed: only this copy's files are removed.
  const existing = makeCase();
  fs.mkdirSync(existing.to);
  fs.writeFileSync(path.join(existing.to, "notes.txt"), "mine");
  await assert.rejects(
    copyDataRoot(existing.from, existing.to, failAt("covel.db-wal")),
    /disk full/,
  );
  assert.deepEqual(snapshot(existing.to), { "notes.txt": "mine" });

  // A staging directory somebody else left is not this copy's to use or remove.
  const occupied = makeCase();
  fs.mkdirSync(path.join(occupied.to, STAGING_DIR), { recursive: true });
  await assert.rejects(copyDataRoot(occupied.from, occupied.to), /EEXIST/);
  assert.ok(fs.existsSync(path.join(occupied.to, STAGING_DIR)));
});

test("the pending copy runs once and switches only after it succeeded", async () => {
  const { dir, from, to } = makeCase();
  const recordFile = path.join(dir, "data-root-copy.json");
  const switched: string[] = [];
  const deps = {
    recordFile,
    currentRoot: from,
    databaseInUse: async () => false,
    switchRoot: (root: string) => void switched.push(root),
  };

  assert.deepEqual(await applyPendingDataRootCopy(deps), { kind: "none" });

  writePendingDataRootCopy(recordFile, { from, to });
  assert.deepEqual(await applyPendingDataRootCopy(deps), {
    kind: "copied",
    from,
    to,
  });
  assert.deepEqual(switched, [to]);
  assert.equal(fs.readFileSync(path.join(to, "covel.db"), "utf-8"), "database");
  assert.equal(readPendingDataRootCopy(recordFile), null);
});

test("the pending copy keeps the old root when it cannot copy safely", async () => {
  const run = async (
    prepare: (c: ReturnType<typeof makeCase>, recordFile: string) => void,
    overrides: Partial<Parameters<typeof applyPendingDataRootCopy>[0]> = {},
  ) => {
    const c = makeCase();
    const recordFile = path.join(c.dir, "data-root-copy.json");
    writePendingDataRootCopy(recordFile, { from: c.from, to: c.to });
    prepare(c, recordFile);
    const before = snapshot(c.from);
    const switched: string[] = [];
    const outcome = await applyPendingDataRootCopy({
      recordFile,
      currentRoot: c.from,
      databaseInUse: async () => false,
      switchRoot: (root) => void switched.push(root),
      ...overrides,
    });
    assert.deepEqual(snapshot(c.from), before);
    assert.equal(fs.existsSync(recordFile), false);
    return { ...c, outcome, switched };
  };

  // A process still has the database open: no copy at all.
  const inUse = await run(() => {}, { databaseInUse: async () => true });
  assert.equal(inUse.outcome.kind, "failed");
  assert.deepEqual(inUse.switched, []);
  assert.equal(fs.existsSync(inUse.to), false);

  // The copy fails: nothing is left and the root is not switched.
  const failed = await run(() => {}, {
    copy: (from, to) =>
      copyDataRoot(from, to, {
        copyFile: async () => {
          throw new Error("disk full");
        },
      }),
  });
  assert.deepEqual(failed.outcome, {
    kind: "failed",
    from: failed.from,
    to: failed.to,
    reason: "error",
    error: "disk full",
  });
  assert.deepEqual(failed.switched, []);
  assert.equal(fs.existsSync(failed.to), false);

  // config.toml cannot be written after the copy: the copy is removed.
  const unwritable = await run(() => {}, {
    switchRoot: () => {
      throw new Error("config.toml is read-only");
    },
  });
  assert.equal(unwritable.outcome.kind, "failed");
  assert.equal(fs.existsSync(unwritable.to), false);

  // The last start died during the copy: clean the staging directory, report.
  const interrupted = await run((c, recordFile) => {
    fs.mkdirSync(path.join(c.to, STAGING_DIR), { recursive: true });
    fs.writeFileSync(path.join(c.to, STAGING_DIR, "covel.db"), "half");
    writePendingDataRootCopy(recordFile, {
      from: c.from,
      to: c.to,
      started: true,
    });
  });
  assert.equal(
    interrupted.outcome.kind === "failed" && interrupted.outcome.reason,
    "interrupted",
  );
  assert.deepEqual(interrupted.switched, []);
  assert.deepEqual(snapshot(interrupted.to), {});

  // The destination got data since the choice: use it as it is.
  const taken = await run((c) => {
    fs.mkdirSync(c.to);
    fs.writeFileSync(path.join(c.to, "covel.db"), "theirs");
  });
  assert.equal(taken.outcome.kind, "used-existing");
  assert.deepEqual(taken.switched, [taken.to]);
  assert.deepEqual(snapshot(taken.to), { "covel.db": "theirs" });

  // config.toml names another root now: the record is dropped unused.
  const moved = await run(() => {}, { currentRoot: os.tmpdir() });
  assert.deepEqual(moved.outcome, { kind: "none" });
  assert.equal(fs.existsSync(moved.to), false);
});
