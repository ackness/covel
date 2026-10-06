import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import { type DataStore } from "@covel/store";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import {
  applyPreparedWorldDataImportForSession,
  finalizeWorldDataMediaRefs,
  WorldDataSyncConflictError,
  importWorldDataForSession,
  prepareWorldDataImportForSession,
  preflightWorldDataForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";
import { conventionsOfPlugins } from "../../src/world-data/conventions.js";
import { loadWorldDataDescriptor } from "../../src/world-data/descriptor.js";
import { collectMediaSourceFiles } from "../../src/world-data/media.js";

import {
  makePackageManifest,
  registry as registryEntries,
} from "./world-data-projection-fixtures.js";
import type { PluginRegistryEntry } from "@covel/plugin-loader";

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
    phase: "playing",
    setupRuntimes: {},
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: "sess-1",
    worldId: "demo-world",
    status: "active",
    completedPlayerTurns: 0,

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
    phase: "playing",
    setupRuntimes: {},
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id,
    worldId,
    status: "active",
    completedPlayerTurns: 0,

    locale: "zh-CN",
    activePlugins,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function registry(entries: Record<string, readonly string[]>) {
  return registryEntries(
    Object.entries(entries).map(([id, namespaces]): PluginRegistryEntry => ({
      id,
      rootPath: "",
      source: "builtin",
      summary: {
        id,
        name: id,
        description: "",
        pluginType: "plugin",
        runtimeCount: 0,
      },
      packageManifest: makePackageManifest(id, namespaces, "."),
      dataSchemas: Object.fromEntries(
        namespaces.map((namespace) => [
          namespace,
          { namespace, schemaVersion: 1, acceptsWorldData: true },
        ]),
      ),
      loadedRuntimes: new Map(),
      status: "registered",
    })),
  );
}

function registryWithSchema(entries: {
  readonly [pluginId: string]: {
    readonly rootPath: string;
    readonly namespaces: readonly string[];
  };
}) {
  return registryEntries(
    Object.entries(entries).map(([id, entry]): PluginRegistryEntry => ({
      id,
      rootPath: entry.rootPath,
      source: "builtin",
      summary: {
        id,
        name: id,
        description: "",
        pluginType: "plugin",
        runtimeCount: 0,
      },
      packageManifest: makePackageManifest(
        id,
        entry.namespaces,
        entry.rootPath,
      ),
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
      loadedRuntimes: new Map(),
      status: "registered",
    })),
  );
}

async function builtinPluginRegistry() {
  const pluginsRoot = path.resolve(import.meta.dirname, "../../../../plugins");
  const discoveries = await discoverPlugins(pluginsRoot);
  const registry = createPluginRegistry();

  for (const discovery of discoveries) {
    const { manifests, packageManifest } =
      await loadPluginDefinition(discovery);
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

      manifests,
      packageManifest,
      loadedRuntimes: new Map(),
      status: "registered",
    });
  }

  return registry;
}

describe("world data session importer", () => {
  it.each(["haruka-academy", "mistport"])(
    "imports %s time definitions before narration",
    async (worldId) => {
      const registry = await builtinPluginRegistry();
      const store = await makeStore(["world-init", "world-time"]);
      const result = await importWorldDataForSession({
        store,
        sessionId: "sess-1",
        worldId,
        worldsDirs: [path.resolve(import.meta.dirname, "../../../../worlds")],
        now: NOW,
        preflight: { registry, activePlugins: ["world-init", "world-time"] },
      });
      expect(
        result.diagnostics.filter((item) => item.level === "error"),
      ).toEqual([]);
      expect(
        (
          await store.getPluginData(
            "sess-1",
            "world-time",
            "definitions",
            "world",
          )
        )?.value,
      ).toMatchObject({
        id: "world",
        definition: {
          kind: worldId === "mistport" ? "phases" : "calendar",
          initial:
            worldId === "mistport"
              ? { cycle: 1, phase: 0 }
              : { year: 1, month: 4, day: 8, hour: 8, minute: 20, weekday: 0 },
        },
      });
      expect(
        await store.getPluginData("sess-1", "world-time", "clock", "current"),
      ).toBeNull();
    },
  );

  it("leaves Emberback without an imported definition so the plugin uses its default", async () => {
    const registry = await builtinPluginRegistry();
    const store = await makeStore(["world-init", "world-time"]);
    const result = await importWorldDataForSession({
      store,
      sessionId: "sess-1",
      worldId: "emberback",
      worldsDirs: [path.resolve(import.meta.dirname, "../../../../worlds")],
      now: NOW,
      preflight: { registry, activePlugins: ["world-init", "world-time"] },
    });
    expect(result.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(
      await store.getPluginData("sess-1", "world-time", "definitions", "world"),
    ).toBeNull();
  });

  it("skips time data with a warning when its receiver is disabled", async () => {
    const registry = await builtinPluginRegistry();
    const result = await preflightWorldDataForSession({
      sessionId: "preview",
      worldId: "mistport",
      worldsDirs: [path.resolve(import.meta.dirname, "../../../../worlds")],
      now: NOW,
      preflight: { registry, activePlugins: ["world-init"] },
    });
    expect(result.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warning",
        message:
          'No active receiver for data contract "world.time-definition@1"; source skipped',
      }),
    );
    expect(
      result.targets.some((target) => target.pluginId === "world-time"),
    ).toBe(false);
  });

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
      const { packageManifest } = await loadPluginDefinition(discovery);
      for (const parsed of [packageManifest]) {
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
      "character-blueprint/assets",
      "character-blueprint/blueprints",
      "character-blueprint/presence",
      "core-quest/quests",
      "inventory/items",
      "living-world-rules/rules",
      "memory/blocks",
      "memory/definitions",
      "scene-stage/assets",
      "scene-stage/scenes",
      "soundtrack/assets",
      "soundtrack/tracks",
      "story-events/events",
      "tabletop-rules/rules",
      "world-time/definitions",
    ]);
  });

  it("imports generic plugin-data records from JSON arrays", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world-notes.facts@1
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
    // One import writes its rows at one time; they list by key.
    expect(
      (await store.listPluginData("sess-1", "world-notes", "facts")).map(
        (row) => row.key,
      ),
    ).toEqual(["gate", "rain"]);
    expect(await store.listWorldDataImportLedger("sess-1")).toHaveLength(2);
  });

  it("imports hidden sources into the receiver's reserved hidden namespace", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  secrets:
    kind: json
    path: data/hidden/facts.json
    to: contract:world-notes.facts@1
    key: id
    visibility: hidden
`,
      files: {
        "data/hidden/facts.json": JSON.stringify([
          { id: "heir", content: "The keeper's child is the heir." },
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

    expect(result.written).toBe(1);
    expect(
      await store.listPluginData("sess-1", "world-notes", "facts"),
    ).toEqual([]);
    expect(
      (
        await store.listPluginData("sess-1", "world-notes", "_hidden.facts")
      ).map((row) => row.key),
    ).toEqual(["heir"]);
    expect(await store.listSessionLorebookEntries("sess-1")).toEqual([]);
  });

  it.each([
    [
      "contract:world-notes.facts@1+lorebook",
      /cannot project into the lorebook/,
    ],
    ["characters", /must target a data contract/],
  ])("rejects a hidden source targeting %s", async (to, message) => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  secrets:
    kind: json
    path: data/hidden/facts.json
    to: ${to}
    key: id
    visibility: hidden
`,
      files: {
        "data/hidden/facts.json": JSON.stringify([
          { id: "heir", content: "x" },
        ]),
      },
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
          registry: registry({ "world-notes": ["facts"] }),
        },
      }),
    ).rejects.toThrow(message);
    expect(
      await store.listPluginData("sess-1", "world-notes", "_hidden.facts"),
    ).toEqual([]);
  });

  it("prefers an exact locale source variant before the short key", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world-notes.facts@1
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([
          { id: "gate", content: "闸门锁着。" },
        ]),
        "data/facts.en.json": JSON.stringify([
          { id: "gate", content: "Generic English gate." },
        ]),
        "data/facts.en-US.json": JSON.stringify([
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
    expect(rows[0]).toBeDefined();
    expect((rows[0]!.value as { content: string }).content).toBe(
      "The gate is locked.",
    );
  });

  it("does not load a Simplified Chinese source variant for zh-Hant", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world-notes.facts@1
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([
          { id: "gate", content: "canonical" },
        ]),
        "data/facts.zh.json": JSON.stringify([
          { id: "gate", content: "simplified" },
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
      locale: "zh-Hant-TW",
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    const rows = await store.listPluginData("sess-1", "world-notes", "facts");
    expect((rows[0]!.value as { content: string }).content).toBe("canonical");
  });

  it("falls back to the declared source when no locale variant exists", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world-notes.facts@1
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
    expect(rows[0]).toBeDefined();
    expect((rows[0]!.value as { content: string }).content).toBe("闸门锁着。");
  });

  it("a malicious locale cannot escape the descriptor root (path traversal)", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    to: contract:world-notes.facts@1
    key: id
`,
      files: {
        "data/facts.json": JSON.stringify([{ id: "gate", content: "safe" }]),
      },
    });
    const store = await makeStore(["world-notes"]);

    // Invalid/path-like locale input yields no variant candidates and safely
    // falls back to the contained declared source.
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
    expect(rows[0]).toBeDefined();
    expect((rows[0]!.value as { content: string }).content).toBe("safe");
  });

  it("rejects missing plugin schemas during preflight", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: contract:missing-plugin.facts@1
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
    ).rejects.toThrow(/No registered receiver/);
  });

  it("skips sources targeting plugins outside final activePlugins (warning, not a session-blocking error)", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: contract:world-notes.facts@1
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
        (d) => d.level === "warning" && /No active receiver/.test(d.message),
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
    to: contract:world-notes.facts@1
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
    to: contract:world-notes.facts@1
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
      // The source names no schema, so it is checked by the schema of its
      // contract, and that path is where the link is refused.
    ).rejects.toThrow(/Invalid schema path for contract "world-notes.facts@1"/);
    expect(
      await store.listPluginData("sess-1", "world-notes", "facts"),
    ).toEqual([]);
  });

  it("accepts an independently declared compatible source schema and receiver contract", async () => {
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
    schema: contract:a.ns@1
    to: contract:b.ns@1
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
    ).resolves.toMatchObject({ written: 1 });
  });

  it("validates and rejects source values with world-local schema paths", async () => {
    const descriptor = `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/facts.json
    schema: schemas/fact.schema.json
    to: contract:world-notes.facts@1
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

  it("supports explicit draft-07 world-local schemas", async () => {
    const descriptor = `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    schema: schemas/fact.schema.json
    to: contract:world-notes.facts@1
    key: id
`;
    const { worldsDir, worldId } = await makeWorld({
      id: "draft-seven-world",
      descriptor,
      files: {
        "data/fact.json": JSON.stringify({
          id: "legacy",
          tuple: ["one"],
        }),
        "schemas/fact.schema.json": JSON.stringify({
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          required: ["id", "tuple"],
          properties: {
            id: { type: "string" },
            tuple: {
              type: "array",
              items: [{ type: "string" }],
              additionalItems: false,
            },
          },
        }),
      },
    });

    const result = await importWorldDataForSession({
      store: await makeStore(["world-notes"]),
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    });

    expect(result.written).toBe(1);
  });

  it("recompiles a world-local schema when the file changes", async () => {
    const descriptor = `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    schema: schemas/fact.schema.json
    to: contract:world-notes.facts@1
    key: id
`;
    const initialSchema = {
      $id: "https://covel.test/schemas/fact",
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    };
    const { worldsDir, worldId } = await makeWorld({
      id: "schema-refresh-world",
      descriptor,
      files: {
        "data/fact.json": JSON.stringify({ id: "fact" }),
        "schemas/fact.schema.json": JSON.stringify(initialSchema),
      },
    });
    const store = await makeStore(["world-notes"]);
    const options = {
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["world-notes"],
        registry: registry({ "world-notes": ["facts"] }),
      },
    } as const;

    await expect(importWorldDataForSession(options)).resolves.toMatchObject({
      written: 1,
    });
    await writeFile(
      path.join(worldsDir, worldId, "schemas/fact.schema.json"),
      JSON.stringify({
        ...initialSchema,
        required: ["id", "newRequiredField"],
        properties: {
          ...initialSchema.properties,
          newRequiredField: { type: "string" },
        },
      }),
    );

    await expect(importWorldDataForSession(options)).rejects.toThrow(
      /failed schema validation/,
    );
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

  it("leaves unclaimed media for GC when later store writes fail", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: contract:character.portrait-assets@1
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

    expect(await mediaStore.listAssets()).toEqual([
      expect.objectContaining({ ownerSessionId: null }),
    ]);
    await mediaStore.cleanup(new Set(), { maxAgeMs: 0 });
    expect(await mediaStore.listAssets()).toEqual([]);
    expect(await mediaStore.listRefs()).toEqual([]);
  });

  it("materializes prepared media before the database transaction", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  portraits:
    kind: media
    path: media/portraits
    to: media
    indexTo: contract:character.portrait-assets@1
    key: filename
`,
      files: {
        "media/portraits/mio.png": "png-ish",
      },
    });
    const mediaStore = createMemoryMediaStore();
    let transactionOpen = false;
    const guardedMediaStore = new Proxy(mediaStore, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return async (...args: Parameters<typeof target.put>) => {
            if (transactionOpen) {
              throw new Error("media put ran inside the database transaction");
            }
            return target.put(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const store = await makeStore(["character-presence"]);
    const prepared = await prepareWorldDataImportForSession({
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      mediaStore: guardedMediaStore,
      now: NOW,
      preflight: {
        activePlugins: ["character-presence"],
        registry: registry({ "character-presence": ["assets"] }),
      },
    });
    expect(await mediaStore.listAssets()).toHaveLength(1);

    const imported = await store.withTransaction(async (tx) => {
      transactionOpen = true;
      try {
        return await applyPreparedWorldDataImportForSession({
          store: tx,
          mediaStore: guardedMediaStore,
          sessionId: "sess-1",
          worldId,
          now: NOW,
          prepared,
          deferMediaFinalize: true,
        });
      } finally {
        transactionOpen = false;
      }
    });
    await finalizeWorldDataMediaRefs({
      mediaStore: guardedMediaStore,
      refs: imported.mediaRefs,
    });

    expect(imported.written).toBe(1);
    expect(
      await store.getPluginData(
        "sess-1",
        "character-presence",
        "assets",
        "mio.png",
      ),
    ).toBeTruthy();
  });

  it("writes character effects to the domain without mirroring to active plugin namespaces", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: contract:character.blueprints@1
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

    expect(result.written).toBe(2);
    expect(await store.listCharacters("sess-1")).toMatchObject([
      { id: "mio", name: "Mio" },
    ]);
    expect(
      await store.listPluginData("sess-1", "third-party-cast", "characters"),
    ).toEqual([]);
    expect(
      await store.listPluginData("sess-1", "char-creator", "characters"),
    ).toEqual([]);
  });

  it("creates character domain effects from concise contract records", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: contract:world-cast.cast@1
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

    expect(result.written).toBe(2);
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
      await store.listPluginData("sess-1", "char-creator", "characters"),
    ).toEqual([]);
    expect(
      await store.listPluginData("sess-1", "third-party-cast", "characters"),
    ).toEqual([]);
  });

  it("uses persisted character IDs for skipExisting and sync ledger deletion", async () => {
    const { worldsDir, worldRoot, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: characters
    key: id
    merge: skipExisting
`,
      files: {
        "data/cast.json": JSON.stringify([
          { id: "npc", name: "Original", type: "npc" },
        ]),
      },
    });
    const store = await makeStore([]);
    const options = {
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
    };
    expect((await importWorldDataForSession(options)).written).toBe(1);
    expect((await store.listWorldDataImportLedger("sess-1"))[0]?.key).toBe(
      "npc",
    );
    expect((await importWorldDataForSession(options)).skipped).toBe(1);
    expect(await syncWorldDataForSession(options)).toMatchObject({
      unchanged: 1,
      conflicts: [],
    });
    const character = (await store.listCharacters("sess-1"))[0]!;
    await store.upsertCharacter({ ...character, name: "Player edit" });
    await writeFile(
      path.join(worldRoot, "data/cast.json"),
      JSON.stringify([{ id: "npc", name: "Source edit", type: "npc" }]),
    );
    expect((await importWorldDataForSession(options)).skipped).toBe(1);
    expect((await store.listCharacters("sess-1"))[0]?.name).toBe("Player edit");
    expect(await syncWorldDataForSession(options)).toMatchObject({
      conflicts: [{ reason: "modified", key: "npc" }],
    });
    await store.upsertCharacter(character);
    await writeFile(path.join(worldRoot, "data/cast.json"), "[]");
    expect(await syncWorldDataForSession(options)).toMatchObject({
      deleted: 1,
      conflicts: [],
    });
    expect(await store.listCharacters("sess-1")).toEqual([]);
  });

  it("syncs the rows that are not in conflict and keeps the ones that are", async () => {
    const { worldsDir, worldRoot, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: characters
    key: id
`,
      files: {
        "data/cast.json": JSON.stringify([
          { id: "npc", name: "Original", type: "npc" },
        ]),
      },
    });
    const store = await makeStore([]);
    const options = {
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
    };
    expect((await importWorldDataForSession(options)).written).toBe(1);
    // Play changed one character; the world package then changed it too and
    // gained another.
    const character = (await store.listCharacters("sess-1"))[0]!;
    await store.upsertCharacter({ ...character, name: "Player edit" });
    await writeFile(
      path.join(worldRoot, "data/cast.json"),
      JSON.stringify([
        { id: "npc", name: "Source edit", type: "npc" },
        { id: "guide", name: "New in the package", type: "npc" },
      ]),
    );

    expect(await syncWorldDataForSession(options)).toMatchObject({
      dryRun: false,
      upserted: 1,
      conflicts: [{ reason: "modified", key: "npc" }],
    });
    const names = Object.fromEntries(
      (await store.listCharacters("sess-1")).map((row) => [row.id, row.name]),
    );
    expect(names).toEqual({
      npc: "Player edit",
      guide: "New in the package",
    });
    // The new row is on the ledger: the next sync has nothing left to add.
    expect(await syncWorldDataForSession(options)).toMatchObject({
      upserted: 0,
      unchanged: 1,
      conflicts: [{ reason: "modified", key: "npc" }],
    });
  });

  it("lists imported characters as the author wrote them, and a sync keeps each one's place", async () => {
    const { worldsDir, worldRoot, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: characters
    key: id
`,
      files: {
        // Against the order of the IDs.
        "data/cast.json": JSON.stringify([
          { id: "npc-zoe", name: "Zoe", type: "npc" },
          { id: "npc-adam", name: "Adam", type: "npc" },
          { id: "npc-mira", name: "Mira", type: "npc" },
        ]),
      },
    });
    const store = await makeStore([]);
    const options = {
      store,
      sessionId: "sess-1",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
    };
    await importWorldDataForSession(options);
    const roster = async () =>
      (await store.listCharacters("sess-1")).map((row) => row.name);
    expect(await roster()).toEqual(["Zoe", "Adam", "Mira"]);

    // Play changed one character, so the sync leaves it alone; the package
    // changed another and gained one. The rewritten character is not a new
    // one: it stays where it was.
    const adam = (await store.listCharacters("sess-1"))[1]!;
    await store.upsertCharacter({ ...adam, name: "Adam, wounded" });
    await writeFile(
      path.join(worldRoot, "data/cast.json"),
      JSON.stringify([
        { id: "npc-zoe", name: "Zoe Hale", type: "npc" },
        { id: "npc-adam", name: "Adam", type: "npc" },
        { id: "npc-mira", name: "Mira", type: "npc" },
        { id: "npc-bao", name: "Bao", type: "npc" },
      ]),
    );
    expect(
      await syncWorldDataForSession({
        ...options,
        now: "2026-02-01T00:00:00.000Z",
      }),
    ).toMatchObject({ conflicts: [{ reason: "modified", key: "npc-adam" }] });
    expect(await roster()).toEqual([
      "Zoe Hale",
      "Adam, wounded",
      "Mira",
      "Bao",
    ]);
  });

  it("skips existing rows with merge skipExisting", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  facts:
    kind: json
    path: data/fact.json
    to: contract:world-notes.facts@1
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
    to: contract:world-rules.rules@1+lorebook
    key: id
`,
      files: {
        "data/rules.yaml":
          "id: rain-market\ntitle: The Rain Market\ncontent: Never reveal true names.\nkind: triggered\nkeys: [rain, market]\ncoordinate:\n  position: before_plugin\n",
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
        id: "rules:rain-market",
        owner: { kind: "world" },
        content: "Never reveal true names.",
        keys: ["rain", "market"],
        strategy: "selective",
        position: "before_plugin",
        // The prompt names the rule by this; without it the model reads
        // "rules:rain-market" or the first keyword as the rule's title.
        extra: { title: "The Rain Market" },
      },
    ]);
  });

  it("keeps imported blueprint records separate from character domain effects", async () => {
    const { worldsDir, worldId } = await makeWorld({
      descriptor: `schemaVersion: 1
sources:
  cast:
    kind: json
    path: data/cast.json
    to: contract:character.blueprints@1
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

    expect(result.written).toBe(2);
    expect(await store.listCharacters("sess-1")).toMatchObject([
      { id: "mio", name: "Mio" },
    ]);
    expect(
      await store.getPluginData(
        "sess-1",
        "character-blueprint",
        "blueprints",
        "mio",
      ),
    ).toBeTruthy();
    expect(
      await store.listPluginData("sess-1", "char-creator", "characters"),
    ).toEqual([]);
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
    to: contract:char-creator.characters@1
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
    indexTo: contract:character.portrait-assets@1
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
    indexTo: contract:character.portrait-assets@1
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
        (d) => d.level === "warning" && /No active receiver/.test(d.message),
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
    indexTo: contract:character.portrait-assets@1
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
    const mediaValue = mediaRowB?.value as
      { ref?: { id?: unknown } } | undefined;
    const mediaId =
      typeof mediaValue?.ref?.id === "string" ? mediaValue.ref.id : undefined;
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
    indexTo: contract:character.portrait-assets@1
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
      "world-init",
      "chat-mode-narrator",
      "scene-stage",
      "guide",
      "character-blueprint",
      "living-world-rules",
      "branch-reply",
      "char-creator",
    ];
    const store = createMemoryStore();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "sess-haruka",
      worldId,
      status: "active",
      completedPlayerTurns: 0,

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
    ).toHaveLength(0);
    expect(await store.listWorldDataImportLedger("sess-haruka")).toHaveLength(
      result.written,
    );
  });

  it("imports bundled world rule sources with real plugin schemas", async () => {
    const worldsDir = path.resolve(import.meta.dirname, "../../../../worlds");
    const pluginRegistry = await builtinPluginRegistry();

    // mistport ships a living-world-rules rule set, a character-blueprint cast
    // and portraits (media + presence); activate the plugins all its sources
    // target so the import is clean.
    const worldId = "mistport";
    const ruleSourceId = "tideRules";
    const activePlugins = [
      "world-init",
      "living-world-rules",
      "character-blueprint",
      "char-creator",
    ];
    const sessionId = `sess-${worldId}`;
    const store = createMemoryStore();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: sessionId,
      worldId,
      status: "active",
      completedPlayerTurns: 0,

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
    ).toHaveLength(9);
    expect(await store.listSessionLorebookEntries(sessionId)).toHaveLength(9);
    expect(
      (await store.listWorldDataImportLedger(sessionId)).map(
        (row) => row.sourceId,
      ),
    ).toContain(ruleSourceId);
    expect(await store.listCharacters(sessionId)).not.toHaveLength(0);
  });

  it.each([
    ["emberback", "en-US", 5],
    ["lantern-barrow", "zh-CN", 6],
    ["mistport", "zh-CN", 7],
    ["mistport", "en-US", 7],
    ["haruka-academy", "zh-CN", 8],
  ] as const)(
    "materializes bundled %s portraits (%s) into the media store and links presence",
    async (worldId, locale, portraitCount) => {
      const worldsDir = path.resolve(import.meta.dirname, "../../../../worlds");
      const pluginRegistry = await builtinPluginRegistry();
      const activePlugins = [
        "world-init",
        "living-world-rules",
        "character-blueprint",
        "char-creator",
        "scene-stage",
      ];
      const sessionId = `sess-portraits-${worldId}-${locale}`;
      const worldRoot = path.join(worldsDir, worldId);
      // emberback has no descriptor: its files are read by convention.
      const descriptor = await loadWorldDataDescriptor({
        worldRoot,
        worldId,
        conventions: conventionsOfPlugins(pluginRegistry),
      });
      expect(
        descriptor.diagnostics.filter(
          (diagnostic) => diagnostic.level === "error",
        ),
      ).toEqual([]);
      const mediaCollections = await Promise.all(
        descriptor.sources
          .filter((source) => source.descriptor.kind === "media")
          .map((source) =>
            collectMediaSourceFiles(
              source,
              path.resolve(
                source.pathOrigin.descriptorRoot,
                source.descriptor.path,
              ),
            ),
          ),
      );
      expect(
        mediaCollections.flatMap((collection) =>
          collection.diagnostics.filter(
            (diagnostic) => diagnostic.level === "error",
          ),
        ),
      ).toEqual([]);
      const expectedAssetIds = new Set(
        await Promise.all(
          mediaCollections
            .flatMap((collection) => collection.files)
            .map(async (file) =>
              createHash("sha256")
                .update(await readFile(file))
                .digest("hex"),
            ),
        ),
      );
      const store = createMemoryStore();
      const mediaStore = createMemoryMediaStore();
      await store.createSession({
        phase: "playing",
        setupRuntimes: {},
        metadata: {
          approvalScopeNonce: globalThis.crypto.randomUUID(),
          sessionIncarnationNonce: globalThis.crypto.randomUUID(),
        },
        id: sessionId,
        worldId,
        status: "active",
        completedPlayerTurns: 0,

        locale,
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
        locale,
        preflight: { activePlugins, registry: pluginRegistry },
      });

      expect(result.diagnostics.filter((d) => d.level === "error")).toEqual([]);

      // Every portrait is content-addressed into the media store.
      const assetIds = new Set(
        (await mediaStore.listAssets()).map((a) => a.id),
      );
      expect(assetIds).toEqual(expectedAssetIds);

      // Every character has a presence record whose avatar + sprite resolve to a
      // stored asset — i.e. the portrait actually displays for that character.
      const presence = await store.listPluginData(
        sessionId,
        "character-blueprint",
        "presence",
      );
      expect(presence).toHaveLength(portraitCount);
      if (worldId === "mistport" && locale === "en-US") {
        expect(presence.map((record) => record.value)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ displayName: "Lin Yuanzhou" }),
          ]),
        );
      }
      for (const rec of presence) {
        const value = rec.value as {
          avatar?: { id?: string };
          sprite?: { id?: string };
        };
        expect(assetIds.has(value.avatar?.id ?? "")).toBe(true);
        expect(assetIds.has(value.sprite?.id ?? "")).toBe(true);
      }
    },
  );
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
    to: contract:world-notes.facts@1
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
    expect(row).not.toBeNull();
    expect((row!.value as { content: string }).content).toBe("player edit");
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
    expect(row).not.toBeNull();
    expect((row!.value as { content: string }).content).toBe("v2");
  });
});
