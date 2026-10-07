import fs, { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteMediaStore } from "../src/media-store/sqlite.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});
afterEach(() => vi.mocked(rmSync).mockImplementation(fs.rmSync));

describe.each(["delete", "cleanup"])(
  "SQLite media %s file boundary",
  (operation) => {
    it("holds the database write lock until bytes are removed, preventing same-digest recreation", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "covel-media-unlink-"));
      const dbPath = path.join(dir, "store.db");
      const store = createSqliteMediaStore(dbPath, {
        mediaRoot: path.join(dir, "media"),
      });
      const competitor = new Database(dbPath, { timeout: 0 });
      try {
        const ref = await store.put(new Uint8Array([1, 2, 3]), "image/png");
        let observed = false;
        vi.mocked(rmSync).mockImplementation((file, options) => {
          if (String(file).endsWith(`${ref.id}.bin`)) {
            observed = true;
            expect(() => competitor.exec("BEGIN IMMEDIATE")).toThrow(/locked/);
          }
          fs.rmSync(file, options);
        });
        if (operation === "delete") await store.delete(ref.id);
        else await store.cleanup(new Set(), { maxBytes: 0, dryRun: false });
        expect(observed).toBe(true);
        expect(await store.exists(ref.id)).toBe(false);
      } finally {
        competitor.close();
        await store.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("retains metadata and reference claims when unlink fails", async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "covel-media-unlink-failure-"),
      );
      const store = createSqliteMediaStore(path.join(dir, "store.db"), {
        mediaRoot: path.join(dir, "media"),
      });
      try {
        const ref = await store.put(new Uint8Array([4, 5]), "image/png");
        if (operation === "delete") await store.addRef(ref.id, "owner");
        vi.mocked(rmSync).mockImplementation((file, options) => {
          if (String(file).endsWith(`${ref.id}.bin`))
            throw new Error("Synthetic unlink failure");
          fs.rmSync(file, options);
        });
        const remove =
          operation === "delete"
            ? store.delete(ref.id)
            : store.cleanup(new Set(), { maxBytes: 0, dryRun: false });
        await expect(remove).rejects.toThrow("Synthetic unlink failure");
        expect(await store.exists(ref.id)).toBe(true);
        expect(await store.lookup(ref.id)).not.toBeNull();
        if (operation === "delete")
          expect(await store.isReferencedBy(ref.id, "owner")).toBe(true);
      } finally {
        await store.close?.();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
