// @vitest-environment node
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { loadWorldDataDescriptor } from "../../src/world-data/descriptor.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { worldSectionsOf } from "../../src/world-data/world-sections.js";

const manifest = `id: sample-world
name: Sample World
summary: A world with one data source.
defaultLocale: en-US
worldData: data/world.data.yaml
`;
const descriptor = `sources:
  lore:
    kind: yaml
    path: data/lorebook.yaml
    to: lorebook
    key: id
`;

async function makeWorld(withUnknownFields: boolean): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "covel-world-schema-"));
  const root = path.join(parent, "sample-world");
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(
    path.join(root, "world.yaml"),
    `${withUnknownFields ? 'schemaVersion: "1.0"\nextraMetadata: ignored\n' : ""}${manifest}`,
  );
  await writeFile(
    path.join(root, "WORLD.md"),
    "# Sample World\nA small harbor.",
  );
  await writeFile(
    path.join(root, "data/world.data.yaml"),
    `${withUnknownFields ? "schemaVersion: 1\nextraMetadata: ignored\n" : ""}${descriptor}`,
  );
  await writeFile(
    path.join(root, "data/lorebook.yaml"),
    "- id: harbor\n  content: The harbor is quiet.\n  strategy: constant\n",
  );
  return root;
}

describe("world package format fields", () => {
  it.each([false, true])(
    "loads data and reports only ignored root fields (old fields=%s)",
    async (withUnknownFields) => {
      const worldDir = await makeWorld(withUnknownFields);
      const world = await loadSingleWorld(worldDir);
      expect(world?.id).toBe("sample-world");
      if (!world) throw new Error("World failed to load");
      expect((await worldSectionsOf(world)).yaml).not.toContain(
        "schemaVersion:",
      );
      const sections = await worldSectionsOf(world, worldDir);
      expect(sections.yaml).not.toContain("schemaVersion:");
      expect(sections.yaml).not.toContain("extraMetadata:");
      expect(world?.metadata?.worldData).toMatchObject({
        sources: [{ id: "lore", target: "lorebook" }],
      });
      const { diagnostics } = await validateWorldPackage({
        worldDir,
        pluginsDirs: [],
      });
      expect(diagnostics.filter((issue) => issue.level === "error")).toEqual(
        [],
      );
      expect(
        diagnostics.map(({ file, pointer, level }) => ({
          file,
          pointer,
          level,
        })),
      ).toEqual(
        withUnknownFields
          ? [
              {
                file: "world.yaml",
                pointer: "schemaVersion",
                level: "warning",
              },
              {
                file: "world.yaml",
                pointer: "extraMetadata",
                level: "warning",
              },
              {
                file: "data/world.data.yaml",
                pointer: "schemaVersion",
                level: "warning",
              },
              {
                file: "data/world.data.yaml",
                pointer: "extraMetadata",
                level: "warning",
              },
            ]
          : [],
      );
    },
  );

  it("ignores removed root fields in an override while applying its patch", async () => {
    const worldRoot = await makeWorld(false);
    const covelHome = await mkdtemp(
      path.join(tmpdir(), "covel-world-overrides-"),
    );
    const overrideRoot = path.join(covelHome, "world-overrides/sample-world");
    await mkdir(overrideRoot, { recursive: true });
    await writeFile(
      path.join(overrideRoot, "world.data.override.yaml"),
      "schemaVersion: 1\nsources:\n  lore:\n    enabled: false\n",
    );
    const loaded = await loadWorldDataDescriptor({
      worldRoot,
      covelHome,
      worldId: "sample-world",
      worldDataPath: "data/world.data.yaml",
    });
    expect(loaded.sources).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        path: "world.data.override.yaml",
        pointer: "schemaVersion",
      }),
    ]);
  });
  it("still rejects an unknown source field", async () => {
    const worldRoot = await makeWorld(false);
    await writeFile(
      path.join(worldRoot, "data/world.data.yaml"),
      descriptor.replace(
        "    to: lorebook",
        "    to: lorebook\n    typo: ignored",
      ),
    );
    const loaded = await loadWorldDataDescriptor({
      worldRoot,
      worldId: "sample-world",
      worldDataPath: "data/world.data.yaml",
    });
    expect(loaded.sources).toEqual([]);
    expect(loaded.diagnostics).toEqual([
      expect.objectContaining({ level: "error", sourceId: "lore" }),
    ]);
  });
});
