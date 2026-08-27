import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginManifest,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import {
  importWorldDataForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";
import { buildImportPlan } from "../../src/world-data/session-import/planning.js";
import {
  makePlugin,
  makeSource,
  NOW,
  registry,
  VALID_WORLD_IR,
  WORLD_IR_SCHEMA,
} from "./world-data-projection-fixtures.js";

describe("world data projections", () => {
  it("runs the bundled living-world-rules WorldIR projection", async () => {
    const pluginsRoot = path.resolve(
      import.meta.dirname,
      "../../../../plugins",
    );
    const discovery = (await discoverPlugins(pluginsRoot)).find(
      (candidate) => candidate.id === "living-world-rules",
    );
    expect(discovery).toBeDefined();
    const manifests = await loadPluginManifest(discovery!);
    const pluginRegistry = createPluginRegistry();
    pluginRegistry.register({
      id: discovery!.id,
      source: "builtin",
      rootPath: discovery!.rootPath,
      summary: {
        id: discovery!.id,
        name: discovery!.id,
        description: "",
        pluginType: "plugin",
        runtimeCount: manifests.length,
      },
      manifest: manifests[0],
      manifests,
      loadedRuntimes: new Map(),
      status: "registered",
    });

    const plan = await buildImportPlan({
      sessionId: "sess-1",
      worldId: "world-1",
      sources: [await makeSource(VALID_WORLD_IR)],
      now: NOW,
      deps: {
        activePlugins: ["living-world-rules"],
        registry: pluginRegistry,
      },
    });

    expect(plan.diagnostics.filter((item) => item.level === "error")).toEqual(
      [],
    );
    expect(plan.writes).toEqual([
      expect.objectContaining({
        kind: "plugin-data",
        pluginId: "living-world-rules",
        namespace: "rules",
        key: "harbor-rule",
        value: {
          schemaVersion: 1,
          id: "harbor-rule",
          content: "The harbor closes at dusk.",
        },
      }),
    ]);
  });

  it("persists projection provenance and updates projected data through normal sync", async () => {
    const worldsDir = await mkdtemp(
      path.join(tmpdir(), "covel-world-projection-sync-"),
    );
    const worldId = "projection-world";
    const worldRoot = path.join(worldsDir, worldId);
    await mkdir(path.join(worldRoot, "data"), { recursive: true });
    await writeFile(
      path.join(worldRoot, "world.yaml"),
      `schemaVersion: "1"
id: ${worldId}
name: Projection World
summary: Projection test world
defaultLocale: en-US
worldData: data/world.data.yaml
`,
    );
    await writeFile(
      path.join(worldRoot, "data/world.data.yaml"),
      `schemaVersion: 1
sources:
  worldIr:
    kind: json
    path: data/world-ir.json
    schema: ${WORLD_IR_SCHEMA}
    to: world:metadata.worldIr
    effects: [projections]
`,
    );
    const sourcePath = path.join(worldRoot, "data/world-ir.json");
    await writeFile(sourcePath, JSON.stringify(VALID_WORLD_IR));

    const plugin = await makePlugin({
      root: await mkdtemp(
        path.join(tmpdir(), "covel-world-projection-sync-plugin-"),
      ),
      id: "facts",
      handlers: {
        "main.mjs": `export default ({ value }) => ({ facts: { id: "summary", kind: "summary", content: value.summary } });`,
      },
      projections: {
        main: {
          from: WORLD_IR_SCHEMA,
          handler: "./handlers/main.mjs",
          outputs: { facts: { namespace: "facts", key: "id" } },
        },
      },
      namespaces: ["facts"],
      schemaRequired: ["id", "kind"],
    });
    const pluginRegistry = registry([plugin]);
    const store = createMemoryStore();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: "sess-sync",
      worldId,
      status: "active",
      completedPlayerTurns: 0,
      locale: "en-US",
      activePlugins: ["facts"],
      createdAt: NOW,
      updatedAt: NOW,
    });

    const imported = await importWorldDataForSession({
      store,
      sessionId: "sess-sync",
      worldId,
      worldsDirs: [worldsDir],
      now: NOW,
      preflight: {
        activePlugins: ["facts"],
        registry: pluginRegistry,
      },
    });

    expect(imported.written).toBe(1);
    expect(
      await store.getPluginData("sess-sync", "facts", "facts", "summary"),
    ).toMatchObject({ value: { content: "A compact test world." } });
    expect(await store.listWorldDataImportLedger("sess-sync")).toEqual([
      expect.objectContaining({
        sourceId: "worldIr",
        derivedFrom: ["worldIr", "projection:facts/main", "output:facts"],
      }),
    ]);

    // Handler-only edits are part of projection provenance even when they do
    // not change the value. Sync must re-run/re-record the derived output
    // instead of claiming that the old plugin code is still current.
    await writeFile(
      path.join(plugin.rootPath!, "handlers/main.mjs"),
      `// implementation revision 2\nexport default ({ value }) => ({ facts: { id: "summary", kind: "summary", content: value.summary } });`,
    );
    const handlerOnlySync = await syncWorldDataForSession({
      store,
      sessionId: "sess-sync",
      worldId,
      worldsDirs: [worldsDir],
      now: "2026-01-01T12:00:00.000Z",
      preflight: {
        activePlugins: ["facts"],
        registry: pluginRegistry,
      },
    });
    expect(handlerOnlySync.upserted).toBe(1);
    expect(handlerOnlySync.unchanged).toBe(0);

    await writeFile(
      sourcePath,
      JSON.stringify({ ...VALID_WORLD_IR, summary: "Updated world." }),
    );
    const synced = await syncWorldDataForSession({
      store,
      sessionId: "sess-sync",
      worldId,
      worldsDirs: [worldsDir],
      now: "2026-01-02T00:00:00.000Z",
      preflight: {
        activePlugins: ["facts"],
        registry: pluginRegistry,
      },
    });

    expect(synced.upserted).toBe(1);
    expect(
      await store.getPluginData("sess-sync", "facts", "facts", "summary"),
    ).toMatchObject({ value: { content: "Updated world." } });

    // A failed producer is not an authoritative empty result. Preserve its
    // last good row and ledger so a transient deployment/runtime failure does
    // not erase plugin state during sync.
    await writeFile(
      path.join(plugin.rootPath!, "handlers/main.mjs"),
      `export default () => null;`,
    );
    const deferredSync = await syncWorldDataForSession({
      store,
      sessionId: "sess-sync",
      worldId,
      worldsDirs: [worldsDir],
      now: "2026-01-03T00:00:00.000Z",
      preflight: {
        activePlugins: ["facts"],
        registry: pluginRegistry,
      },
    });
    expect(deferredSync.deleted).toBe(0);
    expect(deferredSync.unchanged).toBe(1);
    expect(
      deferredSync.diagnostics.map((item) => item.message).join("\n"),
    ).toContain("must return an object");
    expect(
      await store.getPluginData("sess-sync", "facts", "facts", "summary"),
    ).toMatchObject({ value: { content: "Updated world." } });
    expect(await store.listWorldDataImportLedger("sess-sync")).toHaveLength(1);

    // A successful empty output is authoritative and may remove the old row.
    await writeFile(
      path.join(plugin.rootPath!, "handlers/main.mjs"),
      `export default () => ({ facts: [] });`,
    );
    const emptySync = await syncWorldDataForSession({
      store,
      sessionId: "sess-sync",
      worldId,
      worldsDirs: [worldsDir],
      now: "2026-01-04T00:00:00.000Z",
      preflight: {
        activePlugins: ["facts"],
        registry: pluginRegistry,
      },
    });
    expect(emptySync.deleted).toBe(1);
    expect(
      await store.getPluginData("sess-sync", "facts", "facts", "summary"),
    ).toBeNull();
    expect(await store.listWorldDataImportLedger("sess-sync")).toEqual([]);
  });
});
