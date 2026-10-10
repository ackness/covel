// @vitest-environment node
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeWorldChange,
  isWorldSourceFile,
} from "../../src/world-file-watcher.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";

async function loadWithLore(lore: string, summary = "A port.") {
  const root = await mkdtemp(path.join(tmpdir(), "covel-world-change-"));
  const dir = path.join(root, "ash-harbor");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "world.yaml"),
    `schemaVersion: "1.0"\nid: ash-harbor\nname: Ash Harbor\nsummary: ${summary}\ndefaultLocale: en-US\n`,
  );
  await writeFile(path.join(dir, "WORLD.md"), lore);
  return (await loadSingleWorld(dir))!;
}

describe("describeWorldChange", () => {
  it("sees an edited WORLD.md body and nothing else", async () => {
    const before = await loadWithLore("The harbour burns.");
    const after = await loadWithLore("The harbour floods.");
    expect(describeWorldChange(before, after).areas).toEqual(["lore"]);
  });

  it("reports a changed summary apart from the lore", async () => {
    const before = await loadWithLore("Same lore.", "A port.");
    const after = await loadWithLore("Same lore.", "A busy port.");
    expect(describeWorldChange(before, after).areas).toEqual([
      "name and summary",
    ]);
  });

  it("reports nothing for a file saved without a change", async () => {
    const before = await loadWithLore("Same lore.");
    const after = await loadWithLore("Same lore.");
    expect(describeWorldChange(before, after).areas).toEqual([]);
  });
});

describe("isWorldSourceFile", () => {
  it("accepts every text file of a package, in any folder", () => {
    for (const file of [
      "ash/WORLD.md",
      "ash/WORLD.en-US.md",
      "ash/data/lorebook.yaml",
      "ash/characters/characters.json",
      "ash/media/gallery.json",
    ])
      expect(isWorldSourceFile(file), file).toBe(true);
  });

  it("ignores pictures, audio and editor scratch files", () => {
    for (const file of [
      "ash/media/gallery/cover.webp",
      "ash/media/music/theme.mp3",
      "ash/.WORLD.md.swp",
      "ash/WORLD.md~",
      "ash/.git/index",
    ])
      expect(isWorldSourceFile(file), file).toBe(false);
  });
});
