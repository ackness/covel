import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRpcApprovalGate } from "@covel/approval";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { discoverPlugins, loadPluginDefinition } from "@covel/plugin-loader";
import { createSqliteStore } from "@covel/store/sqlite";
import { worldDataSelectionScenario } from "../helpers/world-data-selection-scenario.js";
import { datasetWriteFixture } from "../helpers/dataset-write-fixture.js";
import { makeErrorHandler } from "../../src/api-error.js";
import {
  bootstrapApi,
  type ApiBootstrapResult,
} from "../../src/routes/api/bootstrap.js";
import { closeTestApi } from "../helpers/close-api.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { worldPluginPlanRoutes } from "../../src/routes/api/worlds/plugin-plan.js";
import { worldDataSyncRoutes } from "../../src/routes/api/worlds/data-sync.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { validateWorldPackage } from "../../src/world-data/validate-world-package.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";
import { loadSingleWorld } from "../../src/world-seed-loader.js";
import { inventoryWorldData } from "../../src/world-data/requirements.js";
import type { WorldPluginPlan } from "@covel/shared";

async function fixture() {
  const f = await datasetWriteFixture();
  const store = createMemoryStore();
  const gate = createRpcApprovalGate();
  const mediaStore = createMemoryMediaStore();
  const lock = createInProcessSessionLock();
  let atLock = async () => {};
  await store.createWorld({
    id: f.options.worldId,
    name: "Notes",
    description: "Notes",
    createdAt: f.options.now,
  });
  const app = new Hono();
  app.onError(makeErrorHandler("[world-data-selection]", true));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", f.registry);
    c.set("worldsDirs", f.options.worldsDirs);
    c.set("mediaStore", mediaStore);
    c.set("covelHome", f.root);
    c.set("rpcApprovalGate", gate);
    c.set("activatePluginServerCode", async () => {});
    c.set("sessionLock", {
      ...lock,
      withLock: async (id, run) => {
        await atLock();
        return lock.withLock(id, run);
      },
    });
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
  return {
    ...f,
    store,
    gate,
    app,
    post,
    atLock: (callback: () => Promise<void>) => {
      atLock = callback;
    },
    create: () =>
      post("/api/sessions", {
        id: "s",
        worldId: f.options.worldId,
        plugins: [],
      }),
    close: async () => {
      await store.close();
      await f.cleanup();
    },
  };
}

describe("inferred world data through host admission", () => {
  it.each([
    ["memory", createMemoryStore, false],
    ["sqlite", () => createSqliteStore(":memory:"), false],
    ["portable memory", createMemoryStore, true],
    ["portable sqlite", () => createSqliteStore(":memory:"), true],
  ] as const)(
    "activates, imports, defers, retries and rolls back on %s",
    async (_name, create, portable) => {
      const store = create();
      try {
        await worldDataSelectionScenario(store, portable);
      } finally {
        await store.close();
      }
    },
  );

  it("keeps hidden source identities and code sentinels out of all player discovery responses", async () => {
    const f = await fixture();
    try {
      await mkdir(path.join(f.pluginRoot, "server"));
      await writeFile(
        path.join(f.pluginRoot, "server/index.js"),
        'throw new Error("SECRET_EXECUTION");',
      );
      const entry = f.registry.get("probe")!;
      f.registry.register({ ...entry, source: "community" });
      await rm(path.join(f.worldRoot, "data/notes.json"));
      await writeFile(
        path.join(f.worldRoot, "data/SECRET_FILE.json"),
        '[{"id":"SECRET_KEY","text":42}]',
      );
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nname: Notes\nsummary: Notes\ndefaultLocale: en-US\nworldData: descriptor.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "descriptor.yaml"),
        "sources:\n  secret-source-sentinel:\n    kind: json\n    path: data/SECRET_FILE.json\n    to: contract:probe.notes@1\n    visibility: hidden\n    key: id\n",
      );
      const author = await validateWorldPackage({
        worldDir: f.worldRoot,
        catalogue: f.registry,
      });
      // The installed author's surface retains actionable source locations.
      expect(JSON.stringify(author)).toContain("secret-source-sentinel");
      await writeFile(
        path.join(f.worldRoot, "data/SECRET_FILE.json"),
        '[{"id":"SECRET_KEY","text":"SECRET_VALUE"}]',
      );
      for (const response of [
        await f.app.request(`/api/worlds/${f.options.worldId}/plugin-plan`),
        await f.post(`/api/worlds/${f.options.worldId}/world-data/preflight`, {
          plugins: [],
        }),
        await f.create(),
      ]) {
        expect(response.status).toBeLessThan(300);
        expect(await response.text()).not.toMatch(
          /SECRET|secret-source-sentinel/,
        );
      }
      expect(
        await f.store.listPluginData("s", "probe", "_hidden.notes"),
      ).toEqual([]);
      const pending = await f.app.request("/api/sessions/s/plugins/probe", {
        method: "PUT",
      });
      expect(pending.status).toBe(202);
      const approval = (await pending.json()) as { approvalId: string };
      f.gate.decide(
        {
          approvalId: approval.approvalId,
          decision: "allow",
          scope: "session",
          decidedAt: f.options.now,
        },
        sessionApprovalScope((await f.store.getSession("s"))!, "probe"),
      );
      expect(
        (
          await f.app.request("/api/sessions/s/plugins/probe", {
            method: "PUT",
          })
        ).status,
      ).toBe(200);
      expect(
        await f.store.listPluginData("s", "probe", "_hidden.notes"),
      ).toHaveLength(1);
      await f.records([{ id: "new", text: "after revocation" }]);
      f.atLock(async () => {
        f.gate.revoke("s", "probe");
      });
      const revoked = await f.post(
        `/api/worlds/${f.options.worldId}/sync-data`,
        { sessionId: "s", dryRun: false },
      );
      expect(revoked.status).toBe(409);
      expect(await f.store.listPluginData("s", "probe", "notes")).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it.each(["file", "catalogue", "world record", "override", "package removal"])(
    "rejects creation when its captured %s changes before application",
    async (change) => {
      const f = await fixture();
      try {
        f.atLock(async () => {
          if (change === "file")
            await f.records([
              { id: "new", text: "changed during preparation" },
            ]);
          else if (change === "catalogue")
            f.registry.register({ ...f.registry.get("probe")! });
          else if (change === "world record")
            await f.store.upsertWorld({
              ...(await f.store.getWorld(f.options.worldId))!,
              name: "Updated world",
            });
          else {
            const overrideRoot = path.join(
              f.root,
              "world-overrides",
              f.options.worldId,
            );
            await mkdir(overrideRoot, { recursive: true });
            await writeFile(
              path.join(overrideRoot, "world.data.override.yaml"),
              "sources: {}\n",
            );
          }
        });
        const response = await f.create();
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "world_data_create_plan_stale",
        });
        expect(await f.store.getSession("s")).toBeNull();
        expect(await f.store.listWorldDataImportLedger("s")).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it.each(["mistport", "haruka-academy", "emberback", "lantern-barrow"])(
    "imports %s content using real declarations after redundant requests are removed",
    async (worldId) => {
      const f = await fixture();
      const repo = path.resolve(import.meta.dirname, "../../../..");
      try {
        f.options.worldsDirs[0] = path.join(repo, "worlds");
        for (const discovery of await discoverPlugins(
          path.join(repo, "plugins"),
        )) {
          const definition = await loadPluginDefinition(discovery);
          f.registry.register({
            id: discovery.id,
            source: "builtin",
            rootPath: discovery.rootPath,
            ...definition,
            loadedRuntimes: new Map(),
            status: "registered",
            summary: {
              id: discovery.id,
              name: discovery.id,
              description: "",
              kind: definition.packageManifest.plugin.kind ?? "plugin",
              runtimeCount: definition.manifests.length,
            },
          });
        }
        const world = await loadSingleWorld(path.join(repo, "worlds", worldId));
        if (!world) throw new Error("Bundled world fixture missing");
        await f.store.upsertWorld(world);
        const inventory = await inventoryWorldData({
          world,
          worldId,
          worldsDirs: f.options.worldsDirs,
          registry: f.registry,
          locale: world.locale,
        });
        expect(inventory.requiredDataContracts).toEqual(
          expect.arrayContaining([
            "story.events@1",
            "character.blueprints@1",
            "world.rules@1",
            "world.time-definition@1",
          ]),
        );
        expect(inventory.requiredContracts).toContain("world.dimensions@1");
        const plan = (await (
          await f.app.request(`/api/worlds/${worldId}/plugin-plan`)
        ).json()) as WorldPluginPlan;
        const response = await f.post("/api/sessions", {
          id: worldId,
          worldId,
          plugins: plan.defaultPluginIds,
        });
        expect(response.status, await response.clone().text()).toBe(201);
        const session = (await f.store.getSession(worldId))!;
        expect({
          requiredContracts: plan.selection.requiredContracts,
          requiredDataContracts: inventory.requiredDataContracts,
          activePlugins: [...session.activePlugins].sort(),
        }).toMatchSnapshot();
        expect(session.activePlugins).toEqual(
          expect.arrayContaining(["character-blueprint", "story-events"]),
        );
        // The fact extractor is an ordinary dependency of selected gameplay.
        expect(session.activePlugins).toContain("world-ir");
        expect((await f.store.listCharacters(worldId)).length).toBeGreaterThan(
          0,
        );
        for (const contract of inventory.requiredDataContracts) {
          const receivers = [...f.registry.getAll()]
            .filter(([id]) => session.activePlugins.includes(id))
            .flatMap(([id, entry]) =>
              Object.entries(
                entry.packageManifest?.plugin.contributes?.data ?? {},
              )
                .filter(([, data]) => data.accepts?.includes(contract))
                .map(([namespace]) => ({ id, namespace })),
            );
          expect(receivers.length, contract).toBeGreaterThan(0);
          for (const receiver of receivers) {
            const hidden = inventory.sources.some(
              (source) => source.hidden && source.contracts.includes(contract),
            );
            const rows = await f.store.listPluginData(
              worldId,
              receiver.id,
              hidden ? `_hidden.${receiver.namespace}` : receiver.namespace,
            );
            expect(rows.length, `${worldId}: ${contract}`).toBeGreaterThan(0);
          }
        }
        if (worldId === "lantern-barrow")
          expect(plan.selection.requiredContracts).toContain("action-check@1");
      } finally {
        await f.close();
      }
    },
  );
});

it.each([[[]], [["probe"]], [["probe", "other"]]])(
  "requires an explicit receiver choice for ambiguity and preserves intentional fanout: %j",
  async (requested) => {
    const f = await fixture();
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
      const response = await f.post("/api/sessions", {
        id: "choice",
        worldId: f.options.worldId,
        plugins: requested,
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const body = await response.json();
      expect((await f.store.getSession("choice"))?.activePlugins).toEqual(
        requested,
      );
      for (const plugin of ["probe", "other"])
        expect(
          await f.store.listPluginData("choice", plugin, "notes"),
        ).toHaveLength(requested.includes(plugin) ? 2 : 0);
      if (requested.length === 0)
        expect(body.worldDataNotices).toEqual([
          expect.objectContaining({ code: "receiver-ambiguous" }),
        ]);
    } finally {
      await f.close();
    }
  },
);

it("does not import into a publisher whose acceptance was removed", async () => {
  const f = await fixture();
  try {
    const original = f.registry.get("probe")!;
    f.registry.register({
      ...original,
      packageManifest: {
        ...original.packageManifest!,
        plugin: {
          ...original.packageManifest!.plugin,
          contributes: {
            ...original.packageManifest!.plugin.contributes,
            data: {},
          },
        },
      },
    });
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1\n",
    );
    const response = await f.create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await response.json()).toMatchObject({
      activePlugins: [],
      worldDataNotices: [{ code: "receiver-missing" }],
    });
    expect(await f.store.listPluginData("s", "probe", "notes")).toEqual([]);
    expect(
      (await f.store.listWorldDataImportLedger("s")).filter(
        (row) => row.pluginId === "probe",
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
});

it("infers fields in every character source and preserves only their unreceived contract rows", async () => {
  const f = await fixture();
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
            ...entry.packageManifest!.plugin.contributes,
            data: {
              notes: {
                ...data,
                authoring: { title: "Notes", characterField: "notes" },
              },
            },
          },
        },
      },
    });
    await rm(path.join(f.worldRoot, "data/notes.json"));
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  extra:\n    kind: json\n    path: characters/extra.json\n    to: characters\n    key: id\n",
    );
    await writeFile(
      path.join(f.worldRoot, "characters/extra.json"),
      JSON.stringify([
        {
          id: "second",
          name: "Second",
          type: "npc",
          notes: { id: "second", text: "Only in the second source" },
        },
      ]),
    );
    const response = await f.create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await f.store.getSession("s"))?.activePlugins).toEqual(["probe"]);
    const rows = await f.store.listPluginData("s", "probe", "notes");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("second");
    expect(
      (await f.store.listCharacters("s")).map((row) => row.id).sort(),
    ).toEqual(["hero", "second"]);
    expect(
      (
        await f.app.request("/api/sessions/s/plugins/probe", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.post(`/api/worlds/${f.options.worldId}/sync-data`, {
          sessionId: "s",
          dryRun: false,
        })
      ).status,
    ).toBe(200);
    expect(await f.store.listPluginData("s", "probe", "notes")).toEqual(rows);
  } finally {
    await f.close();
  }
});

it("commits an opening and player story with exactly one notice for unavailable optional data", async () => {
  const f = await fixture();
  let boot: ApiBootstrapResult | undefined;
  try {
    const builtin = path.join(f.root, "builtin");
    await mkdir(path.join(builtin, "story"), { recursive: true });
    await writeFile(
      path.join(builtin, "story/PLUGIN.md"),
      "---\nid: story\ndescription: Story\nruntime:\n  schedule: { stage: narrative }\n  io:\n    visibility: story\n    output: { contract: narrative-engine@2 }\n---\nTell the story.\n",
    );
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:unavailable.notes@1\n",
    );
    boot = await bootstrapApi({
      pluginsDir: builtin,
      worldsDirs: f.options.worldsDirs,
      store: f.store,
      storeBackend: "memory",
      llmAdapter: {
        generate: async () => ({
          content: JSON.stringify({
            segments: [{ kind: "narration", text: "The lamp holds." }],
            cues: { present: [] },
          }),
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
    });
    const post = (url: string, body: unknown) =>
      boot!.app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post("/api/sessions", {
      id: "playable",
      worldId: f.options.worldId,
      plugins: ["story"],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({
      activePlugins: ["story"],
      worldDataNotices: [{ code: "receiver-missing" }],
    });
    for (const [type, payload] of [
      ["start_session", {}],
      [
        "submit_actions",
        { actions: [{ kind: "say", text: "I tend the lamp." }] },
      ],
    ] as const) {
      const response = await post("/api/actions", {
        requestId: crypto.randomUUID(),
        sessionId: "playable",
        type,
        payload,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await response.text();
      expect(
        (await f.store.listTurnResults("playable")).at(-1)?.commitStatus,
      ).toBe("committed");
    }
    expect((await f.store.getSession("playable"))?.completedPlayerTurns).toBe(
      1,
    );
    expect(await f.store.listPluginData("playable", "probe", "notes")).toEqual(
      [],
    );
    expect(
      (await f.store.listWorldDataImportLedger("playable")).filter(
        (row) => row.pluginId,
      ),
    ).toEqual([]);
  } finally {
    await closeTestApi(boot);
    await f.close();
  }
});

it("uses current static code classification and real consent before activating an inferred community receiver", async () => {
  const f = await fixture();
  let boot: ApiBootstrapResult | undefined;
  try {
    const builtin = path.join(f.root, "builtin");
    await mkdir(builtin);
    const sentinel = path.join(f.root, "executed.txt");
    await mkdir(path.join(f.pluginRoot, "server"));
    await writeFile(
      path.join(f.pluginRoot, "server/index.js"),
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(sentinel)}, "executed"); export default () => {};`,
    );
    boot = await bootstrapApi({
      pluginsDir: builtin,
      pluginsDirs: [builtin, f.root],
      worldsDirs: f.options.worldsDirs,
      store: f.store,
      storeBackend: "memory",
      llmAdapter: {
        generate: async () => {
          throw new Error("No model call expected");
        },
      },
    });
    const post = (url: string, body: unknown) =>
      boot!.app.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    await validateWorldPackage({
      worldDir: f.worldRoot,
      catalogue: boot.registry,
    });
    for (const response of [
      await boot.app.request(`/api/worlds/${f.options.worldId}/plugin-plan`),
      await post(`/api/worlds/${f.options.worldId}/world-data/preflight`, {
        plugins: [],
      }),
    ])
      expect(response.status, await response.clone().text()).toBe(200);
    const created = await post("/api/sessions", {
      id: "consent",
      worldId: f.options.worldId,
      plugins: [],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    expect(await created.json()).toMatchObject({
      activePlugins: [],
      worldDataNotices: [{ code: "receiver-approval-required" }],
    });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await f.store.listPluginData("consent", "probe", "notes")).toEqual(
      [],
    );
    const pending = await boot.app.request(
      "/api/sessions/consent/plugins/probe",
      { method: "PUT" },
    );
    expect(pending.status, await pending.clone().text()).toBe(202);
    const { approvalId } = await pending.json();
    const approved = await post(`/api/approvals/${approvalId}/decision`, {
      decision: "allow",
      scope: "session",
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect(
      (
        await boot.app.request("/api/sessions/consent/plugins/probe", {
          method: "PUT",
        })
      ).status,
    ).toBe(200);
    expect(await readFile(sentinel, "utf8")).toBe("executed");
    expect(
      await f.store.listPluginData("consent", "probe", "notes"),
    ).toHaveLength(2);
  } finally {
    await closeTestApi(boot);
    await f.close();
  }
});

it("redacts hidden validation failures from complete preflight and development create responses", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.worldRoot, "world.yaml"),
      "id: dataset-world\nworldData: descriptor.yaml\n",
    );
    await writeFile(
      path.join(f.worldRoot, "descriptor.yaml"),
      "sources:\n  secret-source:\n    kind: json\n    path: data/SECRET_FILE.json\n    to: contract:probe.notes@1\n    visibility: hidden\n    key: id\n",
    );
    await rm(path.join(f.worldRoot, "data/notes.json"));
    await writeFile(
      path.join(f.worldRoot, "data/SECRET_FILE.json"),
      '[{"id":"SECRET_KEY","text":42}]',
    );
    const preflight = await f.post(
      `/api/worlds/${f.options.worldId}/world-data/preflight`,
      { plugins: [] },
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.text()).not.toMatch(/SECRET|secret-source/);
    const created = await f.create();
    expect(created.status).toBe(500);
    const body = await created.text();
    expect(body).toContain("world_data_import_failed");
    expect(body).not.toMatch(/SECRET|secret-source/);
    expect(await f.store.getSession("s")).toBeNull();
    expect(await f.store.listWorldDataImportLedger("s")).toEqual([]);
  } finally {
    await f.close();
  }
});

it("admits an effective override source even when the package has no conventional data", async () => {
  const f = await fixture();
  try {
    await rm(path.join(f.worldRoot, "data"), { recursive: true });
    await rm(path.join(f.worldRoot, "characters"), { recursive: true });
    const overrideRoot = path.join(
      f.root,
      "world-overrides",
      f.options.worldId,
    );
    await mkdir(overrideRoot, { recursive: true });
    await writeFile(
      path.join(overrideRoot, "world.data.override.yaml"),
      "sources:\n  notes:\n    kind: json\n    path: notes.json\n    to: contract:probe.notes@1\n    key: id\n",
    );
    await writeFile(
      path.join(overrideRoot, "notes.json"),
      '[{"id":"override","text":"From the effective override"}]',
    );
    const preflight = await f.post(
      `/api/worlds/${f.options.worldId}/world-data/preflight`,
      { plugins: [] },
    );
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    expect(await preflight.json()).toMatchObject({
      planned: 1,
      diagnostics: [],
    });
    const response = await f.create();
    expect(response.status, await response.clone().text()).toBe(201);
    expect((await f.store.getSession("s"))?.activePlugins).toEqual(["probe"]);
    expect(await f.store.listPluginData("s", "probe", "notes")).toEqual([
      expect.objectContaining({ key: "override" }),
    ]);
  } finally {
    await f.close();
  }
});

it("does not silently replace a disabled receiver during an unrelated live enable", async () => {
  const f = await fixture();
  try {
    expect((await f.create()).status).toBe(201);
    expect(
      (
        await f.app.request("/api/sessions/s/plugins/probe", {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    const original = f.registry.get("probe")!;
    f.registry.register({
      ...original,
      id: "new-receiver",
      packageManifest: {
        ...original.packageManifest!,
        plugin: { ...original.packageManifest!.plugin, id: "new-receiver" },
      },
    });
    f.registry.register({
      ...original,
      id: "unrelated",
      packageManifest: {
        ...original.packageManifest!,
        plugin: {
          ...original.packageManifest!.plugin,
          id: "unrelated",
          contributes: {},
        },
      },
    });
    const response = await f.app.request("/api/sessions/s/plugins/unrelated", {
      method: "PUT",
    });
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await f.store.getSession("s"))?.activePlugins).toEqual([
      "unrelated",
    ]);
    expect(await f.store.listPluginData("s", "new-receiver", "notes")).toEqual(
      [],
    );
    expect(await f.store.listPluginData("s", "probe", "notes")).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it("keeps conventional data deferred when a valid receiver declaration cannot execute", async () => {
  const f = await fixture();
  try {
    expect((await f.create()).status).toBe(201);
    const rows = await f.store.listPluginData("s", "probe", "notes");
    const ledger = await f.store.listWorldDataImportLedger("s");
    f.registry.register({
      ...f.registry.get("probe")!,
      status: "error",
      error: "Receiver execution unavailable",
    });
    const response = await f.post(
      `/api/worlds/${f.options.worldId}/sync-data`,
      { sessionId: "s", dryRun: false },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await f.store.listPluginData("s", "probe", "notes")).toEqual(rows);
    expect(await f.store.listWorldDataImportLedger("s")).toEqual(ledger);
  } finally {
    await f.close();
  }
});
