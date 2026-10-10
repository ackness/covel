import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  worldTranslationStatus,
  writeWorldTranslations,
} from "../../src/world-data/locale-tooling.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { loadWorldDataDescriptor } from "../../src/world-data/descriptor.js";
import { readWorldDataSource } from "../../src/world-data/source-reader.js";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");

/**
 * What a translator of a world needs: which texts each file has, which a
 * language lacks, and locale files written in the form the importer reads.
 */
describe("world translation tooling", () => {
  let worldDir: string;

  beforeEach(async () => {
    worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-world-tooling-")),
      "lantern-barrow",
    );
    await cp(path.join(repoRoot, "worlds/lantern-barrow"), worldDir, {
      recursive: true,
    });
  });
  afterEach(async () => {
    await rm(path.dirname(worldDir), { recursive: true, force: true });
  });

  it("counts what an existing edition translates, file by file", async () => {
    const status = await worldTranslationStatus(worldDir, "en-US");

    expect(status.baseLocale).toBe("zh-CN");
    const rules = status.files.find(
      (file) => file.file === "data/rules/barrow-rules.yaml",
    )!;
    expect(rules.localeFile).toBe("data/rules/barrow-rules.en-US.yaml");
    expect(rules.total).toBeGreaterThan(10);
    expect(rules.missing).toEqual([]);
    // Lore is one text: the whole file.
    expect(status.files.find((file) => file.file === "WORLD.md")).toMatchObject(
      { localeFile: "WORLD.en-US.md", total: 1, missing: [] },
    );
  });

  it("extracts nested block translations by identity and preserves them after insertion", async () => {
    const blockFile = path.join(worldDir, "data/memory-blocks.json");
    const base = JSON.parse(await readFile(blockFile, "utf-8"));
    base.blocks.unshift({
      label: "new",
      displayName: "新块",
      extractionHint: "记住新的故事线索。",
    });
    await writeFile(blockFile, JSON.stringify(base));
    const status = await worldTranslationStatus(worldDir, "en-US");
    const blocks = status.files.find(
      (file) => file.file === "data/memory-blocks.json",
    )!;
    expect(blocks.missing.map((unit) => unit.pointer)).toEqual([
      "blocks[label=new].displayName",
      "blocks[label=new].extractionHint",
    ]);
    await writeWorldTranslations(
      worldDir,
      "en-US",
      new Map(
        blocks.missing.map((unit) => [
          unit.id,
          unit.pointer.endsWith("displayName")
            ? "New"
            : "Remember the new clues.",
        ]),
      ),
    );
    const after = await worldTranslationStatus(worldDir, "en-US");
    expect(
      after.files.find((file) => file.file === blocks.file)!.missing,
    ).toEqual([]);
    const overlay = JSON.parse(
      await readFile(path.join(worldDir, blocks.localeFile), "utf-8"),
    );
    expect(
      overlay.blocks.find((block: { label: string }) => block.label === "new"),
    ).toMatchObject({ displayName: "New" });
  });

  it.each(["新线索", "New clues"])(
    "keeps the selected array identity %s out of translation units and written overlays",
    async (label) => {
      const blockFile = path.join(worldDir, "data/memory-blocks.json");
      const base = JSON.parse(await readFile(blockFile, "utf-8"));
      base.blocks.unshift({ label, displayName: "新线索名称" });
      await writeFile(blockFile, JSON.stringify(base));
      const status = await worldTranslationStatus(worldDir, "en-US");
      const blocks = status.files.find(
        (file) => file.file === "data/memory-blocks.json",
      )!;
      expect(blocks.missing.map((unit) => unit.pointer)).toEqual([
        `blocks[label=${label}].displayName`,
      ]);
      await writeWorldTranslations(
        worldDir,
        "en-US",
        new Map(blocks.missing.map((unit) => [unit.id, "New clues name"])),
      );
      const overlay = JSON.parse(
        await readFile(path.join(worldDir, blocks.localeFile), "utf-8"),
      );
      expect(overlay.blocks[0]).toEqual({
        label,
        displayName: "New clues name",
      });
      const descriptor = await loadWorldDataDescriptor({
        worldRoot: worldDir,
        worldId: path.basename(worldDir),
        worldDataPath: "data/world.data.yaml",
      });
      const source = descriptor.sources.find(
        (source) => source.descriptor.path === "data/memory-blocks.json",
      )!;
      const read = await readWorldDataSource(source, "en-US");
      expect(read.diagnostics).toEqual([]);
      expect((read.value as { blocks: unknown[] }).blocks[0]).toEqual({
        label,
        displayName: "New clues name",
      });
    },
  );

  it("leaves the author's name and the license as written", async () => {
    const manifestPath = path.join(worldDir, "world.yaml");
    await writeFile(
      manifestPath,
      stringifyYaml({
        ...parseYaml(await readFile(manifestPath, "utf-8")),
        author: {
          name: "灰苇工作室",
          about: "我们做跑团世界。",
          links: [{ label: "社区", url: "https://example.com/community" }],
        },
        license: "保留所有权利",
      }),
    );

    const status = await worldTranslationStatus(worldDir, "ja-JP");
    const texts = status.files
      .find((file) => file.file === "world.yaml")!
      .missing.map((unit) => unit.pointer)
      .filter((pointer) => /^(author|license)/.test(pointer));

    // The message and the link label are text; a name and a license are not.
    expect(texts).toEqual(["author.about", "author.links[0].label"]);
  });

  it("lists every text of a language the world does not have", async () => {
    const status = await worldTranslationStatus(worldDir, "ja-JP");
    const rules = status.files.find(
      (file) => file.file === "data/rules/barrow-rules.yaml",
    )!;

    expect(rules.localeFile).toBe("data/rules/barrow-rules.ja-JP.yaml");
    expect(rules.missing).toHaveLength(rules.total);
    expect(rules.missing[0]).toMatchObject({
      id: "data/rules/barrow-rules.yaml#[id=lantern-fair-table].title",
      text: "公平的牌桌",
    });
    // Identifiers and enum values are not text.
    expect(rules.missing.map((unit) => unit.pointer)).not.toContain(
      "[id=lantern-fair-table].kind",
    );
  });

  it("writes locale files that the importer and the validator accept", async () => {
    const status = await worldTranslationStatus(worldDir, "ja-JP");
    const rules = status.files.find(
      (file) => file.file === "data/rules/barrow-rules.yaml",
    )!;
    const translations = new Map<string, string>([
      ...rules.missing.map(
        (unit) => [unit.id, `訳:${unit.pointer}`] as [string, string],
      ),
      ["WORLD.md#", "# 提灯の古墳\n\n霧の沼地。"],
    ]);

    expect(
      await writeWorldTranslations(worldDir, "ja-JP", translations),
    ).toEqual(["data/rules/barrow-rules.ja-JP.yaml", "WORLD.ja-JP.md"]);

    const overlay = parseYaml(
      await readFile(
        path.join(worldDir, "data/rules/barrow-rules.ja-JP.yaml"),
        "utf-8",
      ),
    ) as Record<string, unknown>[];
    // Only ids and translated text: no kind, position or order.
    expect(overlay[0]).toEqual({
      id: "lantern-fair-table",
      title: "訳:[id=lantern-fair-table].title",
      content: "訳:[id=lantern-fair-table].content",
    });
    // A list of trigger words is translated as a whole list.
    expect(overlay.find((rule) => rule.id === "lantern-alarm")!.keys).toEqual(
      expect.arrayContaining(["訳:[id=lantern-alarm].keys[0]"]),
    );

    const after = await worldTranslationStatus(worldDir, "ja-JP");
    expect(
      after.files.find((file) => file.file === rules.file)!.missing,
    ).toEqual([]);
    expect(
      after.files.find((file) => file.file === "WORLD.md")!.missing,
    ).toEqual([]);

    const { diagnostics } = await validateWorldPackage({
      worldDir,
      pluginsDirs: [path.join(repoRoot, "plugins")],
      strict: true,
    });
    expect(
      diagnostics.filter(
        (item) => item.code === "locale-overlay" || item.level === "error",
      ),
    ).toEqual([]);
  }, 30_000);

  it("keeps the translations a locale file already has", async () => {
    const target = path.join(worldDir, "data/quests.en-US.yaml");
    const before = parseYaml(await readFile(target, "utf-8")) as Record<
      string,
      unknown
    >[];
    await writeFile(
      target,
      (await readFile(target, "utf-8")).replace(/^(\s+)description: .*$/m, ""),
    );
    const missing = (
      await worldTranslationStatus(worldDir, "en-US")
    ).files.find((file) => file.file === "data/quests.yaml")!.missing;
    expect(missing).toHaveLength(1);

    await writeWorldTranslations(
      worldDir,
      "en-US",
      new Map([[missing[0]!.id, "A new description."]]),
    );
    const after = parseYaml(await readFile(target, "utf-8")) as Record<
      string,
      unknown
    >[];
    expect(after[0]!.name).toBe(before[0]!.name);
    expect(JSON.stringify(after)).toContain("A new description.");
  });
});

describe("world translation tooling: what counts as text", () => {
  it("reads a dimensions file by its schema", async () => {
    const status = await worldTranslationStatus(
      path.join(repoRoot, "worlds/emberback"),
      "ja-JP",
    );
    const dimensions = status.files.find(
      (file) => file.file === "data/dimensions.yaml",
    )!;
    const pointers = dimensions.missing.map((unit) => unit.pointer);

    // Labels the schema defines as text.
    expect(pointers).toContain("crownfire.name");
    expect(pointers).toContain(
      "crownfire.schema.properties.stage.x-enumLabels.distant",
    );
    // A value is text only at a node marked `x-i18n`.
    expect(pointers).toContain("geography.initialValue.overview");
    // An enum value is an identifier, whatever it looks like.
    expect(pointers).not.toContain("crownfire.initialValue.stage");
  });

  it("names the terms a language already translates", async () => {
    const status = await worldTranslationStatus(
      path.join(repoRoot, "worlds/mistport"),
      "en-US",
    );
    const cast = status.files.find(
      (file) => file.file === "characters/main-cast.json",
    )!;
    // A later translation uses these: one name, one translation.
    expect(cast.terms).toContainEqual({ source: "苏窈", target: "Su Yao" });
  });

  it("takes a list of trigger words as text when one of them is", async () => {
    const status = await worldTranslationStatus(
      path.join(repoRoot, "worlds/emberback"),
      "ja-JP",
    );
    const rules = status.files.find(
      (file) => file.file === "data/rules/world-rules.yaml",
    )!;
    const keys = rules.missing
      .filter((unit) => unit.pointer.includes(".keys["))
      .map((unit) => unit.text);
    // `storm` alone is a lowercase word; beside `Crownfire` it is a trigger.
    expect(keys).toEqual(expect.arrayContaining(["Crownfire", "storm"]));
  });
});
