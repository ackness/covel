import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeneratedWorld } from "./types.js";
import { parse } from "yaml";
import {
  GENERATED_WORLD_MARKER,
  WorldPackageModifiedError,
  inspectGeneratedWorldPackage,
  readGeneratedWorldMarker,
  recordGeneratedWorldFiles,
  writeWorldPackage,
} from "./world-writer.js";

const world: GeneratedWorld = {
  id: "marked-world",
  manifest: {
    id: "marked-world",
    name: "Marked world",
    summary: "A world for marker testing",
    version: "0.1.0",
    defaultLocale: "en",
  },
  locale: "en",
  lore: "original",
  packageContent: {
    characters: [{ id: "keeper", name: "Keeper", type: "npc" }],
    lorebook: [],
    rules: [],
  },
  warnings: [],
};
const revised = { ...world, lore: "revised" };

describe("generated world marker", () => {
  let root = "";
  let dir = "";
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "covel-world-marker-"));
    dir = path.join(root, world.id);
    await writeWorldPackage(root, world);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const lore = () => readFile(path.join(dir, "WORLD.md"), "utf8");

  it("lists every file the generator wrote, and such a package is rewritten", async () => {
    const marker = await readGeneratedWorldMarker(dir);
    expect(Object.keys(marker?.files ?? {})).toEqual([
      "WORLD.md",
      "characters/characters.json",
      "world.yaml",
    ]);
    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "pristine",
    });

    await writeWorldPackage(root, revised, { replace: true });

    expect(await lore()).toBe("revised");
    // The new package is listed in turn, so it can be revised again.
    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "pristine",
    });
  });

  it("does not replace a package that a person put a file into", async () => {
    await mkdir(path.join(dir, "media"));
    await writeFile(path.join(dir, "media", "keeper.png"), "portrait");

    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "modified",
      added: ["media/keeper.png"],
      changed: [],
    });
    const error = await writeWorldPackage(root, revised, {
      replace: true,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorldPackageModifiedError);
    expect((error as WorldPackageModifiedError).added).toEqual([
      "media/keeper.png",
    ]);
    expect((error as Error).message).toContain("media/keeper.png");
    expect(await lore()).toBe("original");
    expect(await readFile(path.join(dir, "media", "keeper.png"), "utf8")).toBe(
      "portrait",
    );
  });

  it("publishes portable dimensions once and removes the file when the last definition is cleared", async () => {
    const definitions = {
      alarm: {
        name: "Alarm",
        schema: { type: "integer" as const },
        initialValue: 17,
      },
    };
    const withDimensions = {
      ...world,
      packageContent: { ...world.packageContent, dimensions: definitions },
    };
    await writeWorldPackage(root, withDimensions, { replace: true });
    const file = path.join(dir, "data/dimensions.yaml");
    expect(parse(await readFile(file, "utf8"))).toEqual(definitions);
    expect(
      parse(await readFile(path.join(dir, "world.yaml"), "utf8")),
    ).not.toHaveProperty("dimensions");
    expect(await readGeneratedWorldMarker(dir)).toMatchObject({
      files: { "data/dimensions.yaml": expect.any(String) },
    });
    await writeWorldPackage(
      root,
      {
        ...withDimensions,
        packageContent: { ...withDimensions.packageContent, dimensions: {} },
      },
      { replace: true },
    );
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readGeneratedWorldMarker(dir))?.files).not.toHaveProperty(
      "data/dimensions.yaml",
    );
    expect(withDimensions.packageContent.dimensions).toEqual(definitions);
  });

  it("does not replace a package whose generated file a person edited", async () => {
    await writeFile(path.join(dir, "WORLD.md"), "edited by hand");

    const error = await writeWorldPackage(root, revised, {
      replace: true,
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WorldPackageModifiedError);
    expect((error as WorldPackageModifiedError).changed).toEqual(["WORLD.md"]);
    expect(await lore()).toBe("edited by hand");
  });

  it("does not replace a package whose marker has no file list", async () => {
    // What a build before the file list wrote.
    await writeFile(
      path.join(dir, GENERATED_WORLD_MARKER),
      `${JSON.stringify({ schemaVersion: 1 })}\n`,
    );

    expect(await readGeneratedWorldMarker(dir)).toBeNull();
    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "unmarked",
    });
    await expect(
      writeWorldPackage(root, revised, { replace: true }),
    ).rejects.toThrow("not written by the generator");
    expect(await lore()).toBe("original");
  });

  it("takes files the app wrote later for its own, and ignores desktop files", async () => {
    await writeFile(path.join(dir, "WORLD.zh-CN.md"), "译文");
    await writeFile(path.join(dir, ".DS_Store"), "");
    await recordGeneratedWorldFiles(dir, ["WORLD.zh-CN.md"]);

    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "pristine",
    });
    // A listed file that was removed is no loss to a rewrite.
    await rm(path.join(dir, "WORLD.zh-CN.md"));
    expect(await inspectGeneratedWorldPackage(dir)).toEqual({
      state: "pristine",
    });
  });
});
