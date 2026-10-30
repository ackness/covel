// @vitest-environment node
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  KERNEL_SOURCES,
  conventionCollisions,
  conventionsOfPlugins,
  setWorldDataConventions,
  worldHasData,
} from "../../src/world-data/conventions.js";
import { loadWorldDataDescriptor } from "../../src/world-data/descriptor.js";
import { worldGenerationDataContracts } from "../../src/world-data/portable-contract-data.js";
import { prepareWorldDataImportForSession } from "../../src/world-data/session-import.js";
import {
  loadPluginCatalogue,
  validateWorldPackage,
} from "../../src/world-data/validate-world-package.js";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const PLUGINS = path.join(REPO, "plugins");

/** A plugin that names `data/quests.yaml`, the quest log's file, for its own contract. */
const RIVAL_PLUGIN: Record<string, string> = {
  "PLUGIN.md": `---
id: rival-log
kind: plugin
version: 0.1.0
description: Names the quest log's file for records of its own.
contributes:
  data:
    records:
      schema: ./schemas/records.schema.json
      version: 1
      accepts:
        - rival.records@1
      authoring:
        title: Rival records
        source:
          path: data/quests.yaml
          key: id
---

# Rival log
`,
  "package.json": JSON.stringify({
    name: "rival-log",
    version: "0.1.0",
    private: true,
    type: "module",
  }),
  "README.md": "# Rival log\n",
  "schemas/records.schema.json": JSON.stringify({ type: "array" }),
};

/**
 * A world package needs no descriptor for a file at a well-known path. The
 * paths are the kernel's and those the plugins name for their data; a
 * descriptor changes, turns off or adds sources.
 */
describe("world data conventions", () => {
  let roots: string[] = [];
  const world = async (files: Record<string, string>): Promise<string> => {
    // The validator looks for the package in the directory above it: give
    // the world a parent of its own, not the shared temporary directory.
    const home = await mkdtemp(path.join(tmpdir(), "covel-conventions-"));
    roots.push(home);
    const root = path.join(home, "small");
    for (const [file, content] of Object.entries({
      "world.yaml":
        "id: small\nname: Small\nsummary: A small world.\ndefaultLocale: en-US\n",
      "WORLD.md": "A small world.\n",
      ...files,
    })) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    return root;
  };

  beforeAll(async () => {
    setWorldDataConventions(
      conventionsOfPlugins(await loadPluginCatalogue([PLUGINS])),
    );
  });
  afterAll(() => setWorldDataConventions(KERNEL_SOURCES));
  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
    roots = [];
  });

  it("reads the bundled worlds by convention alone, every rule file included", async () => {
    for (const id of [
      "emberback",
      "haruka-academy",
      "lantern-barrow",
      "mistport",
    ]) {
      const worldRoot = path.join(REPO, "worlds", id);
      const { sources, diagnostics } = await loadWorldDataDescriptor({
        worldRoot,
        worldId: id,
      });
      expect(diagnostics, id).toEqual([]);
      const rules = (await readdir(path.join(worldRoot, "data/rules")))
        .filter((file) => !/\.[a-z]{2}-[A-Z]{2}\.yaml$/.test(file))
        .map((file) => `data/rules/${file}`);
      expect(rules.length, id).toBeGreaterThan(0);
      for (const file of rules)
        expect(
          sources.find((source) => source.descriptor.path === file)?.descriptor
            .to,
          `${id}: ${file}`,
        ).toBe("contract:world.rules@1+lorebook");
    }
  });

  it("reads every file of a directory convention in file-name order", async () => {
    const root = await world({
      "data/rules/b-later.yaml": "[]\n",
      "data/rules/a-first.yaml": "[]\n",
      // A translation belongs to its main file; it is no source.
      "data/rules/a-first.zh-CN.yaml": "[]\n",
      "data/rules/notes.json": "{}\n",
    });
    const { sources } = await loadWorldDataDescriptor({
      worldRoot: root,
      worldId: "small",
    });
    expect(
      sources.map((source) => [source.id, source.descriptor.path]),
    ).toEqual([
      ["rules-a-first", "data/rules/a-first.yaml"],
      ["rules-b-later", "data/rules/b-later.yaml"],
    ]);
  });

  it("reads a package without a descriptor by its files", async () => {
    const root = await world({
      "data/dimensions.yaml": "{}\n",
      "data/quests.yaml": "[]\n",
      "characters/characters.json": "[]\n",
      "media/portraits/keeper.png": "",
    });

    expect(await worldHasData(root, undefined)).toBe(true);
    const { sources, diagnostics } = await loadWorldDataDescriptor({
      worldRoot: root,
      worldId: "small",
    });
    expect(diagnostics).toEqual([]);
    // Dimensions first, then media, then records, the character records last.
    expect(sources.map((source) => [source.id, source.descriptor.to])).toEqual([
      ["dimensions", "world:metadata.dimensions"],
      ["assets", "media"],
      ["quests", "contract:quests@1"],
      ["characters", "characters"],
    ]);
    expect(sources[2]!.descriptor).toMatchObject({
      kind: "yaml",
      path: "data/quests.yaml",
      schema: "contract:quests@1",
      key: "id",
    });
  });

  it("has no world data when no conventional file exists", async () => {
    const root = await world({ "notes/ideas.yaml": "[]\n" });
    expect(await worldHasData(root, undefined)).toBe(false);
    expect(
      (await loadWorldDataDescriptor({ worldRoot: root, worldId: "small" }))
        .sources,
    ).toEqual([]);
  });

  it("adds the sources of a descriptor to the conventional ones", async () => {
    const root = await world({
      "world.yaml":
        "id: small\nname: Small\nsummary: A small world.\ndefaultLocale: en-US\nworldData: data/world.data.yaml\n",
      "data/world.data.yaml":
        "sources:\n  log:\n    kind: yaml\n    path: data/log.yaml\n    to: contract:quests@1\n    key: id\n",
      "data/log.yaml": "[]\n",
      // Conventional, and not listed: still read.
      "data/items.yaml": "[]\n",
    });
    const { sources } = await loadWorldDataDescriptor({
      worldRoot: root,
      worldId: "small",
      worldDataPath: "data/world.data.yaml",
    });
    expect(sources.map((source) => source.id)).toEqual(["items", "log"]);
    // `schema` is the contract of the destination when it is not written.
    expect(sources[1]!.descriptor.schema).toBe("contract:quests@1");
  });

  it("changes or turns off a conventional source by an entry with its path", async () => {
    const root = await world({
      "data/world.data.yaml": [
        "sources:",
        "  gear:",
        "    path: data/items.yaml",
        "    visibility: hidden",
        "  questLog:",
        "    path: data/quests.yaml",
        "    enabled: false",
        "  stray:",
        "    path: data/elsewhere.yaml",
        "    key: id",
        "",
      ].join("\n"),
      "data/items.yaml": "[]\n",
      "data/quests.yaml": "[]\n",
    });
    const { sources, diagnostics } = await loadWorldDataDescriptor({
      worldRoot: root,
      worldId: "small",
      worldDataPath: "data/world.data.yaml",
    });
    // The entry's fields win and its ID names the source; the rest stays.
    expect(sources.map((source) => source.id)).toEqual(["gear"]);
    expect(sources[0]!.descriptor).toMatchObject({
      kind: "yaml",
      path: "data/items.yaml",
      to: "contract:inventory.items@1",
      key: "id",
      visibility: "hidden",
    });
    // An entry for a path no convention reads must be a whole source.
    expect(diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        sourceId: "stray",
        message: expect.stringContaining("changes nothing"),
      }),
    ]);
  });

  it("warns about a data file that no convention names", async () => {
    const root = await world({
      "data/quests.yaml": "[]\n",
      "data/quests.zh-CN.yaml": "[]\n",
      "data/journal.yaml": "[]\n",
    });
    const { diagnostics } = await validateWorldPackage({
      worldDir: root,
      pluginsDirs: [PLUGINS],
    });
    expect(
      diagnostics
        .filter((item) => item.code === "data-file-unused")
        .map((item) => item.file),
    ).toEqual(["data/journal.yaml"]);
    expect(diagnostics.filter((item) => item.level === "error")).toEqual([]);
  });

  it("gives the world generator a contract's path only while it is a convention", async () => {
    const catalogue = await loadPluginCatalogue([PLUGINS]);
    const target = (await worldGenerationDataContracts(catalogue)).find(
      (item) => item.source,
    )!;
    expect(target.source).toBeDefined();

    // A second plugin that names the same file for a contract of its own.
    // A file the generator wrote there with no descriptor would be read for
    // neither contract. The receiver is found by its contract: the result
    // does not name a `kind: core` one.
    const owner = [...catalogue.getAll().values()].find((entry) =>
      Object.values(
        entry.packageManifest?.plugin?.contributes?.data ?? {},
      ).some((item) => item.accepts?.includes(target.contract)),
    )!;
    const plugin = owner.packageManifest!.plugin!;
    const [namespace, declaration] = Object.entries(
      plugin.contributes!.data!,
    ).find(([, item]) => item.accepts?.includes(target.contract))!;
    const rival = {
      ...owner,
      packageManifest: {
        ...owner.packageManifest!,
        plugin: {
          ...plugin,
          contributes: {
            data: {
              [namespace]: {
                ...declaration,
                accepts: ["rival.records@1"],
                authoring: { ...declaration.authoring!, generate: undefined },
              },
            },
          },
        },
      },
    } as typeof owner;
    const crowded = new Map([...catalogue.getAll(), ["rival", rival] as const]);
    const contracts = await worldGenerationDataContracts({
      get: (id) => crowded.get(id),
      getAll: () => crowded,
    });
    const crowdedTarget = contracts.find(
      (item) => item.contract === target.contract,
    );
    expect(crowdedTarget?.pluginId).toBe(target.pluginId);
    expect(crowdedTarget?.source).toBeUndefined();
  });

  it("includes schemas for existing revision records without enabling them for new generation", async () => {
    const catalogue = await loadPluginCatalogue([PLUGINS]);
    const generated = await worldGenerationDataContracts(catalogue);
    const current = {
      yaml: "id: small",
      lore: "A small world.",
      packageYaml:
        "contractData: [{contract: quests@1, key: delivery, value: {id: delivery}}]",
    };
    expect(generated.some((item) => item.contract === "quests@1")).toBe(false);
    const editable = await worldGenerationDataContracts(
      catalogue,
      undefined,
      current,
    );
    const quest = editable.find((item) => item.contract === "quests@1");
    expect(quest?.schema).toBeDefined();
    expect(quest?.hint).toBeTruthy();
    expect(quest?.validate({ id: "delivery" })).toBe(false);
    // Unrelated contracts that do not offer generation stay out.
    expect(editable.some((item) => item.contract === "inventory.items@1")).toBe(
      false,
    );
  });

  /** The bundled plugins and the rival, as one catalogue. */
  const crowdedCatalogue = async (status?: "error") => {
    const catalogue = await loadPluginCatalogue([PLUGINS]);
    const owner = catalogue.get("core-quest")!;
    const rival = {
      ...owner,
      id: "rival-log",
      ...(status ? { status } : {}),
      packageManifest: {
        ...owner.packageManifest!,
        plugin: {
          ...owner.packageManifest!.plugin!,
          id: "rival-log",
          contributes: {
            data: {
              records: {
                schema: "./schemas/records.schema.json",
                version: 1,
                accepts: ["rival.records@1"],
                authoring: {
                  title: "Rival records",
                  source: { path: "data/quests.yaml" },
                },
              },
            },
          },
        },
      },
    } as typeof owner;
    const entries = new Map([
      ...catalogue.getAll(),
      ["rival-log", rival] as const,
    ]);
    return {
      get: (id: string) => entries.get(id),
      getAll: () => entries,
    };
  };
  const paths = (sources: ReturnType<typeof conventionsOfPlugins>) =>
    sources.map((source) => source.entry.path);

  it("lets only the session's loaded plugins decide a conventional path", async () => {
    const crowded = await crowdedCatalogue();
    // Both plugins in play: the path is a convention for neither.
    expect(paths(conventionsOfPlugins(crowded))).not.toContain(
      "data/quests.yaml",
    );
    expect(conventionCollisions(crowded)).toEqual([
      {
        path: "data/quests.yaml",
        claimants: [
          { pluginId: "core-quest", label: "core-quest/quests (quests@1)" },
          {
            pluginId: "rival-log",
            label: "rival-log/records (rival.records@1)",
          },
        ],
      },
    ]);
    // A session without the rival reads the file for the quest log.
    const active = [...crowded.getAll().keys()].filter(
      (id) => id !== "rival-log",
    );
    expect(paths(conventionsOfPlugins(crowded, active))).toContain(
      "data/quests.yaml",
    );
    expect(conventionCollisions(crowded, active)).toEqual([]);
    // A plugin that failed to load names nothing.
    expect(
      paths(conventionsOfPlugins(await crowdedCatalogue("error"))),
    ).toContain("data/quests.yaml");
  });

  it("starts a session without a file its plugins both name, and says why", async () => {
    const root = await world({
      "data/quests.yaml":
        "- id: main\n  name: Find the keeper\n  description: The keeper is gone.\n  status: active\n",
    });
    const crowded = await crowdedCatalogue();
    const prepare = (activePlugins: readonly string[]) =>
      prepareWorldDataImportForSession({
        sessionId: "s1",
        worldId: "small",
        worldsDirs: [path.dirname(root)],
        now: new Date(0).toISOString(),
        locale: "en-US",
        preflight: {
          registry: crowded,
          activePlugins,
          executeProjectionHandlers: false,
        },
      });

    const both = await prepare(["core-quest", "rival-log"]);
    expect(both.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        code: "convention-collision",
        path: "data/quests.yaml",
      }),
    );
    expect(both.diagnostics.some((item) => item.level === "error")).toBe(false);

    const one = await prepare(["core-quest"]);
    expect(
      one.diagnostics.some((item) => item.code === "convention-collision"),
    ).toBe(false);
    expect(
      one.imported && one.plan.writes.map((write) => write.source.id),
    ).toContain("quests");
  });

  it("checks a package against the plugins a new session starts with", async () => {
    const quests =
      "- id: main\n  name: Find the keeper\n  description: The keeper is gone.\n  status: active\n";
    const codes = async (manifest: string, pluginsDirs = [PLUGINS]) => {
      const root = await world({
        "world.yaml": manifest,
        "data/quests.yaml": quests,
      });
      return (
        await validateWorldPackage({ worldDir: root, pluginsDirs })
      ).diagnostics
        .filter((item) =>
          [
            "unrequested-receiver",
            "convention-collision",
            "data-file-unused",
          ].includes(item.code),
        )
        .map((item) => [item.level, item.code, item.file]);
    };
    const manifest =
      "id: small\nname: Small\nsummary: A small world.\ndefaultLocale: en-US\n";

    // The quest log is not among the plugins a session starts with.
    expect(await codes(manifest)).toEqual([
      ["warning", "unrequested-receiver", "data/quests.yaml"],
    ]);
    const requested = `${manifest}pluginPolicy:\n  plus:\n    - core-quest\n`;
    expect(await codes(requested)).toEqual([]);

    // A scanned plugin names the same file.
    const rivalDir = await mkdtemp(path.join(tmpdir(), "covel-rival-"));
    roots.push(rivalDir);
    for (const [file, content] of Object.entries(RIVAL_PLUGIN)) {
      const full = path.join(rivalDir, "rival-log", file);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    // Only a player who turns the rival on loses the file.
    expect(await codes(requested, [rivalDir, PLUGINS])).toEqual([
      ["warning", "convention-collision", "data/quests.yaml"],
    ]);
    // A new session starts with both, and reads the file for neither.
    expect(
      await codes(`${requested}    - rival-log\n`, [rivalDir, PLUGINS]),
    ).toEqual([["error", "convention-collision", "data/quests.yaml"]]);
    // A descriptor that says which contract the file is for settles it.
    const settled = await world({
      "world.yaml": `${requested}    - rival-log\nworldData: data/world.data.yaml\n`,
      "data/world.data.yaml":
        "sources:\n  quests:\n    kind: yaml\n    path: data/quests.yaml\n    to: contract:quests@1\n    key: id\n",
      "data/quests.yaml": quests,
    });
    expect(
      (
        await validateWorldPackage({
          worldDir: settled,
          pluginsDirs: [rivalDir, PLUGINS],
        })
      ).diagnostics.filter((item) => item.code === "convention-collision"),
    ).toEqual([]);
  });
});
