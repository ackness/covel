/**
 * A community plugin that receives world data is not active when the session
 * is created: it waits for the player's approval. Creation tells the player
 * its data was skipped, and enabling it after approval imports that data once.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { WorldDataReceiverImport } from "@covel/shared";
import type { DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";
import { makePackageManifest } from "../lib/world-data-projection-fixtures.js";

const NOTES = "world-notes";
const CONTRACT = "world-notes.facts@1";

async function entry(
  root: string,
  id: string,
  source: PluginRegistryEntry["source"],
  namespaces: readonly string[] = [],
): Promise<PluginRegistryEntry> {
  const rootPath = path.join(root, id);
  await mkdir(path.join(rootPath, "schemas"), { recursive: true });
  for (const namespace of namespaces)
    await writeFile(
      path.join(rootPath, "schemas", `${namespace}.schema.json`),
      JSON.stringify({ type: "object" }),
    );
  return {
    id,
    rootPath,
    source,
    summary: {
      id,
      name: id,
      description: "",
      pluginType: "plugin",
      runtimeCount: 0,
    },
    packageManifest: makePackageManifest(id, namespaces, rootPath, CONTRACT),
    dataSchemas: Object.fromEntries(
      namespaces.map((namespace) => [
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
  };
}

describe("world data of a community receiver approved after creation", () => {
  let worldsDir: string;
  let registry: PluginRegistry;
  let store: DataStore;
  let gate: RpcApprovalGate;
  let app: Hono;

  beforeEach(async () => {
    worldsDir = await mkdtemp(path.join(tmpdir(), "covel-community-data-"));
    const worldRoot = path.join(worldsDir, "notes-world");
    await mkdir(worldRoot, { recursive: true });
    await writeFile(
      path.join(worldRoot, "world.yaml"),
      "id: notes-world\nname: Notes\nsummary: Notes\ndefaultLocale: en-US\nworldData: world.data.yaml\n",
    );
    await writeFile(
      path.join(worldRoot, "world.data.yaml"),
      `sources:\n  facts:\n    kind: json\n    path: facts.json\n    to: contract:${CONTRACT}\n    key: id\n`,
    );
    await writeFile(
      path.join(worldRoot, "facts.json"),
      JSON.stringify([
        { id: "rain", content: "Rain matters." },
        { id: "gate", content: "The gate is locked." },
      ]),
    );
    registry = createPluginRegistry();
    registry.register(await entry(worldsDir, NOTES, "community", ["facts"]));
    store = createMemoryStore();
    await store.createWorld({
      id: "notes-world",
      name: "Notes",
      description: "",
      metadata: { defaultLocale: "en-US" },
      createdAt: new Date().toISOString(),
    });
    gate = createRpcApprovalGate();
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", registry);
      c.set("rpcApprovalGate", gate);
      c.set("activatePluginServerCode", async () => {});
      c.set("sessionLock", createInProcessSessionLock());
      c.set("worldsDirs", [worldsDir]);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
  });
  afterEach(async () => {
    await rm(worldsDir, { recursive: true, force: true });
  });

  // A turn changes an imported row.
  const change = async (pluginId: string, key: string, content: string) => {
    const row = (await store.getPluginData("s1", pluginId, "facts", key))!;
    await store.setPluginData({
      ...row,
      value: { id: key, content },
      updatedAt: new Date().toISOString(),
    });
  };
  const facts = async () =>
    (await store.listPluginData("s1", NOTES, "facts")).map((row) => row.key);
  const enable = async () => {
    const first = await app.request(`/api/sessions/s1/plugins/${NOTES}`, {
      method: "PUT",
    });
    if (first.status === 202) {
      const pending = (await first.json()) as { approvalId: string };
      gate.decide(
        {
          approvalId: pending.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: new Date().toISOString(),
        },
        sessionApprovalScope((await store.getSession("s1"))!, NOTES),
      );
    }
    const enabled = await app.request(`/api/sessions/s1/plugins/${NOTES}`, {
      method: "PUT",
    });
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    return (await enabled.json()) as { worldData?: WorldDataReceiverImport };
  };

  it("reports the skipped data at creation and imports it once after approval", async () => {
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "s1",
        worldId: "notes-world",
        plugins: [NOTES],
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const body = (await created.json()) as {
      worldDataNotices?: {
        level: string;
        sourceId?: string;
        message: string;
      }[];
    };
    expect(body.worldDataNotices).toContainEqual(
      expect.objectContaining({
        level: "warning",
        sourceId: "facts",
        message: expect.stringContaining(CONTRACT),
      }),
    );
    expect(await facts()).toEqual([]);

    const { worldData } = await enable();
    expect(worldData).toEqual({
      receivers: [NOTES],
      imported: 2,
      conflicts: 0,
      notices: [],
    });
    expect(await facts()).toEqual(["gate", "rain"]);

    // The game changes a row; turning the plugin off and on again does not
    // import over it.
    await change(NOTES, "rain", "The rain stopped.");
    const disabled = await app.request(`/api/sessions/s1/plugins/${NOTES}`, {
      method: "DELETE",
    });
    expect(disabled.status).toBe(200);
    const again = await enable();
    expect(again.worldData).toMatchObject({ receivers: [], imported: 0 });
    expect(
      (await store.getPluginData("s1", NOTES, "facts", "rain"))?.value,
    ).toEqual({ id: "rain", content: "The rain stopped." });
  });

  it("imports a confirmed dependent when its missing provider makes it runnable", async () => {
    const dependent = await entry(worldsDir, NOTES, "builtin", ["facts"]);
    const provider = await entry(worldsDir, "support", "builtin");
    if (!dependent.packageManifest || !provider.packageManifest)
      throw new Error("expected fixture manifests");
    registry.register({
      ...dependent,
      packageManifest: {
        ...dependent.packageManifest,
        plugin: {
          ...dependent.packageManifest.plugin,
          requires: ["support@1"],
        },
      },
    });
    registry.register({
      ...provider,
      packageManifest: {
        ...provider.packageManifest,
        plugin: { ...provider.packageManifest.plugin, provides: ["support@1"] },
      },
    });
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "s1", worldId: "notes-world", plugins: [] }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const session = (await store.getSession("s1"))!;
    // A save can confirm a dependent while its missing provider keeps it off.
    await store.updateSession("s1", {
      activePlugins: [NOTES],
      metadata: {
        ...session.metadata,
        pluginSelection: {
          requested: [NOTES],
          excluded: ["support"],
          requiredContracts: [],
        },
      },
    });
    expect(await facts()).toEqual([]);
    const response = await app.request("/api/sessions/s1/plugins/support", {
      method: "PUT",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).worldData).toMatchObject({
      receivers: [NOTES],
      imported: 2,
    });
    expect(await facts()).toEqual(["gate", "rain"]);
  });

  it("leaves other plugins' imported rows alone", async () => {
    registry.register(
      await entry(worldsDir, "other-notes", "builtin", ["facts"]),
    );
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "s1",
        worldId: "notes-world",
        plugins: [NOTES, "other-notes"],
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    // The builtin receiver got the data; there is nothing to report.
    expect(
      ((await created.json()) as { worldDataNotices?: unknown })
        .worldDataNotices,
    ).toBeUndefined();
    const ledger = await store.listWorldDataImportLedger("s1");
    expect(ledger.map((row) => row.pluginId)).toEqual([
      "other-notes",
      "other-notes",
    ]);
    await change("other-notes", "gate", "The gate is open.");

    const { worldData } = await enable();
    expect(worldData).toMatchObject({
      receivers: [NOTES],
      imported: 2,
      conflicts: 0,
    });
    // The other receiver keeps its rows, changed or not, and their ledger.
    expect(
      (await store.listPluginData("s1", "other-notes", "facts")).map(
        (row) => row.key,
      ),
    ).toEqual(["gate", "rain"]);
    expect(
      (await store.listWorldDataImportLedger("s1")).filter(
        (row) => row.pluginId === "other-notes",
      ),
    ).toHaveLength(2);
    expect(await facts()).toEqual(["gate", "rain"]);
    expect(
      (await store.getPluginData("s1", "other-notes", "facts", "gate"))?.value,
    ).toEqual({ id: "gate", content: "The gate is open." });
  });
});
