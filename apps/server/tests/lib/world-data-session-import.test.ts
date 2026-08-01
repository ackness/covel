import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginManifest,
} from "@covel/plugin-loader";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type DataStore,
} from "@covel/store";
import {
  WorldDataSyncConflictError,
  importWorldDataForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";

const NOW = "2026-01-01T00:00:00.000Z";

async function makeWorld(options: {
  readonly id?: string;
  readonly descriptor: string;
  readonly files: Readonly<Record<string, string>>;
}): Promise<{ worldsDir: string; worldRoot: string; worldId: string }> {
  const worldsDir = await mkdtemp(path.join(tmpdir(), "covel-import-worlds-"));
  const worldId = options.id ?? "demo-world";
  const worldRoot = path.join(worldsDir, worldId);
  await mkdir(path.join(worldRoot, "data"), { recursive: true });
  await writeFile(
    path.join(worldRoot, "world.yaml"),
    `schemaVersion: "1"
id: ${worldId}
name: Demo
summary: Demo world
defaultLocale: zh-CN
worldData: data/world.data.yaml
`,
  );
  await writeFile(
    path.join(worldRoot, "data/world.data.yaml"),
    options.descriptor,
  );
  for (const [relativePath, content] of Object.entries(options.files)) {
    await mkdir(path.dirname(path.join(worldRoot, relativePath)), {
      recursive: true,
    });
    await writeFile(path.join(worldRoot, relativePath), content);
  }
  return { worldsDir, worldRoot, worldId };
}

async function makeStore(activePlugins: readonly string[]): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: "sess-1",
    worldId: "demo-world",
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return store;
}

async function addSession(
  store: DataStore,
  id: string,
  activePlugins: readonly string[],
  worldId = "demo-world",
): Promise<void> {
  await store.createSession({
    id,
    worldId,
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function registry(entries: Record<string, readonly string[]>) {
  return {
    get(pluginId: string) {
      const namespaces = entries[pluginId];
      if (!namespaces) return undefined;
      return {
        id: pluginId,
        dataSchemas: Object.fromEntries(
          namespaces.map((namespace) => [
            namespace,
            {
              namespace,
              schemaVersion: 1,
              acceptsWorldData: true,
            },
          ]),
        ),
      } as any;
    },
  };
}

function registryWithSchema(entries: {
  readonly [pluginId: string]: {
    readonly rootPath: string;
    readonly namespaces: readonly string[];
  };
}) {
  return {
    get(pluginId: string) {
      const entry = entries[pluginId];
      if (!entry) return undefined;
      return {
        id: pluginId,
        rootPath: entry.rootPath,
        dataSchemas: Object.fromEntries(
          entry.namespaces.map((namespace) => [
            namespace,
            {
              namespace,
              schemaVersion: 1,
              acceptsWorldData: true,
              schema: `./schemas/${namespace}.schema.json`,
            },
          ]),
        ),
      } as any;
    },
  };
}

async function builtinPluginRegistry() {
  const pluginsRoot = path.resolve(import.meta.dirname, "../../../../plugins");
  const discoveries = await discoverPlugins(pluginsRoot);
  const registry = createPluginRegistry();

  for (const discovery of discoveries) {
    const manifests = await loadPluginManifest(discovery);
    registry.register({
      id: discovery.id,
      summary: {
        id: discovery.id,
        name: discovery.id,
        description: "",
        pluginType: "plugin",
        runtimeCount: manifests.length,
      },
      rootPath: discovery.rootPath,
      manifest: manifests[0],
      manifests,
      loadedRuntimes: new Map(),
      status: "registered",
    });
  }

  return registry;
}

describe("world data session importer", () => {
  it("compiles bundled plugin dataSchemas with Ajv", async () => {
    const pluginsRoot = path.resolve(
      import.meta.dirname,
      "../../../../plugins",
    );
    const discoveries = await discoverPlugins(pluginsRoot);
    const ajv = new Ajv2020({ strict: false });
    const compiled: string[] = [];
    const compiledSchemaPaths = new Set<string>();

    for (const discovery of discoveries) {
      const manifests = await loadPluginManifest(discovery);
      for (const parsed of manifests) {
        for (const [namespace, decl] of Object.entries(
          parsed.manifest.dataSchemas ?? {},
        )) {
          const schemaPath = path.resolve(discovery.rootPath, decl.schema);
          const relative = path.relative(discovery.rootPath, schemaPath);
          expect(relative.startsWith("..")).toBe(false);
          expect(path.isAbsolute(relative)).toBe(false);
          if (!compiledSchemaPaths.has(schemaPath)) {
            const raw = JSON.parse(await readFile(schemaPath, "utf-8"));
            expect(() => ajv.compile(raw)).not.toThrow();
            compiledSchemaPaths.add(schemaPath);
          }
          compiled.push(`${discovery.id}/${namespace}`);
        }
      }
    }

    expect(compiled.sort()).toEqual([
      "affinity/affinity",
      "char-creator/characters",
      "char-creator/characters",
      "character-blueprint/blueprints",
      "character-blueprint/characters",
      "character-presence/assets",
      "character-presence/presence",
      "core-quest/quests",
      "inventory/items",
      "living-world-rules/rules",
      "scene-stage/assets",
      "scene-stage/scenes",
    ]);
  });

  it("imports generic plugin-data records from JSON arrays", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([
          { id: "rain", content: "Rain matters." },
          { id: "gate", content: "The gate is locked." },
        ]),
      },
    });
    const store = await makeStore(["world-notes"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(2);
    expect(
      (await store.listPluginData("sess-1", "world-notes", "facts")).map(
        (row) => row.key,
      ),
    ).toEqual(["rain", "gate"]);
    expect(await store.listWorldDataImportLedger("sess-1")).toHaveLength(2);
  });

  it("imports the locale variant <name>.<lang>.<ext> when the session locale matches", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([
          { id: "gate", content: "闸门锁着。" },
        ]),
        "data/facts.en.json": JSON.stringify([
          { id: "gate", content: "The gate is locked." },
        ]),
      },
    });
    const store = await makeStore(["world-notes"]);

    await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      locale: "en-US",
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    const rows = await store.listPluginData("sess-1", "world-notes", "facts");
    expect((rows[0]?.value as { content: string }).content).toBe(
      "The gate is locked.",
    );
  });

  it("falls back to the declared source when no locale variant exists", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
      // Only the zh default exists — an en-US session must fall back to it,
      // not error.
      files: {
        "data/facts.json": JSON.stringify([
          { id: "gate", content: "闸门锁着。" },
        ]),
      },
    });
    const store = await makeStore(["world-notes"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      locale: "en-US",
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(1);
    const rows = await store.listPluginData("sess-1", "world-notes", "facts");
    expect((rows[0]?.value as { content: string }).content).toBe("闸门锁着。");
  });

  it("a malicious locale cannot escape the descriptor root (path traversal)", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([{ id: "gate", content: "safe" }]),
      },
    });
    const store = await makeStore(["world-notes"]);

    // A locale crafted to try to walk out of the world root via the
    // `<name>.<lang>.<ext>` variant. `lang` = locale.split("-")[0], and the
    // resolved variant is contained-checked, so this must safely fall back to
    // the declared source, not read outside the root or error.
    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      locale: "../../../../etc/passwd",
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(1);
    const rows = await store.listPluginData("sess-1", "world-notes", "facts");
    expect((rows[0]?.value as { content: string }).content).toBe("safe");
  });

  it("rejects missing plugin schemas during preflight", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: plugin:missing-plugin/facts
    key: id
`,
      files: { "data/fact.json": JSON.stringify({ id: "one" }) },
    });
    const store = await makeStore(["missing-plugin"]);

    await expect(
      importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["missing-plugin"],
          registry: registry({}),
        },
      }),
    ).rejects.toThrow(/not registered/);
  });

  it("skips sources targeting plugins outside final activePlugins (warning, not a session-blocking error)", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: plugin:world-notes/facts
    key: id
`,
      files: { "data/fact.json": JSON.stringify({ id: "one" }) },
    });
    const store = await makeStore([]);

    // The player deselected world-notes at session creation — the source has
    // no consumer, so it must be skipped, never fail the whole import.
    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: [],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(0);
    expect(
      result.diagnostics.some(
        (d) => d.level === "warning" && /not active/.test(d.message),
      ),
    ).toBe(true);
    expect(result.diagnostics.some((d) => d.level === "error")).toBe(false);
  });

  it("rejects values that fail a plugin data schema", async () => {
    const pluginRoot = await mkdtemp(
      path.join(tmpdir(), "covel-schema-plugin-"),
    );
    await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "schemas/facts.schema.json"),
      JSON.stringify({
        type: "object",
        required: ["id", "content"],
        properties: {
          id: { type: "string" },
          content: { type: "string" },
        },
        additionalProperties: true,
      }),
    );
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: plugin:world-notes/facts
    key: id
`,
      files: { "data/fact.json": JSON.stringify({ id: "one" }) },
    });
    const store = await makeStore(["world-notes"]);

    await expect(
      importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["world-notes"],
          registry: registryWithSchema({
            "world-notes": { rootPath: pluginRoot, namespaces: ["facts"] },
          }),
        },
      }),
    ).rejects.toThrow(/failed schema validation/);
    expect(
      await store.listPluginData("sess-1", "world-notes", "facts"),
    ).toEqual([]);
  });

  it("rejects plugin schema symlink escapes", async () => {
    const pluginRoot = await mkdtemp(
      path.join(tmpdir(), "covel-schema-plugin-"),
    );
    const outside = await mkdtemp(path.join(tmpdir(), "covel-schema-outside-"));
    await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
    await writeFile(
      path.join(outside, "facts.schema.json"),
      JSON.stringify({
        type: "object",
        required: ["id", "content"],
        properties: {
          id: { type: "string" },
          content: { type: "string" },
        },
      }),
    );
    await symlink(
      path.join(outside, "facts.schema.json"),
      path.join(pluginRoot, "schemas/facts.schema.json"),
    );
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: plugin:world-notes/facts
    key: id
`,
      files: { "data/fact.json": JSON.stringify({ id: "one" }) },
    });
    const store = await makeStore(["world-notes"]);

    await expect(
      importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["world-notes"],
          registry: registryWithSchema({
            "world-notes": { rootPath: pluginRoot, namespaces: ["facts"] },
          }),
        },
      }),
    ).rejects.toThrow(/escapes plugin root/);
    expect(
      await store.listPluginData("sess-1", "world-notes", "facts"),
    ).toEqual([]);
  });

  it("rejects mismatched plugin schema and plugin target namespaces", async () => {
    const pluginRoot = await mkdtemp(
      path.join(tmpdir(), "covel-schema-plugin-"),
    );
    await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "schemas/ns.schema.json"),
      JSON.stringify({ type: "object" }),
    );
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    schema: plugin://a/ns
    to: plugin:b/ns
    key: id
`,
      files: { "data/fact.json": JSON.stringify({ id: "one" }) },
    });
    const store = await makeStore(["b"]);

    await expect(
      importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["b"],
          registry: registryWithSchema({
            a: { rootPath: pluginRoot, namespaces: ["ns"] },
            b: { rootPath: pluginRoot, namespaces: ["ns"] },
          }),
        },
      }),
    ).rejects.toThrow(/incompatible with target/);
  });

  it("validates and rejects source values with world-local schema paths", async () => {
    const descriptor = `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    schema: schemas/fact.schema.json
    to: plugin:world-notes/facts
    key: id
`;
    const schema = JSON.stringify({
      type: "object",
      required: ["id", "content"],
      properties: {
        id: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: true,
    });
    const valid = await makeWorld({
      id: "valid-world",
      descriptor,
      files: {
        "data/facts.json": JSON.stringify([
          { id: "rain", content: "Rain matters." },
        ]),
        "schemas/fact.schema.json": schema,
      },
    });
    const validStore = await makeStore(["world-notes"]);

    const result = await importWorldDataForSession({
      store: validStore,
      sessionId: "sess-1",
      worldId: valid.worldId,
      worldsDirs: [valid.worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(1);

    const invalid = await makeWorld({
      id: "invalid-world",
      descriptor,
      files: {
        "data/facts.json": JSON.stringify([{ id: "rain" }]),
        "schemas/fact.schema.json": schema,
      },
    });
    const invalidStore = await makeStore(["world-notes"]);

    await expect(
      importWorldDataForSession({
        store: invalidStore,
        sessionId: "sess-1",
        worldId: invalid.worldId,
        worldsDirs: [invalid.worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["world-notes"],
          registry: registry({ "world-notes": ["facts"] }),
        },
      }),
    ).rejects.toThrow(/source "facts" value failed schema validation/);
  });

  it("rejects invalid covel world dimensions during session import", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  dimensions:
    kind: yaml
    path: data/dimensions.yaml
    schema: covel://world/dimensions
    to: world:metadata.dimensions
`,
      files: {
        "data/dimensions.yaml": "tone:\n  genres: []\n  contentRating: teen\n",
      },
    });
    const store = await makeStore([]);

    await expect(
      importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
      }),
    ).rejects.toThrow(/invalid world dimensions/);
  });

  it("cleans imported media when later store writes fail", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
`,
      files: {
        "media/portraits/mio.png": "png-ish",
      },
    });
    const mediaStore = createMemoryMediaStore();
    const baseStore = await makeStore(["character-presence"]);
    const failingStore = new Proxy(baseStore, {
      get(target, prop, receiver) {
        if (prop === "setPluginDataBatch") {
          return async () => {
            throw new Error("simulated plugin-data failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DataStore;

    await expect(
      importWorldDataForSession({
        store: failingStore,
        mediaStore,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: {
          activePlugins: ["character-presence"],
          registry: registry({ "character-presence": ["assets"] }),
        },
      }),
    ).rejects.toThrow(/simulated plugin-data failure/);

    expect(await mediaStore.listAssets()).toEqual([]);
    expect(await mediaStore.listRefs()).toEqual([]);
  });

  it("uses active character dataSchemas as character effect mirror targets", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
`,
      files: {
        "data/cast.json": JSON.stringify({
          schemaVersion: 1,
          id: "mio",
          name: "Mio",
        }),
      },
    });
    const store = await makeStore(["character-blueprint", "third-party-cast"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["character-blueprint", "third-party-cast"],
        registry: registry({
          "character-blueprint": ["blueprints", "characters"],
          "char-creator": ["characters"],
          "third-party-cast": ["characters"],
        }),
      },
    });

    expect(result.written).toBe(4);
    expect(
      await store.getPluginData(
        "sess-1",
        "third-party-cast",
        "characters",
        "sess-1-char-mio",
      ),
    ).toBeTruthy();
    expect(
      await store.listPluginData("sess-1", "char-creator", "characters"),
    ).toEqual([]);
  });

  it("creates character effects from concise plugin-data character records", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: plugin:world-cast/cast
    key: id
    effects:
      - characters
`,
      files: {
        "data/cast.json": JSON.stringify({
          id: "mio",
          name: "Mio",
          type: "npc",
          description: "Keeps the archive keys.",
          fields: { mood: "focused" },
        }),
      },
    });
    const store = await makeStore([
      "world-cast",
      "char-creator",
      "third-party-cast",
    ]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-cast", "char-creator", "third-party-cast"],
        registry: registry({
          "world-cast": ["cast"],
          "char-creator": ["characters"],
          "third-party-cast": ["characters"],
        }),
      },
    });

    expect(result.written).toBe(4);
    expect(await store.listCharacters("sess-1")).toMatchObject([
      {
        id: "mio",
        name: "Mio",
        type: "npc",
        description: "Keeps the archive keys.",
        fields: { mood: "focused" },
      },
    ]);
    expect(
      await store.getPluginData("sess-1", "char-creator", "characters", "mio"),
    ).toMatchObject({
      value: {
        id: "mio",
        name: "Mio",
        sessionId: "sess-1",
      },
    });
    expect(
      await store.getPluginData(
        "sess-1",
        "third-party-cast",
        "characters",
        "mio",
      ),
    ).toBeTruthy();
  });

  it("skips existing rows with merge skipExisting", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: plugin:world-notes/facts
    key: id
    merge: skipExisting
`,
      files: {
        "data/fact.json": JSON.stringify({ id: "one", content: "new" }),
      },
    });
    const store = await makeStore(["world-notes"]);
    await store.setPluginData({
      id: "existing",
      sessionId: "sess-1",
      pluginId: "world-notes",
      namespace: "facts",
      key: "one",
      value: { id: "one", content: "old" },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.skipped).toBe(1);
    expect(
      await store.getPluginData("sess-1", "world-notes", "facts", "one"),
    ).toMatchObject({ value: { id: "one", content: "old" } });
  });

  it("imports plugin-data plus lorebook for +lorebook targets", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  rules:
    kind: yaml
    path: data/rules.yaml
    to: plugin:world-rules/rules+lorebook
    key: id
`,
      files: {
        "data/rules.yaml":
          "id: rain-market\ncontent: Never reveal true names.\nkind: triggered\nkeys: [rain, market]\ncoordinate:\n  position: before_plugin\n",
      },
    });
    const store = await makeStore(["world-rules"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-rules"],
        registry: registry({ "world-rules": ["rules"] }),
      },
    });

    expect(result.written).toBe(2);
    expect(
      await store.getPluginData(
        "sess-1",
        "world-rules",
        "rules",
        "rain-market",
      ),
    ).toBeTruthy();
    expect(await store.listSessionLorebookEntries("sess-1")).toMatchObject([
      {
        id: "world-rules:rules:rain-market",
        pluginId: "world-rules",
        content: "Never reveal true names.",
        keys: ["rain", "market"],
        strategy: "selective",
        position: "before_plugin",
      },
    ]);
  });

  it("keeps character-blueprint character effects and panel mirrors", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: plugin:character-blueprint/blueprints
    key: id
    effects:
      - characters
`,
      files: {
        "data/cast.json": JSON.stringify([
          {
            schemaVersion: 1,
            id: "mio",
            name: "Mio",
            role: "npc",
            attributes: { mood: "focused" },
          },
        ]),
      },
    });
    const store = await makeStore(["character-blueprint", "char-creator"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["character-blueprint", "char-creator"],
        registry: registry({
          "character-blueprint": ["blueprints", "characters"],
          "char-creator": ["characters"],
        }),
      },
    });

    expect(result.written).toBe(4);
    expect(await store.listCharacters("sess-1")).toMatchObject([
      { id: "sess-1-char-mio", name: "Mio" },
    ]);
    expect(
      await store.getPluginData(
        "sess-1",
        "char-creator",
        "characters",
        "sess-1-char-mio",
      ),
    ).toBeTruthy();
  });

  it("accepts concise world-authored character records for char-creator", async () => {
    const pluginRoot = await mkdtemp(
      path.join(tmpdir(), "covel-char-creator-plugin-"),
    );
    await mkdir(path.join(pluginRoot, "schemas"), { recursive: true });
    await writeFile(
      path.join(pluginRoot, "schemas/characters.schema.json"),
      JSON.stringify({
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          type: { type: "string" },
        },
        additionalProperties: true,
      }),
    );
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: plugin:char-creator/characters
    key: id
`,
      files: {
        "data/cast.json": JSON.stringify({
          id: "mio",
          name: "Mio",
          type: "npc",
        }),
      },
    });
    const store = await makeStore(["char-creator"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["char-creator"],
        registry: registryWithSchema({
          "char-creator": { rootPath: pluginRoot, namespaces: ["characters"] },
        }),
      },
    });

    expect(result.written).toBe(1);
    expect(
      await store.getPluginData("sess-1", "char-creator", "characters", "mio"),
    ).toMatchObject({
      value: { id: "mio", name: "Mio", type: "npc" },
    });
  });

  it("skips disallowed media files before writing media index data", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
`,
      files: {
        "media/portraits/readme.bin": "binary-ish",
      },
    });
    const store = await makeStore(["character-presence"]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["character-presence"],
        registry: registry({ "character-presence": ["assets"] }),
      },
    });

    expect(result.written).toBe(0);
    expect(
      await store.listPluginData("sess-1", "character-presence", "assets"),
    ).toEqual([]);
  });

  it("skips media index writes when the indexTo plugin is inactive (warning, media unaffected)", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
`,
      files: {
        "media/portraits/mio.png": "png-ish",
      },
    });
    const store = await makeStore([]);

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: [],
        registry: registry({ "character-presence": ["assets"] }),
      },
    });

    expect(result.diagnostics.some((d) => d.level === "error")).toBe(false);
    expect(
      result.diagnostics.some(
        (d) => d.level === "warning" && /indexTo plugin/.test(d.message),
      ),
    ).toBe(true);
    expect(
      await store.listPluginData("sess-1", "character-presence", "assets"),
    ).toEqual([]);
  });

  it("sync deletion removes only the current session ref for shared imported media", async () => {
    const { worldsDir, worldRoot, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
`,
      files: {
        "media/portraits/mio.png": "png-ish",
      },
    });
    const store = createMemoryStore();
    await addSession(store, "sess-a", ["character-presence"], worldId);
    await addSession(store, "sess-b", ["character-presence"], worldId);
    const mediaStore = createMemoryMediaStore();
    const preflight = {
      activePlugins: ["character-presence"],
      registry: registry({ "character-presence": ["assets"] }),
    };

    for (const sessionId of ["sess-a", "sess-b"]) {
      const result = await importWorldDataForSession({
        store,
        mediaStore,
        sessionId,
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight,
      });
      expect(result.written).toBe(1);
    }

    const mediaRowB = await store.getPluginData(
      "sess-b",
      "character-presence",
      "assets",
      "mio.png",
    );
    const mediaId =
      typeof (mediaRowB?.value as { ref?: { id?: unknown } } | undefined)?.ref
        ?.id === "string"
        ? (mediaRowB?.value as { ref: { id: string } }).ref.id
        : undefined;
    expect(mediaId).toEqual(expect.any(String));
    expect(await mediaStore.isReferencedBy(mediaId!, "sess-a")).toBe(true);
    expect(await mediaStore.isReferencedBy(mediaId!, "sess-b")).toBe(true);

    await writeFile(
      path.join(worldRoot, "data/world.data.yaml"),
      `schemaVersion: 1
sources: {}
`,
    );
    const sync = await syncWorldDataForSession({
      store,
      mediaStore,
      sessionId: "sess-a",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      dryRun: false,
      preflight,
    });

    expect(sync).toMatchObject({
      imported: true,
      dryRun: false,
      upserted: 0,
      deleted: 1,
      conflicts: [],
    });
    expect(
      await store.getPluginData(
        "sess-a",
        "character-presence",
        "assets",
        "mio.png",
      ),
    ).toBeNull();
    expect(
      await store.getPluginData(
        "sess-b",
        "character-presence",
        "assets",
        "mio.png",
      ),
    ).toBeTruthy();
    expect(await mediaStore.lookup(mediaId!)).not.toBeNull();
    expect(await mediaStore.exists(mediaId!)).toBe(true);
    expect(await mediaStore.isReferencedBy(mediaId!, "sess-b")).toBe(true);
    expect(
      (await mediaStore.listRefs()).filter((ref) => ref.mediaId === mediaId),
    ).not.toContainEqual(expect.objectContaining({ sessionId: "sess-a" }));
  });

  it("keeps media undeleted when a delete-sync transaction aborts", async () => {
    const { worldsDir, worldId, worldRoot } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: plugin:character-presence/assets
    key: filename
`,
      files: { "media/portraits/mio.png": "png-ish" },
    });
    const store = createMemoryStore();
    await addSession(store, "sess-a", ["character-presence"], worldId);
    const mediaStore = createMemoryMediaStore();
    const preflight = {
      activePlugins: ["character-presence"],
      registry: registry({ "character-presence": ["assets"] }),
    };

    await importWorldDataForSession({
      store,
      mediaStore,
      sessionId: "sess-a",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight,
    });
    const assetsBefore = (await mediaStore.listAssets()).map((a) => a.id);
    expect(assetsBefore).toHaveLength(1);

    // Empty sources ⇒ the imported media's ledger goes to ledgersToDelete.
    await writeFile(
      path.join(worldRoot, "data/world.data.yaml"),
      `schemaVersion: 1
sources: {}
`,
    );

    // Fail the ledger delete INSIDE the transaction, after deleteLedgerTarget
    // has collected the media for post-commit deletion. A pre-fix build deleted
    // the file inside the transaction, so the rollback left the committed DB
    // row pointing at a now-missing asset.
    const failingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "withTransaction") {
          return async (fn: (tx: unknown) => Promise<unknown>) =>
            store.withTransaction!(async (tx) => {
              const failingTx = new Proxy(tx as object, {
                get(t, p, r) {
                  if (p === "deleteWorldDataImportLedger") {
                    return async () => {
                      throw new Error("simulated ledger delete failure");
                    };
                  }
                  return Reflect.get(t, p, r);
                },
              });
              return fn(failingTx);
            });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as DataStore;

    await expect(
      syncWorldDataForSession({
        store: failingStore,
        mediaStore,
        sessionId: "sess-a",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        dryRun: false,
        preflight,
      }),
    ).rejects.toThrow(/simulated ledger delete failure/);

    // The media survived: deletion was deferred to post-commit and the
    // transaction never committed, so the rolled-back DB row still resolves.
    expect((await mediaStore.listAssets()).map((a) => a.id)).toEqual(
      assetsBefore,
    );
  });

  it("imports bundled haruka academy data with real plugin schemas", async () => {
    const worldsDir = path.resolve(import.meta.dirname, "../../../../worlds");
    const worldId = "haruka-academy";
    const activePlugins = [
      "chat-mode-narrator",
      "scene-cast",
      "scene-stage",
      "scene-prompts",
      "character-blueprint",
      "character-presence",
      "living-world-rules",
      "branch-reply",
      "char-creator",
    ];
    const store = createMemoryStore();
    await store.createSession({
      id: "sess-haruka",
      worldId,
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins,
      createdAt: NOW,
      updatedAt: NOW,
    });
    const pluginRegistry = await builtinPluginRegistry();

    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-haruka",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins,
        registry: pluginRegistry,
      },
    });

    expect(result.written).toBeGreaterThan(0);
    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(await store.listCharacters("sess-haruka")).not.toHaveLength(0);
    expect(
      await store.listPluginData(
        "sess-haruka",
        "character-blueprint",
        "blueprints",
      ),
    ).not.toHaveLength(0);
    expect(
      await store.listPluginData("sess-haruka", "char-creator", "characters"),
    ).not.toHaveLength(0);
    expect(await store.listWorldDataImportLedger("sess-haruka")).toHaveLength(
      result.written,
    );
  });

  it("imports bundled world rule sources with real plugin schemas", async () => {
    const worldsDir = path.resolve(import.meta.dirname, "../../../../worlds");
    const pluginRegistry = await builtinPluginRegistry();

    // mistport ships a living-world-rules rule set, a character-blueprint cast,
    // and character-presence portraits (media + presence); activate the plugins
    // all its sources target so the import is clean.
    const worldId = "mistport";
    const ruleSourceId = "tideRules";
    const activePlugins = [
      "living-world-rules",
      "character-blueprint",
      "char-creator",
      "character-presence",
    ];
    const sessionId = `sess-${worldId}`;
    const store = createMemoryStore();
    await store.createSession({
      id: sessionId,
      worldId,
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const result = await importWorldDataForSession({
      store,
      sessionId,
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins,
        registry: pluginRegistry,
      },
    });

    expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);
    expect(result.written).toBeGreaterThanOrEqual(6);
    expect(
      await store.listPluginData(sessionId, "living-world-rules", "rules"),
    ).toHaveLength(6);
    expect(await store.listSessionLorebookEntries(sessionId)).toHaveLength(6);
    expect(
      (await store.listWorldDataImportLedger(sessionId)).map(
        (row) => row.sourceId,
      ),
    ).toContain(ruleSourceId);
    expect(await store.listCharacters(sessionId)).not.toHaveLength(0);
  });

  it("materializes bundled world portraits into the media store and links presence", async () => {
    const worldsDir = path.resolve(import.meta.dirname, "../../../../worlds");
    const pluginRegistry = await builtinPluginRegistry();
    const activePlugins = [
      "living-world-rules",
      "character-blueprint",
      "char-creator",
      "character-presence",
      "scene-stage",
    ];

    // haruka media = 8 portraits + 10 scene backdrops (scenes source has indexTo).
    for (const [worldId, portraitCount, mediaCount] of [
      ["mistport", 7, 7],
      ["haruka-academy", 8, 18],
    ] as const) {
      const sessionId = `sess-portraits-${worldId}`;
      const store = createMemoryStore();
      const mediaStore = createMemoryMediaStore();
      await store.createSession({
        id: sessionId,
        worldId,
        status: "active",
        turnCount: 0,
        preGameCompleted: [],
        locale: "zh-CN",
        activePlugins,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const result = await importWorldDataForSession({
        store,
        mediaStore,
        sessionId,
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        preflight: { activePlugins, registry: pluginRegistry },
      });

      expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);

      // Every portrait is content-addressed into the media store.
      const assetIds = new Set(
        (await mediaStore.listAssets()).map((a) => a.id),
      );
      expect(assetIds.size).toBe(mediaCount);

      // Every character has a presence record whose avatar + sprite resolve to a
      // stored asset — i.e. the portrait actually displays for that character.
      const presence = await store.listPluginData(
        sessionId,
        "character-presence",
        "presence",
      );
      expect(presence).toHaveLength(portraitCount);
      for (const rec of presence) {
        const value = rec.value as {
          avatar?: { id?: string };
          sprite?: { id?: string };
        };
        expect(assetIds.has(value.avatar?.id ?? "")).toBe(true);
        expect(assetIds.has(value.sprite?.id ?? "")).toBe(true);
      }
    }
  });
});

describe("world data sync compare-and-swap", () => {
  // The conflict scan runs before the apply transaction opens. Anything it
  // declared unmodified can be edited in that window — by a turn, or by
  // another HTTP writer — and a `force: false` sync would then overwrite an
  // edit it just cleared. The transaction re-reads each target's hash and
  // aborts if it moved.
  async function seedManagedRow() {
    const { worldsDir, worldId, worldRoot } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: plugin:world-notes/facts
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([{ id: "gate", content: "v1" }]),
      },
    });
    const store = await makeStore(["world-notes"]);
    const preflight = {
      activePlugins: ["world-notes"],
      registry: registry({ "world-notes": ["facts"] }),
    };

    await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight,
    });

    // World package moves on, so the sync has real work to do.
    await writeFile(
      path.join(worldRoot, "data/facts.json"),
      JSON.stringify([{ id: "gate", content: "v2" }]),
    );
    return { store, worldsDir, worldId, preflight };
  }

  it("aborts when a managed row changes between the scan and the transaction", async () => {
    const { store, worldsDir, worldId, preflight } = await seedManagedRow();

    // Simulate the racing edit: the conflict scan reads the row through the
    // store, so mutate it the moment that read happens.
    const realGet = store.getPluginData.bind(store);
    let raced = false;
    store.getPluginData = (async (...args: Parameters<typeof realGet>) => {
      const row = await realGet(...args);
      if (!raced && row) {
        raced = true;
        const now = new Date().toISOString();
        await realGet(...args); // keep ordering readable
        await store.setPluginData({
          id: `sess-1:world-notes:facts:gate`,
          sessionId: "sess-1",
          pluginId: "world-notes",
          namespace: "facts",
          key: "gate",
          value: { id: "gate", content: "player edit" },
          createdAt: now,
          updatedAt: now,
        });
      }
      return row;
    }) as typeof store.getPluginData;

    await expect(
      syncWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [worldsDir],
        now: NOW,
        dryRun: false,
        force: false,
        preflight,
      }),
    ).rejects.toBeInstanceOf(WorldDataSyncConflictError);

    // The racing edit survives — the sync rolled back rather than clobbering it.
    const row = await realGet("sess-1", "world-notes", "facts", "gate");
    expect((row?.value as { content: string }).content).toBe("player edit");
  });

  it("applies normally when nothing races", async () => {
    const { store, worldsDir, worldId, preflight } = await seedManagedRow();

    const sync = await syncWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      dryRun: false,
      force: false,
      preflight,
    });

    expect(sync.conflicts).toEqual([]);
    const row = await store.getPluginData(
      "sess-1",
      "world-notes",
      "facts",
      "gate",
    );
    expect((row?.value as { content: string }).content).toBe("v2");
  });
});
