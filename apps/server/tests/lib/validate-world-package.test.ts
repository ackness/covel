// @vitest-environment node
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  validateWorldPackage,
  type WorldPackageDiagnostic,
} from "../../src/world-data/validate-world-package.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const pluginsDirs = [path.join(repoRoot, "plugins")];

const MANIFEST = `schemaVersion: "1.0"
id: sample-world
name: Sample World
summary: A world for validator tests.
defaultLocale: en-US
`;

/** A world directory inside its own parent, so the preflight finds only it. */
async function makeWorld(
  files: Record<string, string>,
  manifest = MANIFEST,
): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-validate-world-"));
  const worldDir = path.join(parent, "sample-world");
  for (const [name, content] of Object.entries({
    "world.yaml": manifest,
    "WORLD.md": "Lore.",
    ...files,
  })) {
    await mkdir(path.dirname(path.join(worldDir, name)), { recursive: true });
    await writeFile(path.join(worldDir, name), content);
  }
  return worldDir;
}

async function validate(
  worldDir: string,
  strict = false,
): Promise<readonly WorldPackageDiagnostic[]> {
  return (await validateWorldPackage({ worldDir, pluginsDirs, strict }))
    .diagnostics;
}

describe("validateWorldPackage", () => {
  it("accepts a minimal world", async () => {
    expect(await validate(await makeWorld({}))).toEqual([]);
  });

  it("rejects a translation file named with a bare language and gives the declared name", async () => {
    const declared = `${MANIFEST}supportedLocales: [en-US, zh-CN]\n`;
    const bare = await validate(
      await makeWorld(
        { "WORLD.en-US.md": "Lore.", "data/items.zh.yaml": "[]" },
        declared,
      ),
    );
    expect(bare.filter((item) => item.code === "locale-file-name")).toEqual([
      expect.objectContaining({
        level: "error",
        file: "data/items.zh.yaml",
        hint: expect.stringContaining("`data/items.zh-CN.yaml`"),
      }),
    ]);
    // The declared spelling is accepted.
    const exact = await validate(
      await makeWorld(
        { "WORLD.en-US.md": "Lore.", "data/items.zh-CN.yaml": "[]" },
        declared,
      ),
    );
    expect(exact.filter((item) => item.code === "locale-file-name")).toEqual(
      [],
    );
  });

  it("rejects a cover the app cannot show and accepts one it can", async () => {
    const png = "\u0089PNG";
    const ok = await validate(
      await makeWorld(
        { "media/art/front.png": png },
        `${MANIFEST}cover: media/art/front.png\naccentColor: "#336699"\n`,
      ),
    );
    expect(ok.filter((item) => item.level === "error")).toEqual([]);

    const missing = await validate(
      await makeWorld({}, `${MANIFEST}cover: media/art/absent.png\n`),
    );
    expect(missing).toEqual([
      expect.objectContaining({ level: "error", code: "cover" }),
    ]);

    const badColour = await validate(
      await makeWorld({}, `${MANIFEST}accentColor: red\n`),
    );
    expect(badColour.some((item) => item.level === "error")).toBe(true);
  });

  it("checks each character and lorebook record before session creation", async () => {
    const worldDir = await makeWorld(
      {
        "characters/characters.json": JSON.stringify([
          { id: "unknown", name: "Unknown", type: "ghost" },
          {
            id: "bad-fields",
            name: "Bad fields",
            type: "npc",
            fields: { health: "full" },
          },
          { id: "valid", name: "Valid", type: "npc", fields: { health: 10 } },
        ]),
        "data/lorebook.yaml": [
          "- id: typo",
          "  text: Wrong content field.",
          "- id: no-keys",
          "  content: Never selected.",
          "  strategy: selective",
          "- id: valid",
          "  content: Valid lore.",
          "  insertionOrder: 410.5",
        ].join("\n"),
      },
      `${MANIFEST}characterSchema:\n  types: [npc]\n  attributes:\n    - id: health\n      name: Health\n      type: number\n      category: stats\n`,
    );
    const errors = (await validate(worldDir)).filter(
      (item) => item.level === "error",
    );
    expect(errors).toHaveLength(4);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "characters/characters.json",
          pointer: "[0]",
          message: expect.stringContaining("Unknown character type: ghost"),
          hint: expect.any(String),
        }),
        expect.objectContaining({
          file: "characters/characters.json",
          pointer: "[1]",
          message: expect.stringContaining("fields.health"),
          hint: expect.any(String),
        }),
        expect.objectContaining({
          file: "data/lorebook.yaml",
          pointer: "[0]",
          message: expect.stringContaining("content"),
          hint: expect.any(String),
        }),
        expect.objectContaining({
          file: "data/lorebook.yaml",
          pointer: "[1]",
          message: expect.stringContaining("has no key"),
          hint: expect.any(String),
        }),
      ]),
    );
  });

  it("warns about large permanent prompt contributions without rejecting the package", async () => {
    const worldDir = await makeWorld(
      {
        "WORLD.md": "setting ".repeat(4400),
        "data/lorebook.yaml": `- id: permanent\n  content: ${"lore ".repeat(2000)}\n  strategy: constant\n`,
      },
      `${MANIFEST}dimensions:\n  archive:\n    name: Archive\n    schema: {type: string}\n    initialValue: ${"fact ".repeat(6800)}\n`,
    );
    const diagnostics = await validate(worldDir);
    expect(diagnostics.filter((item) => item.code === "prompt-size")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: "warning", file: "WORLD.md" }),
        expect.objectContaining({
          level: "warning",
          file: "world.yaml",
          pointer: "dimensions",
        }),
        expect.objectContaining({
          level: "warning",
          file: "data/lorebook.yaml",
        }),
      ]),
    );
    expect(diagnostics.filter((item) => item.level === "error")).toEqual([]);
  });

  it("warns about narrator-only markers that hide more than the author marked", async () => {
    const loreWarnings = async (lore: string) =>
      (await validate(await makeWorld({ "WORLD.md": lore }))).filter(
        (item) => item.code === "lore-narrator-only",
      );
    expect(
      await loreWarnings(
        "Shown.\n\n<!-- narrator-only -->\n\nSecret.\n\n<!-- /narrator-only -->\n\nShown.",
      ),
    ).toEqual([]);
    expect(
      await loreWarnings(
        "Shown.\n\n<!-- narrator-only -->\n\nSecret.\n\n<!-- end narrator-only -->\n\nMeant to be shown.",
      ),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "WORLD.md",
        pointer: "line 7",
        message: expect.stringContaining("not one of the two marker lines"),
      }),
      expect.objectContaining({
        level: "warning",
        pointer: "line 3",
        message: expect.stringContaining("no closing line"),
      }),
    ]);
  });

  it("measures lore the same in Chinese and in English", async () => {
    const warnsAboutLore = async (lore: string) =>
      (await validate(await makeWorld({ "WORLD.md": lore }, MANIFEST))).some(
        (item) => item.code === "prompt-size" && item.file === "WORLD.md",
      );
    // About 6,000 tokens in either language: both fit the story prompt.
    expect(await warnsAboutLore("雾港的潮钟每日三鸣。\n".repeat(600))).toBe(
      false,
    );
    expect(
      await warnsAboutLore("The tide bell of Mistport rings.\n".repeat(730)),
    ).toBe(false);
    // About 10,000 tokens in either language: both are cut.
    expect(await warnsAboutLore("雾港的潮钟每日三鸣。\n".repeat(1000))).toBe(
      true,
    );
    expect(
      await warnsAboutLore("The tide bell of Mistport rings.\n".repeat(1220)),
    ).toBe(true);
  });

  it("rejects unknown presets and invalid values of declared settings", async () => {
    const worldDir = await makeWorld(
      {},
      `${MANIFEST}pluginPolicy:\n  presetId: missing-pack\npluginSettings:\n  story-events:\n    planner: "yes"\n`,
    );
    const diagnostics = await validate(worldDir);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "unknown-preset",
          pointer: "pluginPolicy.presetId",
        }),
        expect.objectContaining({
          level: "error",
          code: "invalid-setting",
          pointer: "pluginSettings.story-events.planner",
        }),
      ]),
    );
  });

  it("counts descriptor-backed dimensions in prompt size diagnostics", async () => {
    const worldDir = await makeWorld(
      {
        "data/world.data.yaml":
          "schemaVersion: 1\nsources:\n  dimensions:\n    kind: json\n    path: data/dimensions.json\n    to: world:metadata.dimensions\n",
        "data/dimensions.json": JSON.stringify({
          archive: {
            name: "Archive",
            schema: { type: "string" },
            initialValue: "detail ".repeat(5200),
          },
        }),
      },
      `${MANIFEST}worldData: data/world.data.yaml\n`,
    );
    expect(await validate(worldDir)).toContainEqual(
      expect.objectContaining({ code: "prompt-size", pointer: "dimensions" }),
    );
  });

  it("checks dimension sources even without conventional data files", async () => {
    const worldDir = await makeWorld(
      {},
      `${MANIFEST}dimensionSources:\n  climate: data/missing.yaml\n`,
    );
    expect(await validate(worldDir)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          code: "world-data",
          pointer: "dimensionSources",
        }),
      ]),
    );
  });

  it("finds unclaimed files recursively in all data directories", async () => {
    const files = {
      "data/nested/forgotten.json": "[]",
      "characters/custom.json": "[]",
      "media/custom/portrait.png": "image",
    };
    const diagnostics = await validate(await makeWorld(files));
    expect(
      diagnostics
        .filter((item) => item.code === "data-file-unused")
        .map((item) => item.file)
        .sort(),
    ).toEqual(Object.keys(files).sort());
  });

  it("finds undeclared files beside an explicit descriptor without flagging its sources", async () => {
    const worldDir = await makeWorld(
      {
        "data/world.data.yaml":
          "schemaVersion: 1\nsources:\n  lore:\n    kind: json\n    path: data/known.json\n    to: lorebook\n    key: id\n",
        "data/known.json": JSON.stringify([
          { id: "known", content: "Known lore." },
        ]),
        "data/known.zh-CN.json": JSON.stringify([
          { id: "known", content: "已知设定。" },
        ]),
        "data/nested/forgotten.md": "An unclaimed story fragment.",
        "characters/custom.json": "[]",
      },
      `${MANIFEST}worldData: data/world.data.yaml\n`,
    );
    const unused = (await validate(worldDir)).filter(
      (item) => item.code === "data-file-unused",
    );
    expect(unused.map((item) => item.file).sort()).toEqual([
      "characters/custom.json",
      "data/nested/forgotten.md",
    ]);
  });

  it("reports a manifest schema error with its field path", async () => {
    const worldDir = await makeWorld({}, `${MANIFEST}unknownField: true\n`);
    const diagnostics = await validate(worldDir);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      level: "error",
      code: "manifest-invalid",
      file: "world.yaml",
    });
  });

  it("treats a near-miss plugin ID as a typo and suggests the real one", async () => {
    const worldDir = await makeWorld(
      {},
      `${MANIFEST}pluginPolicy:\n  requested: [narrator, dice-chek]\n`,
    );
    const diagnostics = await validate(worldDir);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "unknown-plugin",
        pointer: "pluginPolicy.requested[1]",
        hint: 'Did you mean "dice-check"?',
      }),
    ]);
  });

  it("only warns about an unrelated unknown plugin unless strict", async () => {
    const worldDir = await makeWorld(
      {},
      `${MANIFEST}pluginPolicy:\n  recommended: [some-community-plugin]\n`,
    );
    expect(await validate(worldDir)).toEqual([
      expect.objectContaining({ level: "warning", code: "unknown-plugin" }),
    ]);
    expect(await validate(worldDir, true)).toEqual([
      expect.objectContaining({ level: "error", code: "unknown-plugin" }),
    ]);
  });

  it("flags a preset for a setting the plugin does not declare", async () => {
    const worldDir = await makeWorld(
      {},
      `${MANIFEST}pluginSettings:\n  story-events:\n    planer: true\n`,
    );
    expect(await validate(worldDir)).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "unknown-setting",
        pointer: "pluginSettings.story-events.planer",
        hint: 'Did you mean "planner"?',
      }),
    ]);
  });

  it("requires lore for every declared locale and a fallback for the rest", async () => {
    const declared = `${MANIFEST}supportedLocales: [en-US, zh-CN]\n`;
    const parent = await mkdtemp(path.join(tmpdir(), "covel-validate-lore-"));
    const worldDir = path.join(parent, "sample-world");
    await mkdir(worldDir, { recursive: true });
    await writeFile(path.join(worldDir, "world.yaml"), declared);
    await writeFile(path.join(worldDir, "WORLD.en-US.md"), "Lore.");
    // The manifest's own text has no Chinese either; that is another finding.
    const lore = async () =>
      (await validate(worldDir)).filter((item) =>
        item.code.startsWith("lore-"),
      );
    expect(await lore()).toEqual([
      expect.objectContaining({
        level: "error",
        code: "lore-missing",
        locales: ["zh-CN"],
      }),
    ]);

    await writeFile(path.join(worldDir, "WORLD.zh-CN.md"), "世界观。");
    expect(await lore()).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "lore-fallback-missing",
      }),
    ]);
  });

  it("validates seed records against the receiving plugin's contract schema", async () => {
    const worldDir = await makeWorld(
      {
        "data/world.data.yaml": `schemaVersion: 1
sources:
  memory:
    kind: json
    path: data/memory-blocks.json
    schema: contract:memory.blocks@1
    to: contract:memory.blocks@1
    key: id
`,
        "data/memory-blocks.json": JSON.stringify({ id: "world", blocks: 7 }),
      },
      `${MANIFEST}worldData: data/world.data.yaml\n`,
    );
    const diagnostics = await validate(worldDir);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        code: "world-data",
        file: "data/memory-blocks.json",
        sourceId: "memory",
      }),
    ]);
    expect(diagnostics[0]!.message).toContain("failed schema validation");
  });

  it("reports a data contract no scanned plugin accepts", async () => {
    const worldDir = await makeWorld(
      {
        "data/world.data.yaml": `schemaVersion: 1
sources:
  memory:
    kind: json
    path: data/memory-blocks.json
    to: contract:memory.blokcs@1
    key: id
`,
        "data/memory-blocks.json": JSON.stringify({ id: "world", blocks: [] }),
      },
      `${MANIFEST}worldData: data/world.data.yaml\n`,
    );
    expect(await validate(worldDir)).toEqual([
      expect.objectContaining({
        level: "error",
        code: "unresolved-contract",
        sourceId: "memory",
        hint: 'Did you mean "memory.blocks@1"?',
      }),
    ]);
  });

  it("reports a translation that the main file has no place for", async () => {
    const worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-validate-overlay-")),
      "mistport",
    );
    await cp(path.join(repoRoot, "worlds/mistport"), worldDir, {
      recursive: true,
    });
    // An id that the main cast file does not have, and a key that
    // `world.yaml` does not have.
    const castPath = path.join(worldDir, "characters/main-cast.en-US.json");
    const cast = JSON.parse(await readFile(castPath, "utf-8")) as Record<
      string,
      unknown
    >[];
    await writeFile(
      castPath,
      JSON.stringify([...cast, { id: "npc-nobody", name: "Nobody" }]),
    );
    await writeFile(
      path.join(worldDir, "world.en-US.yaml"),
      "name: Mistport Chronicles\nsubtitle: A tale\n",
    );

    const overlays = (await validate(worldDir, true)).filter(
      (item) => item.code === "locale-overlay",
    );
    expect(overlays).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "world.en-US.yaml",
        pointer: "subtitle",
      }),
      expect.objectContaining({
        level: "warning",
        file: "characters/main-cast.en-US.json",
        sourceId: "cast",
        pointer: "[id=npc-nobody]",
      }),
    ]);
  }, 30_000);

  it("warns about text of another script left in a locale file", async () => {
    const worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-validate-script-")),
      "lantern-barrow",
    );
    await cp(path.join(repoRoot, "worlds/lantern-barrow"), worldDir, {
      recursive: true,
    });
    // A trigger word copied from the Chinese main file: an English session
    // never matches it, and the model is shown it as the rule's key.
    const rulesPath = path.join(worldDir, "data/rules/barrow-rules.en-US.yaml");
    await writeFile(
      rulesPath,
      (await readFile(rulesPath, "utf-8")).replace(
        "    - Lantern Heart\n",
        "    - 灯心\n    - Lantern Heart\n",
      ),
    );

    expect(
      (await validate(worldDir, true)).filter(
        (item) => item.code === "locale-script",
      ),
    ).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "data/rules/barrow-rules.en-US.yaml",
        pointer: "[3].keys[0]",
      }),
    ]);
    // The shipped worlds have none.
    expect(
      (
        await validate(path.join(repoRoot, "worlds/lantern-barrow"), true)
      ).filter((item) => item.code === "locale-script"),
    ).toEqual([]);
  }, 30_000);

  it("warns when a declared edition does not translate every text", async () => {
    const worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-validate-edition-")),
      "lantern-barrow",
    );
    await cp(path.join(repoRoot, "worlds/lantern-barrow"), worldDir, {
      recursive: true,
    });
    // The world declares en-US; its quests lose their English file.
    await rm(path.join(worldDir, "data/quests.en-US.yaml"));

    const editions = (await validate(worldDir, true)).filter(
      (item) => item.code === "edition-incomplete",
    );
    expect(editions).toEqual([
      expect.objectContaining({
        level: "warning",
        file: "data/quests.yaml",
        locales: ["en-US"],
        message: expect.stringContaining("a en-US session reads them in zh-CN"),
      }),
    ]);
    // The shipped worlds are complete in every language they declare.
    for (const world of [
      "mistport",
      "lantern-barrow",
      "haruka-academy",
      "emberback",
    ])
      expect(
        (await validate(path.join(repoRoot, "worlds", world), true)).filter(
          (item) => item.code === "edition-incomplete",
        ),
        world,
      ).toEqual([]);
  }, 60_000);

  it("rejects a main file that still writes translations inline", async () => {
    const worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-validate-inline-")),
      "mistport",
    );
    await cp(path.join(repoRoot, "worlds/mistport"), worldDir, {
      recursive: true,
    });
    const manifestPath = path.join(worldDir, "world.yaml");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf-8")).replace(
        /^name: .*$/m,
        "name:\n  zh-CN: 雾港・裂潮纪\n  en-US: Mistport Chronicles",
      ),
    );

    expect(
      (await validate(worldDir, true)).filter(
        (item) => item.code === "inline-locale-map",
      ),
    ).toEqual([
      expect.objectContaining({
        level: "error",
        file: "world.yaml",
        pointer: "name",
      }),
    ]);
  }, 30_000);
});
