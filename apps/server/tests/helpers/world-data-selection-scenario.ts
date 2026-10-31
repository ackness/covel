import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { expect, vi } from "vitest";
import { createRpcApprovalGate } from "@covel/approval";
import type { DataStore } from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";
import { worldDataSyncRoutes } from "../../src/routes/api/worlds/data-sync.js";
import { datasetWriteFixture } from "./dataset-write-fixture.js";
import { createWorld } from "@covel/create";
import { createPluginRegistry } from "@covel/plugin-loader";
import { registerDimensionProvider } from "./dimension-provider.js";
import { worldRecordFromManifest } from "../../src/world-data/world-record.js";
import { worldCrudRoutes } from "../../src/routes/api/worlds/crud.js";

/** Portable generation uses the same validated definitions on every backend. */
export async function portableDimensionSelectionScenario(store: DataStore) {
  const definition = (initialValue: number) => ({
    name: "Alarm",
    schema: { type: "integer" as const },
    initialValue,
  });
  const generated = await createWorld({
    concept: "Harbor",
    locale: "en-US",
    llm: {
      async generate() {
        return {
          content: `===WORLD_YAML===\nid: portable-dimensions\nname: Harbor\nsummary: Guard the harbor.\ndefaultLocale: en-US\n===WORLD_MD===\n# Harbor\n1. Guard.\n2. Watch.\n3. Wait.\n===WORLD_PACKAGE_YAML===\n${JSON.stringify({ dimensions: { alarm: definition(17) } })}\n===END===`,
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    },
  });
  if (!generated.success) throw new Error(generated.errors.join("; "));
  expect(generated.manifest).not.toHaveProperty("dimensions");
  await store.upsertWorld(
    worldRecordFromManifest(generated.manifest, generated.lore, {
      dimensions: generated.packageContent.dimensions,
    }),
  );
  const registry = createPluginRegistry();
  await registerDimensionProvider(registry, "builtin");
  const app = new Hono();
  const lock = createInProcessSessionLock();
  const gate = createRpcApprovalGate();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("sessionLock", lock);
    c.set("rpcApprovalGate", gate);
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/worlds", worldCrudRoutes);
  app.route("/api/worlds", worldDataSyncRoutes);
  app.route("/api/sessions", sessionRoutes);
  const post = (url: string, body: unknown, method = "POST") =>
    app.request(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const created = await post("/api/sessions", {
    id: "portable-dimension-session",
    worldId: generated.id,
    plugins: ["world-init"],
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const rows = () =>
    store.listPluginData(
      "portable-dimension-session",
      "world-init",
      "_dimensions",
    );
  expect(await rows()).toMatchObject([
    { key: "alarm", value: { value: 17, version: 1 } },
  ]);
  const beforeLedger = await store.listWorldDataImportLedger(
    "portable-dimension-session",
  );
  expect(beforeLedger).toHaveLength(1);
  expect(
    (
      await post(
        `/api/worlds/${generated.id}`,
        { dimensions: { alarm: definition(23) } },
        "PATCH",
      )
    ).status,
  ).toBe(200);
  const sync = (dryRun: boolean) =>
    post(`/api/worlds/${generated.id}/sync-data`, {
      sessionId: "portable-dimension-session",
      dryRun,
    });
  expect((await sync(true)).status).toBe(200);
  expect(await rows()).toMatchObject([{ value: { value: 17 } }]);
  expect(
    await store.listWorldDataImportLedger("portable-dimension-session"),
  ).toEqual(beforeLedger);
  expect((await sync(false)).status).toBe(200);
  expect(await rows()).toMatchObject([{ value: { value: 23 } }]);
}

/** The same route/transaction expectations for every supported store. */
export async function worldDataSelectionScenario(
  store: DataStore,
  portable = false,
) {
  const f = await datasetWriteFixture();
  const app = new Hono();
  const gate = createRpcApprovalGate();
  const lock = createInProcessSessionLock();
  app.onError(makeErrorHandler("[world-data-selection]", false));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", f.registry);
    c.set("worldsDirs", portable ? [] : f.options.worldsDirs);
    c.set("sessionLock", lock);
    c.set("rpcApprovalGate", gate);
    c.set("activatePluginServerCode", async () => {});
    await next();
  });
  app.route("/api/worlds", worldPluginPlanRoutes);
  app.route("/api/worlds", worldDataSyncRoutes);
  app.route("/api/sessions", sessionRoutes);
  const post = (url: string, body: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const create = (id: string, excludedPlugins: string[] = []) =>
    post("/api/sessions", {
      id,
      worldId: f.options.worldId,
      plugins: [],
      excludedPlugins,
    });
  const sync = (id: string) =>
    post(`/api/worlds/${f.options.worldId}/sync-data`, {
      sessionId: id,
      dryRun: false,
    });
  try {
    await store.createWorld({
      id: f.options.worldId,
      name: "Notes",
      description: "Notes",
      locale: "en-US",
      ...(portable
        ? {
            metadata: {
              contractData: ["a", "b"].map((key) => ({
                contract: "probe.notes@1",
                key,
                value: { id: key, text: "before" },
              })),
              embeddedCharacters: [{ id: "hero", name: "Hero", type: "npc" }],
            },
          }
        : {}),
      createdAt: f.options.now,
    });
    const plan = await app.request(
      `/api/worlds/${f.options.worldId}/plugin-plan`,
    );
    expect(plan.status).toBe(200);
    expect(await plan.json()).toMatchObject({
      selection: {
        requestedPluginIds: [],
        requiredDataContracts: ["probe.notes@1"],
      },
    });
    const preflight = await post(
      `/api/worlds/${f.options.worldId}/world-data/preflight`,
      { plugins: [] },
    );
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    expect(await preflight.json()).toMatchObject({
      planned: portable ? 3 : 4,
      diagnostics: [],
    });
    const created = await create("inferred");
    expect(created.status, await created.clone().text()).toBe(201);
    expect((await store.getSession("inferred"))?.activePlugins).toEqual([
      "probe",
    ]);
    expect(
      (await store.getSession("inferred"))?.metadata?.pluginSelection,
    ).toMatchObject({ requiredDataContracts: ["probe.notes@1"] });
    expect(
      await store.listPluginData("inferred", "probe", "notes"),
    ).toHaveLength(2);
    expect(await store.listWorldDataImportLedger("inferred")).toHaveLength(
      portable ? 3 : 4,
    );

    const off = await create("excluded", ["probe"]);
    expect(off.status, await off.clone().text()).toBe(201);
    expect(await off.json()).toMatchObject({
      worldDataNotices: [{ code: "receiver-excluded" }],
    });
    expect((await store.getSession("excluded"))?.activePlugins).toEqual([]);
    expect(await store.listPluginData("excluded", "probe", "notes")).toEqual(
      [],
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const enabled = await app.request(
        "/api/sessions/excluded/plugins/probe",
        { method: "PUT" },
      );
      expect(enabled.status, await enabled.clone().text()).toBe(200);
    }
    expect(
      await store.listPluginData("excluded", "probe", "notes"),
    ).toHaveLength(2);
    expect(
      (await store.listWorldDataImportLedger("excluded")).filter(
        (row) => row.pluginId === "probe",
      ),
    ).toHaveLength(2);

    const beforeRows = await store.listPluginData("inferred", "probe", "notes");
    const beforeLedger = await store.listWorldDataImportLedger("inferred");
    expect(
      (
        await app.request("/api/sessions/inferred/plugins/probe", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    const deferred = await sync("inferred");
    expect(deferred.status, await deferred.clone().text()).toBe(200);
    expect(await store.listPluginData("inferred", "probe", "notes")).toEqual(
      beforeRows,
    );
    expect(await store.listWorldDataImportLedger("inferred")).toEqual(
      beforeLedger,
    );
    expect(
      (
        await app.request("/api/sessions/inferred/plugins/probe", {
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect((await sync("inferred")).status).toBe(200);
    expect(
      await store.listPluginData("inferred", "probe", "notes"),
    ).toHaveLength(2);

    // Inject at the real transactional ledger boundary, after record writes.
    const originalTransaction = store.withTransaction.bind(store);
    const injected = vi.spyOn(store, "withTransaction").mockImplementation(
      (run) =>
        originalTransaction((tx) =>
          run(
            new Proxy(tx, {
              get(target, property) {
                if (property === "saveWorldDataImportLedgerBatch")
                  return async () => {
                    throw new Error("injected ledger refusal");
                  };
                const value: unknown = Reflect.get(target, property);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ) as ReturnType<DataStore["withTransaction"]>,
    );
    try {
      const refused = await create("rolled-back");
      expect(refused.status).toBe(500);
      expect(await store.getSession("rolled-back")).toBeNull();
      expect(
        await store.listPluginData("rolled-back", "probe", "notes"),
      ).toEqual([]);
      expect(await store.listWorldDataImportLedger("rolled-back")).toEqual([]);
      expect(await store.listCharacters("rolled-back")).toEqual([]);
      expect(await store.listSessionLorebookEntries("rolled-back")).toEqual([]);
    } finally {
      injected.mockRestore();
    }
    // A schema publisher remains available, but no longer accepts the data.
    const receiver = f.registry.get("probe")!;
    f.registry.register({
      ...receiver,
      packageManifest: {
        ...receiver.packageManifest!,
        plugin: {
          ...receiver.packageManifest!.plugin,
          contributes: {
            ...receiver.packageManifest!.plugin.contributes,
            data: {},
          },
        },
      },
    });
    if (!portable) {
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nworldData: descriptor.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "descriptor.yaml"),
        "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1\n",
      );
    }
    const unavailable = await create("unavailable");
    expect(unavailable.status, await unavailable.clone().text()).toBe(201);
    expect(await unavailable.json()).toMatchObject({
      activePlugins: [],
      worldDataNotices: [{ code: "receiver-missing" }],
    });
    expect(await store.listPluginData("unavailable", "probe", "notes")).toEqual(
      [],
    );
    expect(
      (await store.getSession("unavailable"))?.metadata?.pluginSelection,
    ).toMatchObject({ requiredDataContracts: ["probe.notes@1"] });
  } finally {
    await f.cleanup();
  }
}
