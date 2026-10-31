import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  inventoryWorldData,
  worldDataRequirementNotices,
  worldDataRevision,
} from "../../src/world-data/requirements.js";
import {
  conventionsOfPlugins,
  conventionCollisions,
} from "../../src/world-data/conventions.js";
import { datasetWriteFixture } from "../helpers/dataset-write-fixture.js";

describe("effective world data requirements", () => {
  it("requires an existing empty source, but neither an absent nor a disabled source", async () => {
    const f = await datasetWriteFixture();
    const inventory = () =>
      inventoryWorldData({ ...f.options, registry: f.registry });
    try {
      await f.records([]);
      const present = await inventory();
      expect(present.requiredDataContracts).toEqual(["probe.notes@1"]);
      expect(JSON.stringify(present.sources)).not.toContain("before");
      await rm(path.join(f.worldRoot, "data/notes.json"));
      expect((await inventory()).requiredDataContracts).toEqual([]);
      await f.records([]);
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nworldData: descriptor.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "descriptor.yaml"),
        "sources:\n  disabled:\n    path: data/notes.json\n    enabled: false\n",
      );
      const disabled = await inventory();
      expect(disabled.requiredDataContracts).toEqual([]);
      expect(
        disabled.diagnostics.filter((d) => d.code === "unclaimed-data-source"),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
  it("uses explicit targets and media indexes without treating validator schemas as receivers", async () => {
    const f = await datasetWriteFixture();
    try {
      await mkdir(path.join(f.worldRoot, "media"));
      await writeFile(
        path.join(f.worldRoot, "media/picture.webp"),
        "No image decoding is needed",
      );
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nworldData: descriptor.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "descriptor.yaml"),
        JSON.stringify({
          sources: {
            explicit: {
              kind: "json",
              path: "data/notes.json",
              to: "contract:unknown@1+lorebook",
              schema: "contract:validator@1",
              key: "id",
            },
            images: {
              kind: "media",
              path: "media",
              to: "media",
              indexTo: "contract:images@1",
            },
          },
        }),
      );
      const result = await inventoryWorldData({
        ...f.options,
        registry: f.registry,
      });
      expect(result.requiredDataContracts).toEqual(["images@1", "unknown@1"]);
      expect(result.requiredDataContracts).not.toContain("validator@1");
      expect(result.sources.find((s) => s.sourceId === "explicit")?.path).toBe(
        "data/notes.json",
      );
    } finally {
      await f.cleanup();
    }
  });
  it("collapses equivalent claims but refuses incompatible visibility and contracts", async () => {
    const f = await datasetWriteFixture();
    try {
      const original = f.registry.get("probe")!;
      f.registry.register({
        ...original,
        id: "other",
        packageManifest: {
          ...original.packageManifest!,
          plugin: { ...original.packageManifest!.plugin, id: "other" },
        },
      });
      expect(conventionCollisions(f.registry)).toEqual([]);
      expect(
        conventionsOfPlugins(f.registry).filter(
          (s) => s.entry.path === "data/notes.json",
        ),
      ).toHaveLength(1);
      const base = await inventoryWorldData({
        ...f.options,
        registry: f.registry,
      });
      const other = f.registry.get("other")!;
      const data = other.packageManifest!.plugin.contributes!.data!.notes!;
      f.registry.register({
        ...other,
        packageManifest: {
          ...other.packageManifest!,
          plugin: {
            ...other.packageManifest!.plugin,
            contributes: {
              data: {
                notes: {
                  ...data,
                  authoring: {
                    ...data.authoring!,
                    source: {
                      ...data.authoring!.source!,
                      visibility: "hidden",
                    },
                  },
                },
              },
            },
          },
        },
      });
      expect(conventionCollisions(f.registry)).toHaveLength(1);
      expect(
        (await inventoryWorldData({ ...f.options, registry: f.registry }))
          .requiredDataContracts,
      ).toEqual([]);
      f.registry.register({ ...f.registry.get("other")!, status: "error" });
      expect(
        (await inventoryWorldData({ ...f.options, registry: f.registry }))
          .sources,
      ).not.toEqual(base.sources);
      expect(
        (await inventoryWorldData({ ...f.options, registry: f.registry }))
          .diagnostics,
      ).toContainEqual(
        expect.objectContaining({ code: "convention-collision" }),
      );
    } finally {
      await f.cleanup();
    }
  });
  it("warns honestly about unknown structured content, ignores known overlays and schemas, and never follows links", async () => {
    const f = await datasetWriteFixture();
    try {
      await writeFile(path.join(f.worldRoot, "data/notes.en-US.json"), "[]");
      await writeFile(path.join(f.worldRoot, "data/example.schema.json"), "{}");
      await writeFile(
        path.join(f.worldRoot, "data/unknown.yaml"),
        "SECRET_RECORD: true",
      );
      await symlink(f.pluginRoot, path.join(f.worldRoot, "data/linked"));
      const inventory = await inventoryWorldData({
        ...f.options,
        registry: f.registry,
      });
      expect(
        inventory.diagnostics
          .filter((d) => d.code === "unclaimed-data-source")
          .map((d) => d.path),
      ).toEqual(["data/unknown.yaml"]);
      expect(JSON.stringify(inventory.sources)).not.toContain("SECRET_RECORD");
    } finally {
      await f.cleanup();
    }
  });
  it("discovers portable records and character fields without exposing their values in facts or hidden notices", async () => {
    const f = await datasetWriteFixture();
    try {
      const entry = f.registry.get("probe")!;
      const data = entry.packageManifest!.plugin.contributes!.data!.notes!;
      f.registry.register({
        ...entry,
        packageManifest: {
          ...entry.packageManifest!,
          plugin: {
            ...entry.packageManifest!.plugin,
            contributes: {
              data: {
                notes: {
                  ...data,
                  authoring: { ...data.authoring!, characterField: "notes" },
                },
              },
            },
          },
        },
      });
      const inventory = await inventoryWorldData({
        worldId: "portable",
        registry: f.registry,
        world: {
          metadata: {
            embeddedCharacters: [
              { id: "hero", notes: { text: "SECRET_VALUE" } },
            ],
            contractData: [
              {
                contract: "other@1",
                key: "note",
                value: { id: "note", text: "SECRET_VALUE" },
              },
            ],
            dimensions: { clock: {} },
          },
        },
      });
      expect(inventory.requiredDataContracts).toEqual([
        "other@1",
        "probe.notes@1",
      ]);
      expect(inventory.requiredContracts).toEqual(["world.dimensions@1"]);
      expect(JSON.stringify(inventory.sources)).not.toContain("SECRET_VALUE");
      expect(
        JSON.stringify(
          worldDataRequirementNotices(
            {
              ...inventory,
              sources: [
                {
                  sourceId: "SECRET_SOURCE",
                  path: "SECRET_FILE",
                  hidden: true,
                  contracts: ["other@1"],
                },
              ],
            },
            [{ contract: "other@1", code: "missing-provider" }],
          ),
        ),
      ).not.toContain("SECRET");
    } finally {
      await f.cleanup();
    }
  });
  it("expands actual wildcard files in stable order and honors effective overrides", async () => {
    const f = await datasetWriteFixture();
    try {
      const entry = f.registry.get("probe")!;
      const data = entry.packageManifest!.plugin.contributes!.data!.notes!;
      f.registry.register({
        ...entry,
        packageManifest: {
          ...entry.packageManifest!,
          plugin: {
            ...entry.packageManifest!.plugin,
            contributes: {
              data: {
                notes: {
                  ...data,
                  authoring: {
                    ...data.authoring!,
                    source: { path: "data/rules/*.yaml" },
                  },
                },
              },
            },
          },
        },
      });
      const inventory = () =>
        inventoryWorldData({
          ...f.options,
          registry: f.registry,
          covelHome: f.root,
          locale: "en-US",
        });
      expect((await inventory()).requiredDataContracts).toEqual([]);
      await mkdir(path.join(f.worldRoot, "data/rules"));
      for (const name of ["two", "one", "one.en-US"])
        await writeFile(
          path.join(f.worldRoot, `data/rules/${name}.yaml`),
          "[]",
        );
      const files = (await inventory()).sources.filter(
        (s) => s.contracts.length,
      );
      expect(files.map((s) => s.sourceId)).toEqual(["notes-one", "notes-two"]);
      const override = path.join(f.root, "world-overrides", f.options.worldId);
      await mkdir(override, { recursive: true });
      await writeFile(
        path.join(override, "world.data.override.yaml"),
        "sources:\n  notes-one:\n    enabled: false\n  notes-two:\n    to: contract:override@1+lorebook\n",
      );
      const effective = await inventory();
      expect(effective.requiredDataContracts).toEqual(["override@1"]);
      expect(
        effective.sources
          .filter((s) => s.contracts.length)
          .map((s) => s.sourceId),
      ).toEqual(["notes-two"]);
      expect(
        effective.diagnostics.filter((d) => d.path === "data/rules/one.yaml"),
      ).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });
});

it("finds a package by its directory identity when its manifest omits id", async () => {
  const f = await datasetWriteFixture();
  try {
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "name: Notes\nsummary: Notes\ndefaultLocale: en-US\n",
    );
    const inventory = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
    });
    expect(inventory.worldRoot).toBe(f.worldRoot);
    expect(inventory.requiredDataContracts).toEqual(["probe.notes@1"]);
  } finally {
    await f.cleanup();
  }
});

it("keeps convention collisions independent of approvals and explicit descriptor disambiguation", async () => {
  const f = await datasetWriteFixture();
  try {
    const original = f.registry.get("probe")!;
    const data = original.packageManifest!.plugin.contributes!.data!.notes!;
    f.registry.register({
      ...original,
      id: "other",
      source: "community",
      packageManifest: {
        ...original.packageManifest!,
        plugin: {
          ...original.packageManifest!.plugin,
          id: "other",
          contributes: {
            data: { notes: { ...data, accepts: ["other.notes@1"] } },
          },
        },
      },
    });
    const ambiguous = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
    });
    expect(ambiguous.requiredDataContracts).toEqual([]);
    expect(ambiguous.diagnostics).toContainEqual(
      expect.objectContaining({ code: "convention-collision" }),
    );
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  chosen:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1\n",
    );
    const explicit = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
    });
    expect(explicit.requiredDataContracts).toEqual(["probe.notes@1"]);
    expect(
      explicit.diagnostics.filter(
        (item) => item.code === "convention-collision",
      ),
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

it("does not inventory media through links, and includes override changes in the captured revision", async () => {
  const f = await datasetWriteFixture();
  try {
    await mkdir(path.join(f.worldRoot, "media"));
    await symlink(
      path.join(f.worldRoot, "data"),
      path.join(f.worldRoot, "media/linked"),
    );
    const overrideRoot = path.join(
      f.root,
      "world-overrides",
      f.options.worldId,
    );
    const initial = await worldDataRevision(f.worldRoot, overrideRoot);
    await mkdir(overrideRoot, { recursive: true });
    await writeFile(
      path.join(overrideRoot, "world.data.override.yaml"),
      "sources: {}\n",
    );
    expect(await worldDataRevision(f.worldRoot, overrideRoot)).not.toBe(
      initial,
    );
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  media:\n    kind: media\n    path: media/linked\n    to: media\n    indexTo: contract:images@1\n",
    );
    const inventory = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
    });
    expect(inventory.requiredDataContracts).not.toContain("images@1");
  } finally {
    await f.cleanup();
  }
});

it("requires only media directories with actual assets and bounds unknown-content traversal", async () => {
  const f = await datasetWriteFixture();
  try {
    await mkdir(path.join(f.worldRoot, "media"));
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  media:\n    kind: media\n    path: media\n    to: media\n    indexTo: contract:images@1\n",
    );
    const inventory = () =>
      inventoryWorldData({ ...f.options, registry: f.registry });
    expect((await inventory()).requiredDataContracts).toEqual([
      "probe.notes@1",
    ]);
    for (const name of ["first.webp", "second.webp"])
      await writeFile(path.join(f.worldRoot, "media", name), "not decoded");
    expect((await inventory()).requiredDataContracts).toEqual([
      "images@1",
      "probe.notes@1",
    ]);
    const deep = path.join(
      f.worldRoot,
      "data",
      ...Array.from({ length: 14 }, () => "nested"),
    );
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(deep, "unclaimed.json"), "[]");
    const { unclaimedStructuredData } =
      await import("../../src/world-data/requirements.js");
    expect(
      (
        await unclaimedStructuredData(f.worldRoot, new Set(["data/notes.json"]))
      ).map((item) => item.path),
    ).not.toContain(
      path.relative(f.worldRoot, path.join(deep, "unclaimed.json")),
    );
  } finally {
    await f.cleanup();
  }
});

it("treats equivalent path spellings as one file when checking hidden/public disagreement", async () => {
  const f = await datasetWriteFixture();
  try {
    const original = f.registry.get("probe")!;
    const data = original.packageManifest!.plugin.contributes!.data!.notes!;
    f.registry.register({
      ...original,
      id: "other",
      packageManifest: {
        ...original.packageManifest!,
        plugin: {
          ...original.packageManifest!.plugin,
          id: "other",
          contributes: {
            data: {
              notes: {
                ...data,
                authoring: {
                  ...data.authoring!,
                  source: {
                    ...data.authoring!.source!,
                    path: "./data/notes.json",
                    visibility: "hidden",
                  },
                },
              },
            },
          },
        },
      },
    });
    const inventory = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
    });
    expect(inventory.requiredDataContracts).toEqual([]);
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "convention-collision",
        path: "data/notes.json",
      }),
    );
  } finally {
    await f.cleanup();
  }
});

it("uses the reader's locale fallback for explicit sources and keeps source identity", async () => {
  const f = await datasetWriteFixture();
  try {
    await rm(path.join(f.worldRoot, "data/notes.json"));
    await writeFile(path.join(f.worldRoot, "data/notes.en-US.json"), "[]");
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1\n",
    );
    const inventory = await inventoryWorldData({
      ...f.options,
      registry: f.registry,
      locale: "en-US",
    });
    expect(inventory.requiredDataContracts).toEqual(["probe.notes@1"]);
    expect(inventory.sources).toContainEqual(
      expect.objectContaining({ sourceId: "notes", path: "data/notes.json" }),
    );
    expect(
      inventory.diagnostics.filter(
        (item) => item.code === "unclaimed-data-source",
      ),
    ).toEqual([]);
    expect(
      (
        await inventoryWorldData({
          ...f.options,
          registry: f.registry,
          locale: "fr-FR",
        })
      ).requiredDataContracts,
    ).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
