import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSqliteMediaStore } from "../src/media-store/sqlite.js";
import { mediaPath } from "../src/media-store/utils.js";

describe("SQLite blob publication", () => {
  it("rewrites the file when the row exists but the file is gone", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "covel-blob-repair-"));
    const store = createSqliteMediaStore(path.join(root, "test.db"), {
      mediaRoot: path.join(root, "media"),
    });
    try {
      const bytes = new Uint8Array(16).fill(3);
      const ref = await store.put(bytes, "image/png");
      fs.rmSync(mediaPath(path.join(root, "media"), ref.id));
      expect(await store.exists(ref.id)).toBe(false);
      await store.put(bytes, "image/png");
      expect(await store.exists(ref.id)).toBe(true);
      expect(Array.from(await store.get(ref))).toEqual(Array.from(bytes));
    } finally {
      await store.close?.();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  for (const failure of ["write", "rename"] as const) {
    it(`cleans failed ${failure} and retries with complete content`, async () => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "covel-blob-publication-"),
      );
      const store = createSqliteMediaStore(path.join(root, "test.db"), {
        mediaRoot: path.join(root, "media"),
      });
      const bytes = new Uint8Array(32).fill(7);
      const id = createHash("sha256").update(bytes).digest("hex");
      const finalPath = mediaPath(path.join(root, "media"), id);
      const write = fs.writeFileSync.bind(fs);
      const spy =
        failure === "write"
          ? vi
              .spyOn(fs, "writeFileSync")
              .mockImplementation((file, data, options) => {
                write(file, bytes.subarray(0, 4), options);
                throw new Error("synthetic ENOSPC");
              })
          : vi.spyOn(fs, "renameSync").mockImplementation(() => {
              throw new Error("synthetic rename failure");
            });
      syncBuiltinESMExports();
      try {
        await expect(store.put(bytes, "image/png")).rejects.toThrow(
          "synthetic",
        );
        expect(await store.lookup(id)).toBeNull();
        expect(fs.existsSync(finalPath)).toBe(false);
        expect(fs.readdirSync(path.dirname(finalPath))).toEqual([]);
        spy.mockRestore();
        syncBuiltinESMExports();
        // Recover an orphan final file whose old write never published metadata.
        write(finalPath, bytes.subarray(0, 4));
        const ref = await store.put(bytes, "image/png");
        const actual = await store.get(ref);
        expect(actual.byteLength).toBe(ref.size);
        expect(createHash("sha256").update(actual).digest("hex")).toBe(ref.id);
        expect(fs.readdirSync(path.dirname(finalPath))).toEqual([
          path.basename(finalPath),
        ]);
      } finally {
        spy.mockRestore();
        syncBuiltinESMExports();
        await store.close?.();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
