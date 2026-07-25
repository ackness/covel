/**
 * Standalone assert-based self-check for the zip-bomb / path guards in
 * `zip-extract.ts`. The desktop package has no vitest harness and its other
 * modules touch Electron at import time, so this runs directly via tsx:
 *
 *   pnpm --filter @covel/desktop test
 *
 * Hand-crafted zip byte buffers, no fixtures or test framework: this asserts
 * the limits reject. The happy path is exercised by the real importer.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractZipSafely, LIMITS, safeEntryPath } from "./zip-extract.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "covel-zip-check-"));

function tmpZip(name: string, buf: Buffer): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, buf);
  return p;
}

/** Minimal EOCD-only zip claiming `entryCount` entries (cdSize/cdOffset = 0). */
function eocdOnly(entryCount: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0); // EOCD signature
  b.writeUInt16LE(entryCount, 10); // total entries on this disk
  b.writeUInt16LE(entryCount, 8);
  return b;
}

/** A single-entry zip with a stored (method 0) file. `declaredUncompressed`
 *  lets us lie in the header independently of the real content length. */
function singleStoredEntryZip(
  fileName: string,
  content: Buffer,
  declaredUncompressed = content.length,
): Buffer {
  const nameBuf = Buffer.from(fileName, "utf-8");
  // CRC is unused by extractZipSafely — leave it 0.

  const lfh = Buffer.alloc(30 + nameBuf.length);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(0, 8); // method: stored
  lfh.writeUInt32LE(content.length, 18); // compressed size
  lfh.writeUInt32LE(declaredUncompressed, 22); // uncompressed size (may lie)
  lfh.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(lfh, 30);
  const lfhStart = 0;
  const dataStart = lfh.length;

  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(0, 10); // method: stored
  cd.writeUInt32LE(content.length, 20); // compressed size
  cd.writeUInt32LE(declaredUncompressed, 24); // uncompressed size
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(lfhStart, 42); // local header offset
  nameBuf.copy(cd, 46);

  const cdStart = dataStart + content.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12); // cd size
  eocd.writeUInt32LE(cdStart, 16); // cd offset

  return Buffer.concat([lfh, content, cd, eocd]);
}

async function rejects(
  zipPath: string,
  match: RegExp,
  label: string,
): Promise<void> {
  await assert.rejects(
    () => extractZipSafely(zipPath, tmpRoot),
    (err: unknown) => {
      assert.match(String((err as Error)?.message ?? err), match, label);
      return true;
    },
    label,
  );
}

async function main(): Promise<void> {
  // 1. Entry-count cap (cheap EOCD-only guard, no CD needed).
  await rejects(
    tmpZip("too-many.zip", eocdOnly(LIMITS.maxEntries + 1)),
    /too many entries/i,
    "entry-count cap",
  );

  // 2. Per-entry declared-size cap: a tiny stored file that lies about being
  //    huge is rejected before any allocation.
  await rejects(
    tmpZip(
      "liar.zip",
      singleStoredEntryZip(
        "big.bin",
        Buffer.from("x"),
        LIMITS.maxUncompressedBytes + 1,
      ),
    ),
    /exceeds .* bytes/i,
    "per-entry declared-size cap",
  );

  // 3. Path guard unit check (pure).
  assert.equal(safeEntryPath("../escape"), null, "reject parent traversal");
  assert.equal(safeEntryPath("/abs/path"), null, "reject absolute path");
  assert.equal(safeEntryPath("ok/nested.txt"), "ok/nested.txt", "allow safe");

  // 4. Happy path: a valid small stored entry extracts.
  const okZip = tmpZip(
    "ok.zip",
    singleStoredEntryZip("pkg/hello.txt", Buffer.from("hi")),
  );
  const res = await extractZipSafely(
    okZip,
    fs.mkdtempSync(path.join(tmpRoot, "out-")),
  );
  assert.equal(res.entries, 1, "one entry extracted");
  assert.equal(res.rootPrefix, "pkg", "root prefix detected");

  console.log("zip-extract.selfcheck: all assertions passed");
}

main()
  .catch((err) => {
    console.error("zip-extract.selfcheck FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
