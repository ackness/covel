/**
 * Copying the player's data to a new data root.
 *
 * The rules, in the order they matter:
 *   - The old data root is only read. Nothing in it is moved or deleted.
 *   - The database is copied only while no process has it open, so the copy
 *     never runs when the player picks the directory (the sidecar holds the
 *     database then). The choice is recorded and the main process copies at
 *     the next start, before it spawns the sidecar.
 *   - Nothing in the destination is overwritten. A destination that already
 *     holds Covel data is used as it is.
 *   - A failed copy removes what it created and leaves `data_root` unchanged.
 *
 * No Electron import: the planner and the executor run on plain directories.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** The SQLite database with the two files it has while a WAL is pending. */
const DATABASE_FILES = ["covel.db", "covel.db-wal", "covel.db-shm"] as const;

/** Directories that travel with the database. */
const DATA_DIRECTORIES = ["worlds", "media"] as const;

/**
 * The copy is written here first and renamed into place at the end, so a
 * destination never shows a half-written `covel.db`.
 */
export const STAGING_DIR = ".covel-data-copy.tmp";

function exists(file: string): boolean {
  return fs.existsSync(file);
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The path with symlinks resolved as far as it exists. */
function canonical(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    return path.join(canonical(parent), path.basename(resolved));
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export function sameDataRoot(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** True when the directory holds a database file, world, or media. */
function hasCovelData(root: string): boolean {
  if (DATABASE_FILES.some((name) => exists(path.join(root, name)))) return true;
  return DATA_DIRECTORIES.some((name) => {
    try {
      return fs.readdirSync(path.join(root, name)).length > 0;
    } catch {
      return false;
    }
  });
}

/**
 * What switching from `from` to `to` means for the player's data:
 *   - `same`: both name one directory.
 *   - `nested`: one lies inside the other; a copy could read its own output.
 *   - `destination-has-data`: the destination is used as it is.
 *   - `source-empty`: there is nothing to bring over.
 *   - `copy`: the data can be copied.
 */
export type DataRootSwitchPlan =
  "same" | "nested" | "destination-has-data" | "source-empty" | "copy";

export function planDataRootSwitch(
  from: string,
  to: string,
): DataRootSwitchPlan {
  const source = canonical(from);
  const destination = canonical(to);
  if (source === destination) return "same";
  if (hasCovelData(destination)) return "destination-has-data";
  if (!hasCovelData(source)) return "source-empty";
  if (isInside(source, destination) || isInside(destination, source))
    return "nested";
  return "copy";
}

export interface DataRootCopyIo {
  /** Replaced in tests to fail part-way through. */
  readonly copyFile: (source: string, destination: string) => Promise<void>;
}

const defaultIo: DataRootCopyIo = {
  copyFile: (source, destination) =>
    fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL),
};

async function removeQuietly(target: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch {
    // The copy error is the one worth reporting.
  }
}

/**
 * Copy the database files, `worlds/` and `media/` from `from` to `to`. `logs/` and
 * `server.port` belong to one location and are not copied.
 *
 * The caller guarantees that no process has the database open. Resolves to a
 * function that removes exactly what this call created; a call that throws
 * has already removed it.
 */
export async function copyDataRoot(
  from: string,
  to: string,
  io: DataRootCopyIo = defaultIo,
): Promise<() => Promise<void>> {
  const plan = planDataRootSwitch(from, to);
  if (plan !== "copy") {
    throw new Error(`data cannot be copied to ${to} (${plan})`);
  }

  // Created by this call, newest first: the order to remove them in.
  const created: string[] = [];
  const undo = async (): Promise<void> => {
    for (const target of created) await removeQuietly(target);
    created.length = 0;
  };

  try {
    // The first directory `mkdir` had to create, when the destination or one
    // of its parents did not exist.
    const createdRoot = await fs.promises.mkdir(to, { recursive: true });
    if (createdRoot) created.unshift(createdRoot);

    // Not recursive: a staging directory that is already there is not ours.
    const staging = path.join(to, STAGING_DIR);
    await fs.promises.mkdir(staging);
    created.unshift(staging);

    const databaseFiles = DATABASE_FILES.filter((name) =>
      exists(path.join(from, name)),
    );
    for (const name of databaseFiles) {
      const source = path.join(from, name);
      const staged = path.join(staging, name);
      await io.copyFile(source, staged);
      const [before, after] = await Promise.all([
        fs.promises.stat(source),
        fs.promises.stat(staged),
      ]);
      if (before.size !== after.size) {
        throw new Error(`${name} was not copied completely`);
      }
    }

    const directories = [];
    for (const name of DATA_DIRECTORIES) {
      const source = path.join(from, name);
      const entries = isDirectory(source)
        ? await fs.promises.readdir(source)
        : [];
      if (entries.length === 0) continue;
      await fs.promises.cp(source, path.join(staging, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      directories.push({ name, entries });
    }

    // Everything is on the destination's disk. Put it in place: directories first
    // and `covel.db` last, so the database appears only when the rest is there.
    const place = async (staged: string, target: string): Promise<void> => {
      if (exists(target)) throw new Error(`${target} already exists`);
      await fs.promises.rename(staged, target);
      created.unshift(target);
    };
    for (const { name, entries } of directories) {
      const target = path.join(to, name);
      if (!exists(target)) {
        await place(path.join(staging, name), target);
      } else {
        // Fill an existing empty directory without replacing it.
        for (const entry of entries) {
          await place(
            path.join(staging, name, entry),
            path.join(target, entry),
          );
        }
      }
    }
    for (const name of [...databaseFiles].reverse()) {
      await place(path.join(staging, name), path.join(to, name));
    }

    await removeQuietly(staging);
    created.splice(created.indexOf(staging), 1);
    return undo;
  } catch (error) {
    await undo();
    throw error;
  }
}

// ── The recorded choice ─────────────────────────────────────────

export interface PendingDataRootCopy {
  readonly from: string;
  readonly to: string;
  /** Set just before the copy starts; still set at a start means it was cut short. */
  readonly started?: boolean;
}

export function readPendingDataRootCopy(
  recordFile: string,
): PendingDataRootCopy | null {
  try {
    const value = JSON.parse(fs.readFileSync(recordFile, "utf-8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const record = value as Partial<PendingDataRootCopy>;
    if (
      typeof record.from !== "string" ||
      typeof record.to !== "string" ||
      !path.isAbsolute(record.from) ||
      !path.isAbsolute(record.to)
    ) {
      return null;
    }
    return {
      from: record.from,
      to: record.to,
      started: record.started === true,
    };
  } catch {
    // No record, or one nobody can use: there is nothing pending.
    return null;
  }
}

export function writePendingDataRootCopy(
  recordFile: string,
  record: PendingDataRootCopy,
): void {
  fs.mkdirSync(path.dirname(recordFile), { recursive: true });
  const temporaryFile = `${recordFile}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(record, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryFile, recordFile);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryFile);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

export function clearPendingDataRootCopy(recordFile: string): void {
  fs.rmSync(recordFile, { force: true });
}

// ── The copy at startup ─────────────────────────────────────────

export type DataRootCopyOutcome =
  | { readonly kind: "none" }
  /** `copied`: the data is in `to`. `used-existing`: `to` had data already. */
  | {
      readonly kind: "copied" | "used-existing" | "switched";
      readonly from: string;
      readonly to: string;
    }
  /** `data_root` is unchanged and the app keeps using `from`. */
  | {
      readonly kind: "failed";
      readonly from: string;
      readonly to: string;
      readonly reason: "in-use" | "interrupted" | "error";
      readonly error?: string;
    };

export interface ApplyPendingDataRootCopyDeps {
  readonly recordFile: string;
  /** The data root `config.toml` names now. */
  readonly currentRoot: string;
  /** True when a process may still have the database in `root` open. */
  readonly databaseInUse: (root: string) => Promise<boolean>;
  /** Write the new `data_root` to `config.toml`. */
  readonly switchRoot: (to: string) => void;
  readonly copy?: typeof copyDataRoot;
}

/**
 * Carry out the copy the player asked for, once. Run it before the sidecar is
 * spawned and before the directories of the data root are prepared. The record
 * is gone afterwards whatever happened, so a failure is never retried behind
 * the player's back.
 */
export async function applyPendingDataRootCopy({
  recordFile,
  currentRoot,
  databaseInUse,
  switchRoot,
  copy = copyDataRoot,
}: ApplyPendingDataRootCopyDeps): Promise<DataRootCopyOutcome> {
  const record = readPendingDataRootCopy(recordFile);
  if (!record) {
    // Also removes a record nobody can read.
    clearPendingDataRootCopy(recordFile);
    return { kind: "none" };
  }
  const { from, to } = record;
  try {
    // `config.toml` was edited since the choice: the record is about another root.
    if (!sameDataRoot(from, currentRoot)) return { kind: "none" };

    if (record.started) {
      // The last start died during the copy. The staging directory is this
      // copy's own. Files already renamed into place are left alone: this
      // start cannot prove which ones the dead run created.
      await removeQuietly(path.join(to, STAGING_DIR));
      return { kind: "failed", from, to, reason: "interrupted" };
    }

    const plan = planDataRootSwitch(from, to);
    if (plan === "same") return { kind: "none" };
    if (plan === "destination-has-data") {
      switchRoot(to);
      return { kind: "used-existing", from, to };
    }
    if (plan === "source-empty") {
      switchRoot(to);
      return { kind: "switched", from, to };
    }
    if (plan === "nested") {
      throw new Error(
        "the new location and the current one contain each other",
      );
    }
    if (await databaseInUse(from)) {
      return { kind: "failed", from, to, reason: "in-use" };
    }

    writePendingDataRootCopy(recordFile, { from, to, started: true });
    const undo = await copy(from, to);
    try {
      switchRoot(to);
    } catch (error) {
      // The app stays on the old root; a copy nobody uses would go stale.
      await undo();
      throw error;
    }
    return { kind: "copied", from, to };
  } catch (error) {
    return {
      kind: "failed",
      from,
      to,
      reason: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      clearPendingDataRootCopy(recordFile);
    } catch {
      // The next start reads the record again and reports it.
    }
  }
}
