// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  KERNEL_SOURCES,
  conventionsOfPlugins,
  setWorldDataConventions,
  worldHasData,
} from "../../src/world-data/conventions.js";
import { loadWorldDataDescriptor } from "../../src/world-data/descriptor.js";
import { worldGenerationDataContracts } from "../../src/world-data/portable-contract-data.js";
import {
  loadPluginCatalogue,
  validateWorldPackage,
} from "../../src/world-data/validate-world-package.js";
import type { WorldDataSourceDescriptor } from "@covel/shared";

const REPO = path.resolve(import.meta.dirname, "../../../..");
const PLUGINS = path.join(REPO, "plugins");

/**
 * A world package needs no descriptor for a file at a well-known path. The
 * paths are the kernel's and those the plugins name for their data, and what
 * they give is the descriptor entry an author would have written.
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
        'schemaVersion: "1.0"\nid: small\nname: Small\nsummary: A small world.\ndefaultLocale: en-US\n',
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

  it("gives the entry an author writes for the same file", async () => {
    // The bundled worlds write their descriptors out. Every source of theirs
    // that is at a conventional path must be what the convention gives.
    const conventions = new Map(
      conventionsOfPlugins(await loadPluginCatalogue([PLUGINS])).map(
        (source) => [source.entry.path, source.entry],
      ),
    );
    const fields = (entry: WorldDataSourceDescriptor) => ({
      kind: entry.kind,
      to: entry.to,
      key: entry.key,
      indexTo: entry.indexTo,
      schema: entry.schema,
      visibility: entry.visibility,
    });
    let compared = 0;
    for (const id of ["haruka-academy", "lantern-barrow", "mistport"]) {
      const { sources } = await loadWorldDataDescriptor({
        worldRoot: path.join(REPO, "worlds", id),
        worldId: id,
        worldDataPath: "data/world.data.yaml",
      });
      for (const source of sources) {
        const convention = conventions.get(source.descriptor.path);
        if (!convention) continue;
        expect(fields(source.descriptor), `${id}: ${source.id}`).toEqual(
          fields(convention),
        );
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(15);
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

  it("uses the descriptor alone when the package names one", async () => {
    const root = await world({
      "world.yaml":
        'schemaVersion: "1.0"\nid: small\nname: Small\nsummary: A small world.\ndefaultLocale: en-US\nworldData: data/world.data.yaml\n',
      "data/world.data.yaml":
        "schemaVersion: 1\nsources:\n  log:\n    kind: yaml\n    path: data/log.yaml\n    to: contract:quests@1\n    key: id\n",
      "data/log.yaml": "[]\n",
      // Conventional, and not listed: the descriptor decides.
      "data/items.yaml": "[]\n",
    });
    const { sources } = await loadWorldDataDescriptor({
      worldRoot: root,
      worldId: "small",
      worldDataPath: "data/world.data.yaml",
    });
    expect(sources.map((source) => source.id)).toEqual(["log"]);
    // `schema` is the contract of the destination when it is not written.
    expect(sources[0]!.descriptor.schema).toBe("contract:quests@1");
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
    // neither contract.
    const owner = catalogue.get(target.pluginId!)!;
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
    expect(
      contracts.find((item) => item.contract === target.contract),
    ).toMatchObject({ contract: target.contract, pluginId: target.pluginId });
    expect(
      contracts.find((item) => item.contract === target.contract)?.source,
    ).toBeUndefined();
  });
});
