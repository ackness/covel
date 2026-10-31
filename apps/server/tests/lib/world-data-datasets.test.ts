import { Hono } from "hono";
import { createRpcApprovalGate } from "@covel/approval";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { discoverPluginAt, loadPluginDefinition } from "@covel/plugin-loader";
import {
  applyPreparedWorldDataImportForSession,
  preflightWorldDataForSession,
  prepareWorldDataImportForSession,
  syncWorldDataForSession,
  releaseWorldDataMediaRefs,
} from "../../src/world-data/session-import.js";
import { buildImportPlan } from "../../src/world-data/session-import/planning.js";
import { writeImportPlan } from "../../src/world-data/session-import/writes.js";
import { datasetBackendScenario } from "../helpers/dataset-backend-scenarios.js";
import {
  datasetWriteFixture,
  RECORD_SCHEMA,
} from "../helpers/dataset-write-fixture.js";
import {
  makePlugin,
  makeSource,
  registry,
  VALID_WORLD_IR,
  WORLD_IR_SCHEMA,
} from "./world-data-projection-fixtures.js";

afterEach(() => vi.restoreAllMocks());

describe("world dataset destination enforcement", () => {
  it.each([
    ["memory", createMemoryStore],
    ["sqlite", () => createSqliteStore(":memory:")],
  ] as const)(
    "preserves atomic import and sync rules on %s",
    async (_name, create) => {
      const store = create();
      try {
        await datasetBackendScenario(store);
      } finally {
        await store.close();
      }
    },
  );

  it.each([
    ["memory", createMemoryStore],
    ["sqlite", () => createSqliteStore(":memory:")],
  ] as const)(
    "treats lorebook target changes as set-only replacements on %s while refusing true removals",
    async (_name, create) => {
      const f = await datasetWriteFixture();
      const store = create();
      try {
        f.policy(["set"]);
        await writeFile(
          path.join(f.worldRoot, "world.yaml"),
          "id: dataset-world\nname: Dataset World\nsummary: Fixture\ndefaultLocale: en-US\nworldData: data/world.data.yaml\n",
        );
        const setTarget = (lorebook: boolean) =>
          writeFile(
            path.join(f.worldRoot, "data/world.data.yaml"),
            `sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1${lorebook ? "+lorebook" : ""}\n    key: id\n`,
          );
        await setTarget(false);
        await f.create(store);
        for (const lorebook of [true, false]) {
          const beforeRows = await f.rows(store);
          const beforeLedger = await store.listWorldDataImportLedger(
            f.options.sessionId,
          );
          const beforeLorebook = await store.listSessionLorebookEntries(
            f.options.sessionId,
          );
          await setTarget(lorebook);
          for (const dryRun of [true, false]) {
            const result = await f.sync(store, { dryRun });
            expect(result).toMatchObject({
              diagnostics: [],
              conflicts: [],
              upserted: lorebook ? 4 : 2,
            });
            if (dryRun) {
              expect(await f.rows(store)).toEqual(beforeRows);
              expect(
                await store.listWorldDataImportLedger(f.options.sessionId),
              ).toEqual(beforeLedger);
              expect(
                await store.listSessionLorebookEntries(f.options.sessionId),
              ).toEqual(beforeLorebook);
            }
          }
          expect((await f.rows(store)).map((row) => row.value)).toEqual(
            beforeRows.map((row) => row.value),
          );
          const noteLedgers = (
            await store.listWorldDataImportLedger(f.options.sessionId)
          ).filter((ledger) => ledger.namespace === "notes");
          expect(noteLedgers).toHaveLength(2);
          expect(noteLedgers).toEqual(
            expect.arrayContaining(
              ["a", "b"].map((key) =>
                expect.objectContaining({
                  pluginId: "probe",
                  key,
                  target: `contract:probe.notes@1${lorebook ? "+lorebook" : ""}`,
                }),
              ),
            ),
          );
          expect(
            (
              await store.listSessionLorebookEntries(f.options.sessionId)
            ).filter((entry) => entry.id.startsWith("notes:")),
          ).toHaveLength(lorebook ? 2 : 0);
        }

        const beforeRows = await f.rows(store);
        const beforeLedger = await store.listWorldDataImportLedger(
          f.options.sessionId,
        );
        const beforeLorebook = await store.listSessionLorebookEntries(
          f.options.sessionId,
        );
        await setTarget(true);
        await f.records([{ id: "a", text: "replacement" }]);
        for (const force of [false, true]) {
          for (const dryRun of [true, false]) {
            const refused = await f.sync(store, { force, dryRun });
            expect(refused).toMatchObject({ upserted: 0, deleted: 0 });
            expect(refused.diagnostics).toEqual([
              expect.objectContaining({
                level: "error",
                message: expect.stringContaining(
                  "operation kind delete is not allowed",
                ),
              }),
            ]);
            expect(await f.rows(store)).toEqual(beforeRows);
            expect(
              await store.listWorldDataImportLedger(f.options.sessionId),
            ).toEqual(beforeLedger);
            expect(
              await store.listSessionLorebookEntries(f.options.sessionId),
            ).toEqual(beforeLorebook);
          }
        }
      } finally {
        await store.close();
        await f.cleanup();
      }
    },
  );

  it("rejects a canonical dataset violation through session creation without publishing any session data", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    try {
      await store.createWorld({
        id: f.options.worldId,
        name: "Dataset world",
        description: "",
        metadata: {
          defaultLocale: "en-US",
          characterSchema: { types: ["npc"], attributes: [] },
        },
        createdAt: f.options.now,
      });
      f.policy(["inc"]);
      const app = new Hono();
      app.onError(makeErrorHandler("[dataset-test]", false));
      const lock = createInProcessSessionLock();
      const gate = createRpcApprovalGate();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("pluginRegistry", f.registry);
        c.set("worldsDirs", f.options.worldsDirs);
        c.set("sessionLock", lock);
        c.set("rpcApprovalGate", gate);
        await next();
      });
      app.route("/api/sessions", sessionRoutes);
      const create = () =>
        app.request("/api/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            id: f.options.sessionId,
            worldId: f.options.worldId,
            locale: "en-US",
            plugins: ["probe"],
          }),
        });
      vi.spyOn(console, "error").mockImplementation(() => {});
      const refused = await create();
      expect(refused.status).toBe(500);
      expect(await store.getSession(f.options.sessionId)).toBeNull();
      expect(await store.getCharacterSchema(f.options.sessionId)).toBeNull();
      expect(await store.listCharacters(f.options.sessionId)).toEqual([]);
      expect(
        await store.listSessionLorebookEntries(f.options.sessionId),
      ).toEqual([]);
      expect(await f.rows(store)).toEqual([]);
      expect(
        await store.listWorldDataImportLedger(f.options.sessionId),
      ).toEqual([]);
      f.policy(["set"]);
      expect((await create()).status).toBe(201);
      expect(await f.rows(store)).toHaveLength(2);
      expect(await store.listCharacters(f.options.sessionId)).toHaveLength(1);
      expect(
        await store.listSessionLorebookEntries(f.options.sessionId),
      ).toHaveLength(1);
    } finally {
      await store.close();
      await f.cleanup();
    }
  });

  it("refuses set in preflight and sync, and retains missing and invalid captured schemas as policies", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    try {
      expect(f.registry.get("probe")?.summary.runtimeCount).toBe(0);
      for (const [schema, expected] of [
        [RECORD_SCHEMA, "operation kind set"],
        [null, "unavailable"],
        [{ type: "invalid" }, "schema is invalid"],
        [
          { type: "object", properties: { text: { const: "different" } } },
          "record does not match",
        ],
      ] as const) {
        f.policy(schema === RECORD_SCHEMA ? ["inc"] : ["set"], schema);
        const preflight = await preflightWorldDataForSession(f.options);
        expect(
          preflight.diagnostics.some((d) => d.message.includes(expected)),
        ).toBe(true);
        expect(JSON.stringify(preflight)).not.toMatch(
          /datasetPolicy|datasetSchemas/,
        );
        await expect(f.create(store)).rejects.toThrow(expected);
        for (const dryRun of [true, false]) {
          const result = await f.sync(store, { dryRun, force: true });
          expect(result).toMatchObject({ upserted: 0, deleted: 0 });
          expect(
            result.diagnostics.some((d) => d.message.includes(expected)),
          ).toBe(true);
        }
        expect(await f.rows(store)).toEqual([]);
      }
      // A namespace with import admission and no dataset keeps its source contract.
      const entry = f.registry.get("probe")!;
      f.registry.register({
        ...entry,
        datasets: {},
        packageManifest: {
          ...entry.packageManifest!,
          manifest: { ...entry.packageManifest!.manifest, datasets: {} },
          plugin: {
            ...entry.packageManifest!.plugin,
            contributes: {
              ...entry.packageManifest!.plugin.contributes,
              datasets: {},
            },
          },
        },
      });
      expect(
        (await preflightWorldDataForSession(f.options)).diagnostics,
      ).toEqual([]);
    } finally {
      await store.close();
      await f.cleanup();
    }
  });

  it("checks portable records and embedded character contract blocks, retaining source locations", async () => {
    const f = await datasetWriteFixture();
    try {
      f.policy(["inc"]);
      const entry = f.registry.get("probe")!;
      const manifest = entry.packageManifest!;
      f.registry.register({
        ...entry,
        packageManifest: {
          ...manifest,
          plugin: {
            ...manifest.plugin,
            contributes: {
              ...manifest.plugin.contributes,
              data: {
                notes: {
                  ...manifest.plugin.contributes!.data!.notes!,
                  authoring: { title: "Notes", characterField: "notes" },
                },
              },
            },
          },
        },
      });
      const options = {
        ...f.options,
        worldsDirs: [],
        world: {
          metadata: {
            contractData: [
              {
                contract: "probe.notes@1",
                key: "portable",
                value: { id: "portable", text: "valid" },
              },
            ],
            embeddedCharacters: [
              {
                id: "hero",
                name: "Hero",
                type: "npc",
                notes: { id: "hero", text: "valid" },
              },
            ],
          },
        },
      };
      const prepared = await prepareWorldDataImportForSession(options);
      expect(prepared.imported).toBe(true);
      expect(
        prepared.diagnostics.filter((d) =>
          d.message.includes("operation kind set"),
        ),
      ).toHaveLength(2);
      expect(prepared.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pointer: "[0].notes",
            sourceId: "characters",
          }),
        ]),
      );
    } finally {
      await f.cleanup();
    }
  });

  it("validates hidden records at their physical namespace and keeps unavailable receivers deferred", async () => {
    const f = await datasetWriteFixture();
    try {
      f.policy(["inc"]);
      const source = {
        id: "hidden",
        descriptor: {
          kind: "json" as const,
          path: "notes.json",
          to: "contract:probe.notes@1",
          key: "id",
          visibility: "hidden" as const,
        },
        order: 0,
        resolvedOrder: 0,
        origin: "world" as const,
        overridden: false,
        pathOrigin: { descriptorRoot: f.worldRoot, origin: "world" as const },
        inlineValue: [{ id: "secret", text: "private" }],
      };
      const hidden = await buildImportPlan({
        ...f.options,
        sources: [source],
        deps: f.options.preflight,
      });
      expect(hidden.diagnostics).toEqual([]);
      expect(hidden.writes).toEqual([
        expect.objectContaining({ namespace: "_hidden.notes", key: "secret" }),
      ]);
      const publicPlan = await buildImportPlan({
        ...f.options,
        sources: [
          {
            ...source,
            descriptor: { ...source.descriptor, visibility: "public" },
          },
        ],
        deps: f.options.preflight,
      });
      expect(publicPlan.diagnostics.some((d) => d.level === "error")).toBe(
        true,
      );
      const inactive = await buildImportPlan({
        ...f.options,
        sources: [source],
        deps: { ...f.options.preflight, activePlugins: [] },
      });
      expect(inactive.diagnostics.every((d) => d.level === "warning")).toBe(
        true,
      );
      expect(inactive.writes).toEqual([]);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves nonselected and unavailable receivers and permits cleanup of an already-absent target", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    try {
      f.policy(["set"]);
      await f.create(store);
      const before = await f.rows(store);
      const beforeLedger = await store.listWorldDataImportLedger(
        f.options.sessionId,
      );
      await f.records([]);
      expect(await f.sync(store, { receivers: ["other"] })).toMatchObject({
        upserted: 0,
        deleted: 0,
      });
      expect(await f.rows(store)).toEqual(before);
      expect(
        await store.listWorldDataImportLedger(f.options.sessionId),
      ).toEqual(beforeLedger);
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nname: Dataset World\nsummary: Fixture\ndefaultLocale: en-US\nworldData: data/world.data.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "data/world.data.yaml"),
        "sources:\n  notes:\n    kind: json\n    path: data/notes.json\n    to: contract:probe.notes@1\n    key: id\n",
      );
      const unavailable = await f.sync(store, {
        preflight: { registry: f.registry, activePlugins: [] },
      });
      expect(unavailable.deleted).toBe(0);
      expect(unavailable.diagnostics.some((d) => d.level === "warning")).toBe(
        true,
      );
      expect(await f.rows(store)).toEqual(before);
      await store.deletePluginData(f.options.sessionId, "probe", "notes", "a");
      await f.records([{ id: "b", text: "before" }]);
      const cleaned = await f.sync(store);
      expect(cleaned.diagnostics).toEqual([]);
      expect(cleaned.deleted).toBe(1);
      expect(
        (await store.listWorldDataImportLedger(f.options.sessionId)).some(
          (l) => l.namespace === "notes" && l.key === "a",
        ),
      ).toBe(false);
    } finally {
      await store.close();
      await f.cleanup();
    }
  });

  it("keeps the captured declaration when the live registry changes and rejects tampered prepared values", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    try {
      const prepared = await f.prepare();
      if (!prepared.imported) throw new Error("Missing plan");
      f.policy(["inc"]);
      await store.withTransaction(async (tx) => {
        await tx.createSession(f.session());
        await applyPreparedWorldDataImportForSession({
          store: tx,
          ...f.options,
          prepared,
        });
      });
      expect(await f.rows(store)).toHaveLength(2);
      const spy = vi.spyOn(store, "setPluginDataBatch");
      const bad = {
        ...prepared,
        diagnostics: [],
        plan: {
          ...prepared.plan,
          diagnostics: [],
          writes: prepared.plan.writes.map((write) => ({
            ...write,
            value: { id: "a", text: false },
          })),
        },
      };
      await expect(
        applyPreparedWorldDataImportForSession({
          store,
          ...f.options,
          prepared: bad,
        }),
      ).rejects.toThrow("record does not match");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      await store.close();
      await f.cleanup();
    }
  });

  it("defers a whole invalid projection output, preserves its managed rows, and accepts a later empty output", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    try {
      const plugin = await makePlugin({
        root: f.root,
        id: "derived",
        handlers: {
          "main.mjs":
            'export default () => ({ notes: [{id:"old",text:"valid"}], other: [{id:"ok",text:"valid"}] });',
        },
        projections: {
          main: {
            from: WORLD_IR_SCHEMA,
            handler: "./handlers/main.mjs",
            outputs: {
              notes: { namespace: "notes", key: "id" },
              other: { namespace: "other", key: "id" },
            },
          },
        },
        namespaces: ["notes", "other"],
      });
      const withPolicy = {
        ...plugin,
        datasets: {
          notes: {
            namespace: "notes",
            schema: "./schemas/notes.schema.json",
            ops: ["set", "delete"] as const,
            tools: [],
          },
        },
        packageManifest: {
          ...plugin.packageManifest!,
          datasetSchemas: { notes: RECORD_SCHEMA },
        },
      };
      const catalogue = registry([withPolicy]);
      const source = await makeSource(VALID_WORLD_IR);
      const build = () =>
        buildImportPlan({
          ...f.options,
          sources: [source],
          deps: { registry: catalogue, activePlugins: ["derived"] },
        });
      await store.createSession(f.session());
      const initial = await build();
      await writeImportPlan({ store, ...f.options, plan: initial });
      const beforeRows = await store.listPluginData(
        f.options.sessionId,
        "derived",
        "notes",
      );
      const beforeLedger = (
        await store.listWorldDataImportLedger(f.options.sessionId)
      ).filter((l) => l.namespace === "notes");
      await writeFile(
        path.join(plugin.rootPath!, "handlers/main.mjs"),
        'export default () => ({ notes: [{id:"new",text:"valid"},{id:"bad",text:9}], other: [{id:"next",text:"valid"}] });',
      );
      const invalid = await build();
      expect(invalid.diagnostics).toEqual([
        expect.objectContaining({
          level: "warning",
          message: expect.stringContaining("record does not match"),
        }),
      ]);
      expect(
        invalid.writes.filter(
          (w) => "namespace" in w && w.namespace === "notes",
        ),
      ).toEqual([]);
      expect(
        invalid.writes.some((w) => "namespace" in w && w.namespace === "other"),
      ).toBe(true);
      await syncWorldDataForSession({
        store,
        ...f.options,
        prepared: {
          imported: true,
          diagnostics: invalid.diagnostics,
          plan: invalid,
        },
      });
      expect(
        await store.listPluginData(f.options.sessionId, "derived", "notes"),
      ).toEqual(beforeRows);
      expect(
        (await store.listWorldDataImportLedger(f.options.sessionId)).filter(
          (l) => l.namespace === "notes",
        ),
      ).toEqual(beforeLedger);
      await writeFile(
        path.join(plugin.rootPath!, "handlers/main.mjs"),
        "export default () => ({ notes: [], other: [] });",
      );
      const empty = await build();
      expect(empty.deferredProjectionOutputs).toEqual([]);
      const synced = await syncWorldDataForSession({
        store,
        ...f.options,
        prepared: {
          imported: true,
          diagnostics: empty.diagnostics,
          plan: empty,
        },
      });
      expect(synced.deleted).toBeGreaterThan(0);
      expect(
        await store.listPluginData(f.options.sessionId, "derived", "notes"),
      ).toEqual([]);
    } finally {
      await store.close();
      await f.cleanup();
    }
  });

  it("defers media record-schema validation until materialization and keeps preflight observational", async () => {
    const f = await datasetWriteFixture();
    const store = createMemoryStore();
    const mediaStore = createMemoryMediaStore();
    try {
      const marker = path.join(f.root, "projection-executed");
      const plugin = await makePlugin({
        root: f.root,
        id: "media-owner",
        namespaces: ["assets"],
        schemaRequired: [],
        handlers: {
          "main.mjs": `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default () => ({ derived: [] });`,
        },
        projections: {
          main: {
            from: WORLD_IR_SCHEMA,
            handler: "./handlers/main.mjs",
            outputs: { derived: { namespace: "assets", key: "id" } },
          },
        },
      });
      const badSchema = {
        type: "object",
        required: ["ref", "filename", "sourceId"],
        properties: { filename: { const: "different.png" } },
      };
      const entry = {
        ...plugin,
        datasets: {
          assets: {
            namespace: "assets",
            schema: "./schemas/assets.schema.json",
            ops: ["set"] as const,
            tools: [],
          },
        },
        packageManifest: {
          ...plugin.packageManifest!,
          datasetSchemas: { assets: badSchema },
        },
      };
      const catalogue = registry([entry]);
      await writeFile(
        path.join(f.worldRoot, "data/portrait.png"),
        new Uint8Array([1, 2, 3]),
      );
      await writeFile(
        path.join(f.worldRoot, "data/ir.json"),
        JSON.stringify(VALID_WORLD_IR),
      );
      await writeFile(
        path.join(f.worldRoot, "world.yaml"),
        "id: dataset-world\nname: Dataset World\nsummary: Fixture\ndefaultLocale: en-US\nworldData: data/world.data.yaml\n",
      );
      await writeFile(
        path.join(f.worldRoot, "data/world.data.yaml"),
        "sources:\n  portraits:\n    kind: media\n    path: data/portrait.png\n    to: media\n    indexTo: contract:media-owner.assets@1\n    key: filename\n  facts:\n    kind: json\n    path: data/ir.json\n    schema: contract:world-ir@1\n    to: world:metadata.ir\n    effects: [projections]\n",
      );
      const options = {
        ...f.options,
        preflight: { registry: catalogue, activePlugins: ["media-owner"] },
      };
      const put = vi.spyOn(mediaStore, "put");
      const preview = await preflightWorldDataForSession(options);
      expect(preview.diagnostics.filter((d) => d.level === "error")).toEqual(
        [],
      );
      expect(put).not.toHaveBeenCalled();
      expect(
        await access(marker).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      const prepared = await prepareWorldDataImportForSession({
        ...options,
        mediaStore,
      });
      expect(prepared.diagnostics.filter((d) => d.level === "error")).toEqual(
        [],
      );
      expect(put).toHaveBeenCalledTimes(1);
      await store.createSession(f.session());
      await expect(
        store.withTransaction((tx) =>
          applyPreparedWorldDataImportForSession({
            ...options,
            store: tx,
            mediaStore,
            prepared,
          }),
        ),
      ).rejects.toThrow("record does not match");
      expect(
        await store.listPluginData(f.options.sessionId, "media-owner"),
      ).toEqual([]);
      expect(
        await store.listWorldDataImportLedger(f.options.sessionId),
      ).toEqual([]);
      expect(await mediaStore.listRefs()).toEqual([]);
      catalogue.getAll().set("media-owner", {
        ...entry,
        packageManifest: {
          ...entry.packageManifest,
          datasetSchemas: {
            assets: {
              type: "object",
              required: ["ref", "filename", "sourceId"],
            },
          },
        },
      });
      const valid = await prepareWorldDataImportForSession({
        ...options,
        mediaStore,
      });
      const applied = await store.withTransaction((tx) =>
        applyPreparedWorldDataImportForSession({
          ...options,
          store: tx,
          mediaStore,
          prepared: valid,
        }),
      );
      expect(applied.written).toBeGreaterThan(0);
      expect(
        (
          await store.listPluginData(
            f.options.sessionId,
            "media-owner",
            "assets",
          )
        )[0]?.value,
      ).toMatchObject({
        ref: { mime: "image/png" },
        filename: "portrait.png",
        sourceId: "portraits",
      });
      if (valid.imported)
        await releaseWorldDataMediaRefs({ mediaStore, refs: valid.mediaRefs });
    } finally {
      await store.close();
      await mediaStore.close?.();
      await f.cleanup();
    }
  });

  it.each(["inventory", "affinity"])(
    "allows removing world-seeded records under the bundled %s declaration",
    async (id) => {
      const f = await datasetWriteFixture();
      const store = createMemoryStore();
      try {
        const root = path.resolve(
          import.meta.dirname,
          "../../../../plugins",
          id,
        );
        const discovery = await discoverPluginAt(root);
        if (!discovery) throw new Error("Bundled fixture not found");
        const definition = await loadPluginDefinition(discovery);
        const namespace = id === "inventory" ? "items" : "affinity";
        const value =
          id === "inventory"
            ? { id: "seed", name: "Seed", quantity: 1 }
            : { id: "seed", name: "Seed", score: 10 };
        const entry = {
          ...f.registry.get("probe")!,
          id,
          rootPath: root,
          packageManifest: definition.packageManifest,
          manifests: definition.manifests,
          dataSchemas: definition.packageManifest.manifest.dataSchemas,
          datasets: definition.packageManifest.manifest.datasets,
          summary: { ...f.registry.get("probe")!.summary, id },
        };
        f.registry.register(entry);
        const source = {
          id: "seed",
          descriptor: {
            kind: "json" as const,
            path: "seed.json",
            to: `contract:${id === "inventory" ? "inventory.items@1" : "character.affinity@1"}`,
            key: "id",
          },
          order: 0,
          resolvedOrder: 0,
          origin: "world" as const,
          overridden: false,
          pathOrigin: { descriptorRoot: f.worldRoot, origin: "world" as const },
          inlineValue: [value],
        };
        const plan = await buildImportPlan({
          ...f.options,
          sources: [source],
          deps: { registry: f.registry, activePlugins: [id] },
        });
        expect(plan.diagnostics).toEqual([]);
        await store.createSession(f.session());
        await writeImportPlan({ store, ...f.options, plan });
        expect(
          await store.listPluginData(f.options.sessionId, id, namespace),
        ).toHaveLength(1);
        const result = await syncWorldDataForSession({
          store,
          ...f.options,
          prepared: {
            imported: true,
            diagnostics: [],
            plan: { ...plan, writes: [] },
          },
        });
        expect(result).toMatchObject({ deleted: 1, diagnostics: [] });
        expect(
          await store.listPluginData(f.options.sessionId, id, namespace),
        ).toEqual([]);
      } finally {
        await store.close();
        await f.cleanup();
      }
    },
  );
});
