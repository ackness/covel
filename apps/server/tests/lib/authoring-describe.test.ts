// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { worldDimensionsSchema } from "@covel/shared";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  describeAuthoringSurface,
  validateAuthoringExamples,
} from "../../src/authoring/describe.js";
import { BUILTIN_PLUGIN_PACKS } from "../../src/config/plugin-packs.js";
import {
  loadPluginCatalogue,
  validateWorldPackage,
} from "../../src/world-data/validate-world-package.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const bundledPlugins = path.join(repoRoot, "plugins");

async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}

describe("authoring surface", () => {
  it("lists kernel destinations and plugin contracts with resolved titles", async () => {
    const catalogue = await loadPluginCatalogue([bundledPlugins]);
    const surface = await describeAuthoringSurface(catalogue, {
      locale: "zh-CN",
    });

    expect(surface.destinations.map((item) => item.source.entry.to)).toEqual([
      "world:metadata.dimensions",
      "lorebook",
      "characters",
    ]);
    expect(
      surface.contracts.find((item) => item.contract === "quests@1"),
    ).toMatchObject({
      pluginId: "core-quest",
      namespace: "quests",
      title: "初始任务",
      source: {
        id: "quests",
        entry: {
          kind: "yaml",
          path: "data/quests.yaml",
          schema: "contract:quests@1",
          to: "contract:quests@1",
          key: "id",
        },
      },
    });
    // Hidden, lorebook and media sources each compose a different entry.
    const entryOf = (contract: string) =>
      surface.contracts.find((item) => item.contract === contract)?.source
        ?.entry;
    expect(entryOf("story.events@1")).toMatchObject({ visibility: "hidden" });
    expect(entryOf("world.rules@1")).toMatchObject({
      to: "contract:world.rules@1+lorebook",
    });
    expect(entryOf("character.portrait-assets@1")).toEqual({
      kind: "media",
      path: "media/portraits",
      to: "media",
      indexTo: "contract:character.portrait-assets@1",
      key: "filename",
    });
  });

  it("lists the pack catalogue a world can name, in the requested language", async () => {
    const catalogue = await loadPluginCatalogue([bundledPlugins]);
    const surface = await describeAuthoringSurface(catalogue, {
      locale: "zh-CN",
    });

    // Every pack of `packs/builtin.yaml`, in its order.
    expect(surface.packs.map((pack) => pack.id)).toEqual(
      BUILTIN_PLUGIN_PACKS.map((pack) => pack.id),
    );
    // The view a pack asks for is data of the pack.
    expect(
      surface.packs.find((pack) => pack.id === "dialogue-mode"),
    ).toMatchObject({ label: "对话模式", defaultViewMode: "stage" });
    expect(
      surface.packs.find((pack) => pack.id === "traditional-story"),
    ).not.toHaveProperty("defaultViewMode");
  });

  it("every bundled namespace that accepts world data explains how to author it", async () => {
    const catalogue = await loadPluginCatalogue([bundledPlugins]);
    const surface = await describeAuthoringSurface(catalogue);
    expect(
      surface.contracts
        .filter((item) => !item.hint || !item.source)
        .map((item) => `${item.pluginId}/${item.namespace}`),
    ).toEqual([]);
  });

  it("bundled examples match their schemas", async () => {
    const catalogue = await loadPluginCatalogue([bundledPlugins]);
    expect(await validateAuthoringExamples(catalogue)).toEqual([]);
  });

  it("reports an example that does not match the namespace schema", async () => {
    const pluginsDir = await mkdtemp(path.join(tmpdir(), "covel-authoring-"));
    await writeFiles(path.join(pluginsDir, "sample-notes"), {
      "package.json": JSON.stringify({
        name: "sample-notes",
        type: "module",
      }),
      "PLUGIN.md": `---
id: sample-notes
kind: plugin
description: Stores world notes.
contracts:
  sample.notes@1:
    schema: ./schemas/notes.schema.json
contributes:
  data:
    notes:
      schema: ./schemas/notes.schema.json
      version: 1
      accepts:
        - sample.notes@1
      authoring:
        title: World notes
        example: ./examples/notes.json
        source:
          kind: json
          path: data/notes.json
          key: id
---
`,
      "schemas/notes.schema.json": JSON.stringify({
        type: "object",
        required: ["id", "text"],
        properties: { id: { type: "string" }, text: { type: "string" } },
        additionalProperties: false,
      }),
      "examples/notes.json": JSON.stringify([
        { id: "first", text: "Valid." },
        { id: "second", text: 7 },
      ]),
    });

    const issues = await validateAuthoringExamples(
      await loadPluginCatalogue([pluginsDir]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      pluginId: "sample-notes",
      namespace: "notes",
    });
    expect(issues[0]!.message).toContain("record 1");
  });

  it("a world assembled from the described entries and examples validates", async () => {
    const catalogue = await loadPluginCatalogue([bundledPlugins]);
    const surface = await describeAuthoringSurface(catalogue);
    const authored = surface.contracts.filter(
      (item) => item.source && item.example !== undefined,
    );
    expect(authored.length).toBeGreaterThan(0);

    const worldDir = path.join(
      await mkdtemp(path.join(tmpdir(), "covel-described-world-")),
      "described-world",
    );
    // Each file at the path its plugin names is a source: no descriptor.
    // A directory convention (`data/rules/*.yaml`) takes any file name.
    await writeFiles(worldDir, {
      "world.yaml": `id: described-world
name: Described World
summary: Built from the describe output.
defaultLocale: en-US
`,
      "WORLD.md": "Lore.",
      ...Object.fromEntries(
        authored.map((item) => [
          item.source!.entry.path.replaceAll("*", "example"),
          item.source!.entry.kind === "json"
            ? JSON.stringify(item.example)
            : stringifyYaml(item.example),
        ]),
      ),
    });

    const { diagnostics } = await validateWorldPackage({
      worldDir,
      pluginsDirs: [bundledPlugins],
      strict: true,
    });
    expect(diagnostics.filter((item) => item.level === "error")).toEqual([]);
  });
});

describe("authoring skill examples", () => {
  // A skill example that no longer parses teaches agents to write invalid
  // worlds, so the dimension example is held to the production schema.
  it("the dimension example in the create-world skill is valid", async () => {
    const markdown = await readFile(
      path.join(
        repoRoot,
        ".claude/skills/create-world/references/dimensions.md",
      ),
      "utf-8",
    );
    const examples = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)]
      .map((match) => match[1]!)
      .filter((block) => block.startsWith("# data/dimensions.yaml"));
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const parsed = worldDimensionsSchema.safeParse(parseYaml(example));
      expect(parsed.error?.issues ?? []).toEqual([]);
    }
  });
});
