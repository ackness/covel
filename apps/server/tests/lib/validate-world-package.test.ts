// @vitest-environment node
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
    await writeFile(path.join(worldDir, "WORLD.en.md"), "Lore.");
    expect(await validate(worldDir)).toEqual([
      expect.objectContaining({
        level: "error",
        code: "lore-missing",
        locales: ["zh-CN"],
      }),
    ]);

    await writeFile(path.join(worldDir, "WORLD.zh.md"), "世界观。");
    expect(await validate(worldDir)).toEqual([
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
    const castPath = path.join(worldDir, "characters/main-cast.en.json");
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
        file: "characters/main-cast.en.json",
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
    const rulesPath = path.join(worldDir, "data/rules/barrow-rules.en.yaml");
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
        file: "data/rules/barrow-rules.en.yaml",
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
