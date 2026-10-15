import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createSqliteMediaStore } from "../src/media-store/sqlite.js";

function mediaFile(root: string, id: string): string {
  return path.join(root, id.slice(0, 2), id.slice(2, 4), `${id}.bin`);
}

describe.each(["media", "custom-media"])(
  "SQLite relocation with %s",
  (directory) => {
    it.each([false, true])(
      "uses only the new root (remove old: %s)",
      async (removeOld) => {
        const temp = fs.mkdtempSync(
          path.join(os.tmpdir(), "covel-media-relocation-"),
        );
        const oldRoot = path.join(temp, "old");
        const newRoot = path.join(temp, "new");
        const open = (root: string) =>
          createSqliteMediaStore(
            path.join(root, "covel.db"),
            directory === "media"
              ? undefined
              : { mediaRoot: path.join(root, directory) },
          );
        let store = open(oldRoot);
        try {
          const bytes = new Uint8Array([1, 2, 3]);
          const ref = await store.put(bytes, "image/png");
          const oldFile = mediaFile(path.join(oldRoot, directory), ref.id);
          await store.close?.();
          fs.cpSync(oldRoot, newRoot, { recursive: true });
          if (removeOld) fs.rmSync(oldRoot, { recursive: true });
          store = open(newRoot);
          const newFile = mediaFile(path.join(newRoot, directory), ref.id);
          expect(fs.readFileSync(newFile)).toEqual(Buffer.from(bytes));
          expect(await store.exists(ref.id)).toBe(true);
          expect(await store.get(ref)).toEqual(bytes);
          expect(
            new Uint8Array(
              await new Response(
                await store.openReadStream!(ref),
              ).arrayBuffer(),
            ),
          ).toEqual(bytes);
          const db = new DatabaseSync(path.join(newRoot, "covel.db"));
          try {
            expect(
              db
                .prepare("SELECT path FROM media_assets WHERE id = ?")
                .get(ref.id)?.path,
            ).toBe(`${ref.id.slice(0, 2)}/${ref.id.slice(2, 4)}/${ref.id}.bin`);
          } finally {
            db.close();
          }
          // A missing file is repaired at the new root, even if the old copy exists.
          fs.rmSync(newFile);
          expect(await store.exists(ref.id)).toBe(false);
          await store.put(bytes, "image/png");
          expect(fs.readFileSync(newFile)).toEqual(Buffer.from(bytes));
          await store.delete(ref.id);
          expect(fs.existsSync(newFile)).toBe(false);
          expect(fs.existsSync(oldFile)).toBe(!removeOld);
          const fresh = await store.put(new Uint8Array([4, 5]), "image/png");
          const freshFile = mediaFile(path.join(newRoot, directory), fresh.id);
          expect(fs.readFileSync(freshFile)).toEqual(Buffer.from([4, 5]));
          await store.cleanup(new Set(), { maxBytes: 0, dryRun: false });
          expect(fs.existsSync(freshFile)).toBe(false);
          expect(fs.existsSync(oldRoot)).toBe(!removeOld);
        } finally {
          await store.close?.();
          fs.rmSync(temp, { recursive: true, force: true });
        }
      },
    );
  },
);

it("rejects stored absolute paths without reading, repairing or deleting the old file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-media-absolute-"));
  const dbPath = path.join(root, "covel.db");
  const store = createSqliteMediaStore(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const bytes = new Uint8Array([6, 7, 8]);
    const ref = await store.put(bytes, "image/png");
    const file = mediaFile(path.join(root, "media"), ref.id);
    db.prepare("UPDATE media_assets SET path = ? WHERE id = ?").run(
      file,
      ref.id,
    );
    await expect(store.get(ref)).rejects.toThrow("Invalid relative media path");
    await expect(store.openReadStream!(ref)).rejects.toThrow(
      "Invalid relative media path",
    );
    await expect(store.delete(ref.id)).rejects.toThrow(
      "Invalid relative media path",
    );
    expect(await store.lookup(ref.id)).not.toBeNull();
    expect(fs.readFileSync(file)).toEqual(Buffer.from(bytes));
    fs.rmSync(file);
    await expect(store.put(bytes, "image/png")).rejects.toThrow(
      "Invalid relative media path",
    );
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    db.close();
    await store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
