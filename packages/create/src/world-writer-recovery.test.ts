import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import type { GeneratedWorld } from "./types.js";
import {
  WorldPackageRecoveryError,
  writeWorldPackage,
} from "./world-writer.js";

const faults = vi.hoisted(() => ({ publication: false, rollback: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      if (
        faults.publication &&
        path.basename(from).startsWith(".covel-create-")
      )
        throw new Error("publication denied");
      if (faults.rollback && path.basename(from) === "package")
        throw new Error("restoration denied");
      return fs.rename(from, to);
    },
  };
});

const world: GeneratedWorld = {
  id: "recovery-world",
  manifest: {
    schemaVersion: "1.0",
    id: "recovery-world",
    name: "Recovery world",
    summary: "A world for recovery testing",
    version: "0.1.0",
    defaultLocale: "en",
    supportedLocales: ["en"],
    pluginPolicy: { requested: [], recommended: [] },
  },
  locale: "en",
  lore: "replacement",
  packageContent: { characters: [], lorebook: [], rules: [] },
  warnings: [],
};
let directory: string | undefined;
afterEach(async () => {
  faults.publication = false;
  faults.rollback = false;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

it.each([false, true])(
  "preserves the complete original after publication failure with rollback failure=%s",
  async (rollback) => {
    directory = await mkdtemp(path.join(tmpdir(), "covel-world-recovery-"));
    await writeWorldPackage(directory, { ...world, lore: "original" });
    await writeFile(
      path.join(directory, world.id, "extra.txt"),
      "original extra",
    );
    faults.publication = true;
    faults.rollback = rollback;
    const error = await writeWorldPackage(directory, world, {
      replace: true,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(rollback ? WorldPackageRecoveryError : Error);
    expect((error as Error).message).toMatch(
      rollback ? /preserved.*package/ : /publication denied/,
    );
    const paths = await readdir(directory);
    const kept = rollback
      ? path.join(
          directory,
          paths.find((file) => file.startsWith(".covel-replaced-"))!,
          "package",
        )
      : path.join(directory, world.id);
    if (rollback)
      expect((error as WorldPackageRecoveryError).backupPath).toBe(kept);
    expect(await readFile(path.join(kept, "WORLD.md"), "utf8")).toBe(
      "original",
    );
    expect(await readFile(path.join(kept, "extra.txt"), "utf8")).toBe(
      "original extra",
    );
    expect(paths.some((file) => file.startsWith(".covel-create-"))).toBe(false);
    if (!rollback) expect(paths).toEqual([world.id]);
  },
);
