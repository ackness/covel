import { describe, expect, it } from "vitest";
import {
  pluginCommandsSchema,
  pluginEntryPathSchema,
  runtimeManifestInputSchema,
  worldProjectionMapSchema,
} from "../src/schemas/plugin.js";
import { pluginManifestSchema } from "../src/schemas/plugin-manifest.js";
import { validatePluginManifest } from "../src/schemas/validate.js";

describe("plugin manifest dataSchemas", () => {
  it("accepts scoped slash commands and rejects malformed arguments", () => {
    const commands = pluginCommandsSchema.parse([
      {
        name: "inspect",
        aliases: ["i"],
        description: { en: "Inspect runtime state", zh: "检查运行时状态" },
        action: "inspect-state",
        context: ["session", "active-runtimes", "models"],
        arguments: [
          { name: "runtime", type: "string", required: true },
          { name: "details", type: "boolean" },
        ],
      },
    ]);

    expect(commands[0]).toMatchObject({
      name: "inspect",
      action: "inspect-state",
      context: ["session", "active-runtimes", "models"],
    });
    expect(() =>
      pluginCommandsSchema.parse([
        { name: "Bad/Command", description: "bad", action: "inspect" },
      ]),
    ).toThrow(/lowercase kebab-case/);
    expect(() =>
      pluginCommandsSchema.parse([
        {
          name: "inspect",
          description: "bad",
          action: "inspect",
          arguments: [{ name: "rest", variadic: true }, { name: "after" }],
        },
      ]),
    ).toThrow(/must be last/);
  });

  it("accepts single-shot agent tool completion", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "single-shot-tool-runtime",
      description: "Calls one tool and finishes",
      stage: "post-turn",
      completeAfterTools: ["persist-result"],
      llm: {
        reasoningEffort: "disabled",
        toolChoice: { name: "persist-result" },
      },
    });

    expect(manifest.completeAfterTools).toEqual(["persist-result"]);
    expect(manifest.llm).toEqual({
      reasoningEffort: "disabled",
      toolChoice: { name: "persist-result" },
    });
  });

  it("normalizes keyed declarations into plugin data schema declarations", () => {
    const manifest = runtimeManifestInputSchema.parse({
      name: "world-data-runtime",
      description: "World data runtime",
      stage: "narrative",
      dataSchemas: {
        relationships: {
          schemaVersion: 1,
          acceptsWorldData: true,
          schema: "./schemas/relationships.schema.json",
          description: "Relationship graph",
        },
      },
    });

    expect(manifest.dataSchemas).toEqual({
      relationships: {
        namespace: "relationships",
        schemaVersion: 1,
        acceptsWorldData: true,
        schema: "./schemas/relationships.schema.json",
        description: "Relationship graph",
      },
    });
  });

  it("rejects declarations whose namespace disagrees with the map key", () => {
    expect(() =>
      runtimeManifestInputSchema.parse({
        name: "world-data-runtime",
        description: "World data runtime",
        stage: "narrative",
        dataSchemas: {
          relationships: {
            namespace: "characters",
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "./schemas/relationships.schema.json",
          },
        },
      }),
    ).toThrow(/namespace must match dataSchemas key/);
  });

  it("rejects schema paths outside the plugin package", () => {
    expect(() =>
      runtimeManifestInputSchema.parse({
        name: "world-data-runtime",
        description: "World data runtime",
        stage: "narrative",
        dataSchemas: {
          relationships: {
            schemaVersion: 1,
            acceptsWorldData: true,
            schema: "../relationships.schema.json",
          },
        },
      }),
    ).toThrow(/plugin-relative \.json path/);
  });

  it("accepts a plugin-relative entry path and rejects traversal", () => {
    expect(pluginEntryPathSchema.parse("server/index.js")).toBe(
      "server/index.js",
    );
    expect(() => pluginEntryPathSchema.parse("../outside/entry.js")).toThrow(
      /plugin-relative/,
    );
  });

  it("accepts strict plugin-scoped world projection declarations", () => {
    const projections = worldProjectionMapSchema.parse({
      characters: {
        from: "plugin://character-blueprint/blueprints",
        handler: "server/project-characters.js",
        outputs: {
          characters: { namespace: "characters", key: "characterId" },
        },
      },
    });

    expect(projections.characters).toEqual({
      from: "plugin://character-blueprint/blueprints",
      handler: "server/project-characters.js",
      outputs: {
        characters: { namespace: "characters", key: "characterId" },
      },
    });
  });

  it("rejects unsafe or structurally invalid world projections", () => {
    expect(() =>
      worldProjectionMapSchema.parse({
        Characters: {
          from: "plugin://characters",
          handler: "server/project.js",
          outputs: {
            characters: { namespace: "characters", key: "characterId" },
          },
        },
      }),
    ).toThrow(/projection\/output id/);

    expect(() =>
      worldProjectionMapSchema.parse({
        characters: {
          from: "plugin://characters",
          handler: "../outside/project.js",
          outputs: {},
        },
      }),
    ).toThrow(/plugin-relative/);

    expect(() =>
      worldProjectionMapSchema.parse({
        characters: {
          from: " ",
          handler: "server/project.js",
          outputs: {
            characters: { namespace: "characters", key: "character.id" },
          },
        },
      }),
    ).toThrow();
  });

  it("accepts versioned package contracts and rejects legacy relation fields", () => {
    const root = {
      id: "probe",
      kind: "plugin",
      description: "Probe",
      tags: ["mode:story"],
      provides: ["story@1"],
      requires: ["world@1"],
      conflicts: ["other-story@1"],
    };
    expect(pluginManifestSchema.parse(root)).toEqual(root);
    for (const field of [
      "optional",
      "relations",
      "capabilities",
      "fallbackFor",
      "memoryBlocks",
      "summaryFocus",
      "postHistory",
      "authorsNote",
    ]) {
      expect(
        pluginManifestSchema.safeParse({ ...root, [field]: [] }).success,
      ).toBe(false);
    }
    expect(
      pluginManifestSchema.safeParse({ ...root, requires: [""] }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...root, provides: ["unversioned"] })
        .success,
    ).toBe(false);
  });

  it("reserves the framework ID and accepts package-level http permissions", () => {
    const root = { id: "probe", kind: "plugin", description: "Probe" };
    expect(
      pluginManifestSchema.safeParse({ ...root, id: "framework" }).success,
    ).toBe(false);
    const withHttp = {
      ...root,
      permissions: {
        http: [{ origin: "https://api.example.com", methods: ["POST"] }],
      },
    };
    expect(pluginManifestSchema.parse(withHttp)).toEqual(withHttp);
    expect(
      pluginManifestSchema.safeParse({
        ...root,
        permissions: { http: [{ origin: "http://api.example.com" }] },
      }).success,
    ).toBe(false);
  });

  it("accepts a world data source inside the world package and rejects one outside it", () => {
    const withSource = (sourcePath: string) => ({
      id: "probe",
      kind: "plugin",
      description: "Probe",
      contributes: {
        data: {
          records: {
            version: 1,
            schema: "./schemas/records.json",
            accepts: ["probe.records@1"],
            authoring: {
              title: "Records",
              source: { path: sourcePath },
            },
          },
        },
      },
    });
    // `.old`, `.bak` and `.min` belong to the file name; none is an edition.
    for (const inside of [
      "data/records.json",
      "media/scenes.registry.json",
      "characters/characters.old.json",
      "data/lorebook.bak.yaml",
      "media/scenes.min.json",
    ])
      expect(pluginManifestSchema.safeParse(withSource(inside)).success).toBe(
        true,
      );
    // The world generator writes a contract's records at this path.
    for (const outside of [
      "../escaped.json",
      "data/../../escaped.json",
      "/tmp/escaped.json",
      "C:\\escaped.json",
    ])
      expect(pluginManifestSchema.safeParse(withSource(outside)).success).toBe(
        false,
      );
    // A path the kernel or the package owns would take a convention away
    // from every world, whatever the case or the edition.
    for (const reserved of [
      "data/dimensions.yaml",
      "data/lorebook.yaml",
      "characters/characters.json",
      "Data/Dimensions.yaml",
      "./data/lorebook.yaml",
      "world.yaml",
      "world.zh-CN.yaml",
      "world.yue-HK.yaml",
      "WORLD.md",
      "WORLD.en.md",
      "data/lorebook.fr.yaml",
      "characters/characters.en-US.json",
      "data/world.data.yaml",
      "media/gallery",
      "media/gallery/extra.json",
    ]) {
      const result = pluginManifestSchema.safeParse(withSource(reserved));
      expect(result.success, reserved).toBe(false);
      expect(result.error?.issues[0]?.message, reserved).toContain(
        "must not name a file the kernel or the world package owns",
      );
    }
  });

  it("accepts references to world dimensions found at any depth", () => {
    const withReference = (reference: Record<string, unknown>) => ({
      id: "probe",
      kind: "plugin",
      description: "Probe",
      contributes: {
        data: {
          events: {
            version: 1,
            schema: "./schemas/events.json",
            accepts: ["probe.events@1"],
            authoring: { title: "Events", references: [reference] },
          },
        },
      },
    });
    const parses = (reference: Record<string, unknown>) =>
      pluginManifestSchema.safeParse(withReference(reference)).success;

    expect(
      parses({
        path: "when.**.dimension",
        to: "world-dimension",
        within: ["path"],
      }),
    ).toBe(true);
    expect(parses({ path: "**.dimension", to: "world-dimension" })).toBe(true);
    const dimension = { path: "when.**.dimension", to: "world-dimension" };
    expect(
      parses({ ...dimension, values: ["equals", "in[]", "choice.value"] }),
    ).toBe(true);
    expect(parses({ ...dimension, within: ["path"], values: ["equals"] })).toBe(
      true,
    );
    expect(
      parses({ ...dimension, within: ["path", "other"], values: ["equals"] }),
    ).toBe(false);
    expect(parses({ ...dimension, values: [] })).toBe(false);
    expect(parses({ ...dimension, values: ["bad..path"] })).toBe(false);
    expect(
      parses({ ...dimension, to: "character-attribute", values: ["equals"] }),
    ).toBe(false);

    // `**` must lead to a field, once at a time.
    expect(parses({ path: "when.**", to: "world-dimension" })).toBe(false);
    expect(
      parses({ path: "when.**.**.dimension", to: "world-dimension" }),
    ).toBe(false);
    // An attribute type means nothing for a dimension.
    expect(
      parses({
        path: "when.**.dimension",
        to: "world-dimension",
        type: "number",
      }),
    ).toBe(false);
  });
});

describe("kernel extension conflicts", () => {
  it.each([
    "prompt.segment@1",
    "ui.slot@1",
    "character.visual@1",
    "stage.cast@1",
  ])(
    "rejects %s only in conflicts with a stable field diagnostic",
    (contract) => {
      const root = {
        id: "probe",
        kind: "plugin",
        description: "Probe",
        requires: [contract],
      };
      expect(pluginManifestSchema.safeParse(root).success).toBe(true);
      const invalid = pluginManifestSchema.safeParse({
        ...root,
        conflicts: [contract],
      });
      expect(invalid.success).toBe(false);
      if (!invalid.success)
        expect(invalid.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["conflicts", 0],
            params: { code: "invalid-conflict" },
          }),
        );
    },
  );
});

describe("validatePluginManifest", () => {
  it("validates PLUGIN.md frontmatter, not a compiled runtime", () => {
    expect(
      validatePluginManifest({ id: "probe", kind: "plugin", description: "x" })
        .valid,
    ).toBe(true);
    expect(
      validatePluginManifest({ name: "probe", description: "x" }).valid,
    ).toBe(false);
  });
});

describe("fields the author need not write", () => {
  it("parses a package that writes only a description and one runtime stage", () => {
    const parsed = pluginManifestSchema.parse({
      description: "Adds a short observation after each turn.",
      runtime: { schedule: { stage: "post-turn" } },
    });
    // The loader fills the id in from the directory name.
    expect(parsed.id).toBeUndefined();
    expect(parsed.kind).toBe("plugin");
  });

  it("works out a data source's kind from its path", () => {
    const withPath = (sourcePath: string) =>
      pluginManifestSchema.safeParse({
        description: "Probe",
        contributes: {
          data: {
            notes: {
              schema: "./notes.json",
              accepts: ["probe.notes@1"],
              authoring: { title: "Notes", source: { path: sourcePath } },
            },
          },
        },
      });
    for (const sourcePath of [
      "data/notes.yaml",
      "data/notes.yml",
      "data/notes.json",
      "media/notes",
    ])
      expect(withPath(sourcePath).success, sourcePath).toBe(true);
    const text = withPath("data/notes.txt");
    expect(text.success).toBe(false);
    expect(text.error?.issues[0]?.path).toEqual([
      "contributes",
      "data",
      "notes",
      "authoring",
      "source",
      "path",
    ]);
  });
});

describe("plugin manifest datasets", () => {
  const withDatasets = (datasets: unknown) => ({
    id: "probe",
    kind: "plugin",
    description: "Probe",
    contributes: { datasets },
  });
  const accepted = (datasets: unknown) =>
    pluginManifestSchema.safeParse(withDatasets(datasets)).success;

  it("accepts a declaration with every field", () => {
    const parsed = pluginManifestSchema.parse(
      withDatasets({
        journal: {
          schema: "./schemas/journal.json",
          key: "id",
          ops: ["upsertItem", "delete"],
        },
        notes: { schema: "schemas/notes.json" },
      }),
    );
    expect(parsed.contributes?.datasets?.journal).toEqual({
      schema: "./schemas/journal.json",
      key: "id",
      ops: ["upsertItem", "delete"],
    });
    expect(parsed.contributes?.datasets?.notes).toEqual({
      schema: "schemas/notes.json",
    });
  });

  it("rejects a reserved or malformed dataset name", () => {
    expect(accepted({ _kernel: { schema: "s.json" } })).toBe(false);
    expect(accepted({ "bad name": { schema: "s.json" } })).toBe(false);
    expect(accepted({ ok_name: { schema: "s.json" } })).toBe(true);
  });

  it("rejects an unknown, duplicate or empty ops list", () => {
    expect(accepted({ a: { schema: "s.json", ops: ["explode"] } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", ops: ["set", "set"] } })).toBe(
      false,
    );
    expect(accepted({ a: { schema: "s.json", ops: [] } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", ops: ["set", "merge"] } })).toBe(
      true,
    );
  });

  it("rejects a schema path that leaves the package", () => {
    expect(accepted({ a: { schema: "../s.json" } })).toBe(false);
    expect(accepted({ a: { schema: "/etc/s.json" } })).toBe(false);
    expect(accepted({ a: { schema: "s.yaml" } })).toBe(false);
  });

  it("rejects a malformed key and extra fields", () => {
    expect(accepted({ a: { schema: "s.json", key: "1id" } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", key: "a.b" } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", extra: true } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", tools: ["read"] } })).toBe(false);
    expect(accepted({ a: { schema: "s.json", tools: ["get"] } })).toBe(true);
    expect(accepted({ a: {} })).toBe(false);
  });
});

describe("compiled runtime manifest datasets", () => {
  const compiled = (datasets: unknown) =>
    runtimeManifestInputSchema.safeParse({
      name: "dataset-runtime",
      description: "Dataset runtime",
      stage: "narrative",
      datasets,
    }).success;

  it("requires resolved ops and tools and a matching namespace", () => {
    const ok = {
      journal: {
        namespace: "journal",
        schema: "./j.json",
        ops: ["set"],
        tools: ["get", "list", "upsert"],
      },
    };
    expect(compiled(ok)).toBe(true);
    expect(compiled({ journal: { ...ok.journal, ops: undefined } })).toBe(
      false,
    );
    expect(compiled({ journal: { ...ok.journal, tools: undefined } })).toBe(
      false,
    );
    expect(compiled({ other: ok.journal })).toBe(false);
  });
});
