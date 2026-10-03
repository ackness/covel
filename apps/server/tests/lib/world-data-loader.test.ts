import {
  resolveWorldDimensionsLocale,
  worldDimensionsSchema,
} from "@covel/shared";
import { mkdtemp, mkdir, writeFile, symlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { loadWorldDataSummary } from "../../src/world-data/world-load.js";
import { parseWorldDataTarget } from "../../src/world-data/target-uri.js";

async function makeTempWorld(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "covel-world-data-"));
}

describe("world data loader", () => {
  it("loads exact-locale lore before short keys and compiles dimension overlays", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "dimensions"), { recursive: true });
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"
id: russian-world
name: Russian World
summary: Locale files
defaultLocale: ru_ru
supportedLocales: [ru_ru, en-US]
dimensionSources:
  tone: dimensions/tone.yaml
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "canonical lore");
    await writeFile(path.join(root, "WORLD.ru.md"), "short Russian lore");
    await writeFile(path.join(root, "WORLD.ru-RU.md"), "exact Russian lore");
    // The main file is the default locale. A locale file beside it holds
    // only the translated text.
    await writeFile(
      path.join(root, "dimensions/tone.yaml"),
      "name: тон\nschema: { type: string, x-i18n: true }\ninitialValue: спокойный\n",
    );
    await writeFile(
      path.join(root, "dimensions/tone.en-US.yaml"),
      "name: tone\ninitialValue: calm\n",
    );

    const record = await loadSingleWorld(root);

    expect(record?.locale).toBe("ru-RU");
    expect(record?.lore).toBe("exact Russian lore");
    expect(record?.metadata?.dimensions).toEqual({
      tone: {
        name: { "ru-RU": "тон", "en-US": "tone" },
        schema: { type: "string", "x-i18n": true },
        initialValue: { "ru-RU": "спокойный", "en-US": "calm" },
      },
    });
  });

  it("keeps Simplified Chinese text apart from a Traditional Chinese world", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "dimensions"), { recursive: true });
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"
id: traditional-world
name: Traditional World
summary: Script-safe locale files
defaultLocale: zh-Hant-TW
dimensionSources:
  tone: dimensions/tone.yaml
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "canonical lore");
    await writeFile(path.join(root, "WORLD.zh.md"), "simplified lore");
    await writeFile(
      path.join(root, "dimensions/tone.yaml"),
      "name: tone\nschema: { type: string, x-i18n: true }\ninitialValue: 繁體\n",
    );
    await writeFile(
      path.join(root, "dimensions/tone.zh.yaml"),
      "initialValue: 简体\n",
    );

    const record = await loadSingleWorld(root);

    expect(record?.lore).toBe("canonical lore");
    const dimensions = worldDimensionsSchema.parse(
      record?.metadata?.dimensions,
    );
    // The overlay is a separate language entry, never a replacement.
    expect(dimensions.tone!.initialValue).toEqual({
      "zh-Hant-TW": "繁體",
      zh: "简体",
    });
    expect(
      resolveWorldDimensionsLocale(dimensions, "zh-Hant-TW").tone!.initialValue,
    ).toBe("繁體");
    expect(
      resolveWorldDimensionsLocale(dimensions, "zh-CN").tone!.initialValue,
    ).toBe("简体");
  });

  it("rejects a path-like defaultLocale before reading locale files", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"
id: unsafe-world
name: Unsafe World
summary: Unsafe locale
defaultLocale: x/../../../docs/reference/i18n
`,
    );

    const record = await loadSingleWorld(root);

    expect(record).toBeNull();
  });

  it("passes pluginPolicy from world.yaml into world metadata", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: policy-world
name: Policy World
summary: World with plugin policy
defaultLocale: zh-CN
supportedLocales: [zh-CN]
pluginPolicy:
  presetId: dialogue-mode
  preferredTags:
    - mode:dialogue
  avoidedTags:
    - mode:traditional-story
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Policy World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginPolicy).toEqual({
      presetId: "dialogue-mode",
      preferredTags: ["mode:dialogue"],
      avoidedTags: ["mode:traditional-story"],
    });
  });

  it("passes pluginSettings from world.yaml into world metadata", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: settings-world
name: Settings World
summary: World with plugin settings
defaultLocale: zh-CN
supportedLocales: [zh-CN]
pluginSettings:
  story-events:
    planner: true
  chat-mode-narrator:
    dialogueRatio: 70
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Settings World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginSettings).toEqual({
      "story-events": { planner: true },
      "chat-mode-narrator": { dialogueRatio: 70 },
    });
  });

  it.each([
    "memoryBlocks: []",
    "requiredPlugins: []",
    "recommendedPlugins: []",
    "characterBlueprintSources: []",
  ])("rejects removed world manifest field %s", async (removed) => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"\nid: current-world\nname: Current\nsummary: Strict world contract\ndefaultLocale: en-US\n${removed}\n`,
    );
    expect(await loadSingleWorld(root)).toBeNull();
  });

  it("passes defaultViewMode from world.yaml into world metadata", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: stage-world
name: Stage World
summary: World declaring a stage default view mode
defaultLocale: zh-CN
supportedLocales: [zh-CN]
defaultViewMode: stage
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Stage World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.defaultViewMode).toBe("stage");
  });

  it("omits defaultViewMode from world metadata when not declared", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: no-view-mode-world
name: No View Mode World
summary: World without a declared default view mode
defaultLocale: zh-CN
supportedLocales: [zh-CN]
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# No View Mode World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.defaultViewMode).toBeUndefined();
  });

  it("builds a lightweight metadata summary and projects world metadata", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions
  opening:
    kind: markdown
    path: data/opening.md
    to: lorebook
    key: opening-scene
    after: dimensions
`,
    );
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - 校园\n    contentRating: teen\n",
    );
    await writeFile(path.join(root, "data/opening.md"), "# Opening");

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(result.metadata.dimensions).toEqual({
      tone: {
        name: "tone",
        schema: {},
        initialValue: { genres: ["校园"], contentRating: "teen" },
      },
    });
    expect(result.metadata.worldData).toMatchObject({
      schemaVersion: 1,
      sources: [
        { id: "dimensions", target: "world:metadata.dimensions", order: 0 },
        { id: "opening", target: "lorebook", order: 1 },
      ],
    });
    expect(JSON.stringify(result.metadata.worldData)).not.toContain("Opening");
    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
  });

  it("applies user override paths from the override root", async () => {
    const root = await makeTempWorld();
    const home = await mkdtemp(path.join(tmpdir(), "covel-home-"));
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(home, "world-overrides/demo/data"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions
`,
    );
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - 原版\n    contentRating: teen\n",
    );
    await writeFile(
      path.join(home, "world-overrides/demo/world.data.override.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    path: data/dimensions.override.yaml
`,
    );
    await writeFile(
      path.join(home, "world-overrides/demo/data/dimensions.override.yaml"),
      "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - 覆盖\n    contentRating: teen\n",
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
      covelHome: home,
    });

    expect(result.metadata.dimensions).toEqual({
      tone: {
        name: "tone",
        schema: {},
        initialValue: { genres: ["覆盖"], contentRating: "teen" },
      },
    });
    expect((result.metadata.worldData as any).sources[0]).toMatchObject({
      origin: "world",
      overridden: true,
    });
  });

  it("rejects symlink escape", async () => {
    const root = await makeTempWorld();
    const outside = await mkdtemp(path.join(tmpdir(), "covel-outside-"));
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(outside, "secret.yaml"), "x: 1\n");
    await symlink(
      path.join(outside, "secret.yaml"),
      path.join(root, "data/link.yaml"),
    );
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  bad:
    kind: yaml
    path: data/link.yaml
    to: world:metadata.bad
`,
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) => d.level === "error" && d.sourceId === "bad",
      ),
    ).toBe(true);
  });

  it("reports malformed override-added sources instead of crashing", async () => {
    const root = await makeTempWorld();
    const home = await mkdtemp(path.join(tmpdir(), "covel-home-"));
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(home, "world-overrides/demo"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    to: world:metadata.dimensions
`,
    );
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - 原版\n    contentRating: teen\n",
    );
    await writeFile(
      path.join(home, "world-overrides/demo/world.data.override.yaml"),
      `schemaVersion: 1
sources:
  broken:
    path: data/missing.yaml
`,
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
      covelHome: home,
    });

    expect(
      result.diagnostics.some(
        (d) => d.level === "error" && d.sourceId === "broken",
      ),
    ).toBe(true);
  });

  it("reports invalid built-in schema diagnostics", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions
`,
    );
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      "tone:\n  name: tone\n  schema: {type: array, minItems: 1}\n  initialValue: []\n",
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) => d.level === "error" && d.sourceId === "dimensions",
      ),
    ).toBe(true);
    expect(result.metadata.dimensions).toBeUndefined();
  });

  it("validates world-local schema paths", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(root, "schemas"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    schema: schemas/fact.schema.json
    to: world:metadata.facts
`,
    );
    await writeFile(path.join(root, "data/fact.json"), JSON.stringify({}));
    await writeFile(
      path.join(root, "schemas/fact.schema.json"),
      JSON.stringify({
        type: "object",
        required: ["content"],
        properties: { content: { type: "string" } },
      }),
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) =>
          d.level === "error" &&
          d.sourceId === "facts" &&
          /failed schema validation/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects world-local schema symlink escapes", async () => {
    const root = await makeTempWorld();
    const outside = await mkdtemp(path.join(tmpdir(), "covel-schema-outside-"));
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(root, "schemas"), { recursive: true });
    await writeFile(
      path.join(outside, "fact.schema.json"),
      JSON.stringify({ type: "object" }),
    );
    await symlink(
      path.join(outside, "fact.schema.json"),
      path.join(root, "schemas/fact.schema.json"),
    );
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    schema: schemas/fact.schema.json
    to: world:metadata.facts
`,
    );
    await writeFile(
      path.join(root, "data/fact.json"),
      JSON.stringify({ content: "ok" }),
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) =>
          d.level === "error" &&
          d.sourceId === "facts" &&
          /schema path is invalid or escapes/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects non-finite YAML numbers as non-JSON values", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  bad:
    kind: yaml
    path: data/bad.yaml
    to: world:metadata.dimensions
`,
    );
    await writeFile(path.join(root, "data/bad.yaml"), "value: .nan\n");

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) => d.level === "error" && d.sourceId === "bad",
      ),
    ).toBe(true);
  });

  it("does not project arbitrary world metadata targets in the MVP", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  custom:
    kind: yaml
    path: data/custom.yaml
    to: world:metadata.custom.large
`,
    );
    await writeFile(
      path.join(root, "data/custom.yaml"),
      "body: should-not-project\n",
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(result.metadata.custom).toBeUndefined();
    expect(
      result.diagnostics.some(
        (d) => d.level === "warning" && d.sourceId === "custom",
      ),
    ).toBe(true);
  });

  it("rejects invalid media index targets", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "media"), { recursive: true });
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "media/a.png"), "not really png");
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media
    to: media
    indexTo: contract:character.portrait-assets@1+lorebook
    key: filename
`,
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
    });

    expect(
      result.diagnostics.some(
        (d) => d.level === "error" && d.sourceId === "portraits",
      ),
    ).toBe(true);
  });

  it("integrates with loadSingleWorld", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"
id: demo-world
name: Demo
summary: Demo world
defaultLocale: zh-CN
worldData: data/world.data.yaml
`,
    );
    await writeFile(
      path.join(root, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions
`,
    );
    await writeFile(
      path.join(root, "data/dimensions.yaml"),
      "tone:\n  name: tone\n  schema: {}\n  initialValue:\n    genres:\n      - 测试\n    contentRating: teen\n",
    );

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.dimensions).toEqual({
      tone: {
        name: "tone",
        schema: {},
        initialValue: { genres: ["测试"], contentRating: "teen" },
      },
    });
    expect(record?.metadata?.worldData).toMatchObject({
      schemaVersion: 1,
      sources: [{ id: "dimensions", target: "world:metadata.dimensions" }],
    });
  });

  it("loads bundled worlds through worldData descriptors", async () => {
    const worldsRoot = path.resolve(import.meta.dirname, "../../../../worlds");
    // Load each world once: the checks below revisit the same worlds, and
    // repeated loads pushed this test past its timeout on a busy machine.
    const loaded = new Map<string, ReturnType<typeof loadSingleWorld>>();
    const load = (worldId: string) => {
      if (!loaded.has(worldId)) {
        loaded.set(worldId, loadSingleWorld(path.join(worldsRoot, worldId)));
      }
      return loaded.get(worldId)!;
    };
    for (const worldId of ["haruka-academy", "mistport"]) {
      const record = await load(worldId);
      expect(record?.metadata?.dimensions).toBeTruthy();
      expect(record?.metadata?.worldData).toMatchObject({
        schemaVersion: 1,
        sources: expect.arrayContaining([
          expect.objectContaining({
            id: "dimensions",
            target: "world:metadata.dimensions",
          }),
        ]),
      });
    }

    for (const [worldId, ruleSourceId] of [
      ["mistport", "tideRules"],
      ["haruka-academy", "campusRules"],
    ] as const) {
      const record = await load(worldId);
      expect(record?.metadata?.worldData).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({
            id: ruleSourceId,
            target: "contract:world.rules@1+lorebook",
          }),
        ]),
      });
    }

    const haruka = await load("haruka-academy");
    expect(haruka?.metadata?.characterBlueprints).toBeUndefined();
    expect(haruka?.metadata?.worldData).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          id: "cast",
          target: "contract:character.blueprints@1",
        }),
      ]),
    });

    // Each flagship world declares its own genre-specific core-memory blocks.
    const memoryBlocksByWorld = {
      mistport: ["clues", "commitments", "relics", "tides"],
      // Promises, rumors and festival prep are structured dimensions now.
      "haruka-academy": ["campus_schedule", "relationships"],
      emberback: ["promises", "signal_log"],
      "lantern-barrow": ["clues", "party"],
    } as const;
    for (const [worldId, labels] of Object.entries(memoryBlocksByWorld)) {
      const record = await load(worldId);
      expect(record?.metadata?.worldData).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({ target: "contract:memory.blocks@1" }),
        ]),
      });
      const { blocks } = JSON.parse(
        await readFile(
          path.join(worldsRoot, worldId, "data/memory-blocks.json"),
          "utf8",
        ),
      ) as { blocks: { label: string }[] };
      expect(blocks.map((b) => b.label).sort()).toEqual([...labels].sort());
    }
  });

  it("rejects dangerous metadata targets", () => {
    expect(
      parseWorldDataTarget("world:metadata.__proto__.polluted"),
    ).toBeNull();
    expect(
      parseWorldDataTarget("world:metadata.characterBlueprints"),
    ).toBeNull();
    expect(
      parseWorldDataTarget("contract:plugin-id.runtime-id@1/ns"),
    ).toBeNull();
  });
});
