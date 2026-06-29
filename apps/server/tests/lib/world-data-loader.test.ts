import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
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
  preset: dialogue-mode
  preferTags:
    - mode:dialogue
  avoidTags:
    - mode:traditional-story
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Policy World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginPolicy).toEqual({
      preset: "dialogue-mode",
      preferTags: ["mode:dialogue"],
      avoidTags: ["mode:traditional-story"],
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
  cost-gate:
    softTokens: 120000
    hardTokens: 160000
  chat-mode-narrator:
    dialogueRatio: 70
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Settings World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginSettings).toEqual({
      "cost-gate": { softTokens: 120000, hardTokens: 160000 },
      "chat-mode-narrator": { dialogueRatio: 70 },
    });
  });

  it("passes world memoryBlocks into world metadata", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: detective-world
name: Detective World
summary: World declaring genre-specific memory blocks
defaultLocale: zh-CN
supportedLocales: [zh-CN]
memoryBlocks:
  - label: clues
    displayName: { zh-CN: 线索, en-US: Clues }
    extractionHint: { zh-CN: 已发现的线索, en-US: Discovered clues }
    icon: Search
  - label: suspects
    displayName: { zh-CN: 嫌疑人, en-US: Suspects }
    extractionHint: { zh-CN: 嫌疑人及动机, en-US: Suspects and motives }
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Detective World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.memoryBlocks).toEqual([
      {
        label: "clues",
        displayName: { "zh-CN": "线索", "en-US": "Clues" },
        extractionHint: {
          "zh-CN": "已发现的线索",
          "en-US": "Discovered clues",
        },
        icon: "Search",
      },
      {
        label: "suspects",
        displayName: { "zh-CN": "嫌疑人", "en-US": "Suspects" },
        extractionHint: {
          "zh-CN": "嫌疑人及动机",
          "en-US": "Suspects and motives",
        },
      },
    ]);
  });

  it("folds deprecated top-level selection into pluginPolicy (deduped union)", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: fold-world
name: Fold World
summary: Top-level selection folds into pluginPolicy
defaultLocale: zh-CN
supportedLocales: [zh-CN]
requiredPlugins: [pregame, world-init]
excludedPlugins: [narrator]
pluginPolicy:
  preset: dialogue-mode
  requiredPlugins: [world-init, char-creator]
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Fold World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginPolicy).toEqual({
      preset: "dialogue-mode",
      requiredPlugins: ["world-init", "char-creator", "pregame"],
      excludedPlugins: ["narrator"],
    });
    // No separate top-level copies remain in metadata — pluginPolicy is the
    // single source of truth.
    expect(record?.metadata?.requiredPlugins).toBeUndefined();
    expect(record?.metadata?.recommendedPlugins).toBeUndefined();
    expect(record?.metadata?.excludedPlugins).toBeUndefined();
  });

  it("creates pluginPolicy from top-level-only selection (no pluginPolicy block)", async () => {
    const root = await makeTempWorld();
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1.0"
id: legacy-world
name: Legacy World
summary: Only top-level requiredPlugins, no pluginPolicy
defaultLocale: zh-CN
supportedLocales: [zh-CN]
requiredPlugins: [pregame, world-init, char-creator]
`,
    );
    await writeFile(path.join(root, "WORLD.md"), "# Legacy World");

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.pluginPolicy).toEqual({
      requiredPlugins: ["pregame", "world-init", "char-creator"],
    });
    expect(record?.metadata?.requiredPlugins).toBeUndefined();
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
      "tone:\n  genres: [校园]\n  contentRating: teen\n",
    );
    await writeFile(path.join(root, "data/opening.md"), "# Opening");

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
      now: "2026-01-01T00:00:00.000Z",
    });

    expect(result.metadata.dimensions).toEqual({
      tone: { genres: ["校园"], contentRating: "teen" },
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
      "tone:\n  genres: [原版]\n  contentRating: teen\n",
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
      "tone:\n  genres: [覆盖]\n  contentRating: teen\n",
    );

    const result = await loadWorldDataSummary({
      worldRoot: root,
      worldId: "demo",
      worldDataPath: "data/world.data.yaml",
      covelHome: home,
    });

    expect(result.metadata.dimensions).toEqual({
      tone: { genres: ["覆盖"], contentRating: "teen" },
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
      "tone:\n  genres: [原版]\n  contentRating: teen\n",
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
      "tone:\n  genres: []\n  contentRating: teen\n",
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
    indexTo: plugin:character-presence/assets+lorebook
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
      "tone:\n  genres: [测试]\n  contentRating: teen\n",
    );

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.dimensions).toEqual({
      tone: { genres: ["测试"], contentRating: "teen" },
    });
    expect(record?.metadata?.worldData).toMatchObject({
      schemaVersion: 1,
      sources: [{ id: "dimensions", target: "world:metadata.dimensions" }],
    });
  });

  it("does not eager-load legacy character blueprints when worldData is declared", async () => {
    const root = await makeTempWorld();
    await mkdir(path.join(root, "data"), { recursive: true });
    await mkdir(path.join(root, "characters"), { recursive: true });
    await writeFile(
      path.join(root, "world.yaml"),
      `schemaVersion: "1"
id: demo-world
name: Demo
summary: Demo world
defaultLocale: zh-CN
worldData: data/world.data.yaml
characterBlueprintSources:
  - characters/main-cast.json
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
      "tone:\n  genres: [测试]\n  contentRating: teen\n",
    );
    await writeFile(
      path.join(root, "characters/main-cast.json"),
      JSON.stringify([
        { schemaVersion: 1, id: "mio", name: "Mio", role: "npc" },
      ]),
    );

    const record = await loadSingleWorld(root);

    expect(record?.metadata?.characterBlueprints).toBeUndefined();
    expect(record?.metadata?.worldData).toMatchObject({
      schemaVersion: 1,
      sources: [{ id: "dimensions", target: "world:metadata.dimensions" }],
    });
  });

  it("loads bundled worlds through worldData descriptors", async () => {
    const worldsRoot = path.resolve(import.meta.dirname, "../../../../worlds");
    for (const worldId of [
      "cloudmere",
      "haruka-academy",
      "mistport",
      "neonridge",
    ]) {
      const record = await loadSingleWorld(path.join(worldsRoot, worldId));
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
      ["cloudmere", "cultivationRules"],
      ["mistport", "tideRules"],
      ["neonridge", "streetRules"],
    ] as const) {
      const record = await loadSingleWorld(path.join(worldsRoot, worldId));
      expect(record?.metadata?.worldData).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({
            id: ruleSourceId,
            target: "plugin:living-world-rules/rules+lorebook",
          }),
        ]),
      });
    }

    const haruka = await loadSingleWorld(
      path.join(worldsRoot, "haruka-academy"),
    );
    expect(haruka?.metadata?.characterBlueprints).toBeUndefined();
    expect(haruka?.metadata?.worldData).toMatchObject({
      sources: expect.arrayContaining([
        expect.objectContaining({
          id: "cast",
          target: "plugin:character-blueprint/blueprints",
        }),
      ]),
    });
  });

  it("rejects dangerous metadata targets", () => {
    expect(
      parseWorldDataTarget("world:metadata.__proto__.polluted"),
    ).toBeNull();
    expect(
      parseWorldDataTarget("world:metadata.characterBlueprints"),
    ).toBeNull();
    expect(parseWorldDataTarget("plugin:plugin-id/runtime-id/ns")).toBeNull();
  });
});
