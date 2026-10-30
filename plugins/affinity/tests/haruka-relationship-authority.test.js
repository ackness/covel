import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPluginRegistry,
  discoverPlugins,
  loadPluginDefinition,
} from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import { createCharacterTools, tool, z } from "@covel/tools";
import {
  bindToolStore,
  commitToolResults,
  executeToolAndCommit,
  makeRandom,
} from "@covel/plugin-test-utils";
import {
  getPendingProposals,
  getToolContent,
  mergeSchemaDefaults,
  resolveI18nDeep,
  shortIdBatch,
} from "@covel/plugin-handlers-utils";
import {
  dimensionRecordSchema,
  dimensionSnapshotFromRecords,
} from "@covel/plugin-handlers-utils/dimensions";
import { importWorldDataForSession } from "../../../apps/server/tests/helpers/world-data-import.ts";
import { loadSingleWorld } from "../../../apps/server/src/world-seed-loader.ts";
import { resolveSessionPluginPlan } from "../../../apps/server/src/routes/api/session/plugins.ts";
import { BUILTIN_PLUGIN_PACKS } from "../../../apps/server/src/config/plugin-packs.ts";
import createUpdateAffinity from "../tools/update-affinity.js";
import { currentAffinity } from "../server/current-affinity.js";
import initializeWorld from "../../world-init/guard.js";
import editDimensions from "../../world-init/runtimes/edit-dimensions/handler.js";
import initializePlayer from "../../char-creator/runtimes/player-init/guard.js";
import { evaluateCondition } from "../../story-events/lib/conditions.js";

const root = path.resolve(import.meta.dirname, "../../..");
const now = "2026-10-29T00:00:00Z";
const sessionId = "relationship-test";
const routeIds = [
  "kamishiro-mio",
  "asakura-rin",
  "shiina-kaho",
  "shiraishi-yuma",
  "toujou-akane",
];
const supportIds = ["mikoeda-haruka", "onodera-chihiro", "morikawa-souta"];
const expectedScores = Object.fromEntries(
  [...routeIds, ...supportIds].map((id, i) => [
    id,
    [8, 10, 6, 0, 0, 5, 4, 6][i],
  ]),
);
const routeValue = Object.fromEntries(
  ["mio", "rin", "kaho", "yuma", "akane"].map((id, i) => [
    id,
    { stage: "acquaintance", trust: 0, pressure: [3, 1, 2, 2, 1][i] },
  ]),
);
let registry;
let testHome;

beforeAll(async () => {
  testHome = await mkdtemp(path.join(tmpdir(), "relationship-home-"));
  registry = createPluginRegistry();
  for (const discovery of await discoverPlugins(path.join(root, "plugins"))) {
    const { manifests, packageManifest } =
      await loadPluginDefinition(discovery);
    registry.register({
      id: discovery.id,
      rootPath: discovery.rootPath,
      source: "builtin",
      manifests,
      packageManifest,
      summary: {
        id: discovery.id,
        name: discovery.id,
        description: "",
        kind: "plugin",
        runtimeCount: manifests.length,
      },
      loadedRuntimes: new Map(),
      status: "registered",
    });
  }
});
afterAll(async () => rm(testHome, { recursive: true, force: true }));

async function fixture(worldId, locale) {
  const world = await loadSingleWorld(path.join(root, "worlds", worldId), {
    covelHome: testHome,
    includeWorldDataOverrides: false,
  });
  expect(world).toBeTruthy();
  const policy = world.metadata.pluginPolicy;
  const pack = BUILTIN_PLUGIN_PACKS.find((item) => item.id === policy.preset);
  const plan = resolveSessionPluginPlan(
    [...pack.requested, ...(policy.plus ?? [])],
    registry,
    {
      excluded: policy.minus ?? pack.excluded,
      authorized: [...registry.getAll().keys()],
      requiredContracts: policy.requires,
    },
  );
  expect(
    plan.rejected.filter((item) => item.code !== "default-replaced"),
  ).toEqual([]);
  const store = createMemoryStore();
  await store.createWorld(world);
  await store.createSession({
    id: sessionId,
    worldId,
    locale,
    activePlugins: plan.active,
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  const imported = await importWorldDataForSession({
    store,
    sessionId,
    worldId,
    worldsDirs: [path.join(root, "worlds")],
    covelHome: testHome,
    now,
    locale,
    preflight: { registry, activePlugins: plan.active },
  });
  expect(imported.written).toBeGreaterThan(0);
  expect(imported.diagnostics.filter((item) => item.level === "error")).toEqual(
    [],
  );
  expect(
    imported.diagnostics.filter((item) => /overlay|locale/i.test(item.code)),
  ).toEqual([]);
  const schema = {
    types: ["npc", "companion"],
    ...resolveI18nDeep(world.metadata.characterSchema, locale),
  };
  const dimensions = async () =>
    dimensionSnapshotFromRecords(
      Object.fromEntries(
        (
          await store.listPluginData(sessionId, "world-init", "_dimensions")
        ).map((row) => [row.key, dimensionRecordSchema.parse(row.value)]),
      ),
    );
  const characters = await store.listCharacters(sessionId);
  const ctx = {
    sessionId,
    turnId: "schema",
    pluginId: "world-init",
    runtimeId: "world-init/schema-gen",
    locale,
    world: {
      worldRecord: {
        ...world,
        metadata: { ...world.metadata, characterSchema: schema },
      },
      characterSchema: null,
      characters,
      dimensions: await dimensions(),
    },
  };
  await commitToolResults([await initializeWorld(ctx)], ctx, store);
  const worldView = async () => ({
    characters: await store.listCharacters(sessionId),
    characterSchema: await store.getCharacterSchema(sessionId),
    dimensions: await dimensions(),
    seats: [],
  });
  const projection = async () =>
    currentAffinity(
      {},
      {
        locale,
        world: await worldView(),
        pluginData: {
          list: (ns) => store.listPluginData(sessionId, "affinity", ns),
        },
      },
    );
  return {
    store,
    world,
    schema,
    dimensions,
    worldView,
    projection,
    activePlugins: plan.active,
  };
}

function projectedScores(segments) {
  return segments[0].content
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map(JSON.parse);
}

describe.each(["zh-CN", "en-US"])("real Harukaze package in %s", (locale) => {
  it("imports eight single accounts, original routes and scoped defaults", async () => {
    const { store, world, schema, dimensions, projection, activePlugins } =
      await fixture("haruka-academy", locale);
    expect(activePlugins).toEqual(
      expect.arrayContaining([
        "affinity",
        "world-ir",
        "world-init",
        "char-creator",
        "character-blueprint",
        "story-events",
      ]),
    );
    const chars = await store.listCharacters(sessionId);
    expect(chars).toHaveLength(8);
    expect(schema.attributes.some((attr) => attr.id === "affection")).toBe(
      false,
    );
    for (const id of ["trust", "pressure", "relationshipStage"]) {
      const attr = schema.attributes.find((attr) => attr.id === id);
      expect(attr).not.toHaveProperty("defaultValue");
      expect(attr.name).toContain(
        locale === "zh-CN" ? "支持角色" : "Supporting Character",
      );
    }
    for (const c of chars) {
      expect(c.fields).not.toHaveProperty("affection");
      const withDefaults = mergeSchemaDefaults(c.fields, schema);
      expect(withDefaults).toEqual(c.fields);
      if (routeIds.includes(c.id.slice(4))) {
        for (const field of ["trust", "pressure", "relationshipStage"])
          expect(withDefaults).not.toHaveProperty(field);
      }
    }
    for (const [i, id] of supportIds.entries()) {
      expect(chars.find((c) => c.id === `npc-${id}`).fields).toMatchObject({
        trust: [22, 28, 14][i],
        pressure: [55, 30, 20][i],
        relationshipStage: (locale === "zh-CN"
          ? ["初识", "师生", "初识"]
          : ["Just met", "Teacher and student", "Just met"])[i],
      });
    }
    expect(
      Object.fromEntries(
        chars.map((c) => [c.id.slice(4), c.fields.publicCloseness]),
      ),
    ).toEqual({
      "kamishiro-mio": 0,
      "asakura-rin": 5,
      "shiina-kaho": 2,
      "shiraishi-yuma": 0,
      "toujou-akane": 1,
      "mikoeda-haruka": 3,
      "onodera-chihiro": 0,
      "morikawa-souta": 8,
    });
    const affinity = await store.listPluginData(
      sessionId,
      "affinity",
      "affinity",
    );
    expect(affinity).toHaveLength(8);
    expect(
      Object.fromEntries(affinity.map((r) => [r.key, r.value.score])),
    ).toEqual(expectedScores);
    for (const r of affinity) {
      expect(r.value.name).toBe(
        chars.find((c) => c.id === `npc-${r.key}`).name,
      );
      expect(r.value).not.toHaveProperty("tier");
    }
    expect(projectedScores(await projection())).toEqual(
      expect.arrayContaining(
        affinity.map((r) => ({
          canonicalName: r.value.name,
          score: r.value.score,
        })),
      ),
    );
    const dims = await dimensions();
    expect(Object.keys(dims).sort()).toEqual(
      Object.keys(world.metadata.dimensions).sort(),
    );
    expect(dims.routes.value).toEqual(routeValue);
    for (const field of Object.values(dims.routes.schema.properties)) {
      expect(field.properties.trust).toMatchObject({ minimum: 0, maximum: 5 });
      expect(field.properties.pressure).toMatchObject({
        minimum: 0,
        maximum: 5,
      });
      expect(field.properties.stage.enum).toEqual([
        "acquaintance",
        "familiar",
        "heartbeat",
        "confession-eve",
        "together",
      ]);
    }
    const row = await store.getPluginData(
      sessionId,
      "world-init",
      "_dimensions",
      "routes",
    );
    expect(row.value.definition.updateRule).toContain(
      locale === "zh-CN"
        ? "初识→熟悉 1、熟悉→心动 2、心动→告白前夜 4"
        : "1 for acquaintance → familiar, 2 for familiar → heartbeat, and 4 for heartbeat → confession-eve",
    );
  });

  it("commits affinity, route and support updates without writing another account", async () => {
    const { store, dimensions, worldView, projection } = await fixture(
      "haruka-academy",
      locale,
    );
    const before = await worldView();
    const mio = before.characters.find((c) => c.id === "npc-kamishiro-mio");
    const ctx = {
      sessionId,
      turnId: "affinity-delta",
      pluginId: "affinity",
      runtimeId: "affinity",
      locale,
      logicalTurn: 1,
      random: makeRandom(),
      world: before,
    };
    const update = bindToolStore(
      createUpdateAffinity({ tool, z, shortIdBatch }),
      store,
    );
    const result = await update.execute(
      {
        changes: [{ name: mio.aliases[0], delta: 2, reason: "Kept a promise" }],
      },
      ctx,
    );
    // Uncommitted proposals never become current narrative facts.
    expect(projectedScores(await projection())).toContainEqual({
      canonicalName: mio.name,
      score: 8,
    });
    await commitToolResults([result], ctx, store);
    expect(getPendingProposals(result).map((p) => p.type)).toEqual([
      "plugin.data.update",
      "plugin.data.batch",
    ]);
    const scores = await store.listPluginData(
      sessionId,
      "affinity",
      "affinity",
    );
    expect(scores).toHaveLength(8);
    expect(scores.find((r) => r.key === "kamishiro-mio").value.score).toBe(10);
    expect(projectedScores(await projection())).toContainEqual({
      canonicalName: mio.name,
      score: 10,
    });
    expect(await store.listCharacters(sessionId)).toEqual(before.characters);
    expect(await dimensions()).toEqual(before.dimensions);

    const routes = before.dimensions.routes;
    const editCtx = {
      ...ctx,
      turnId: "route-edit",
      pluginId: "world-init",
      runtimeId: "world-init/edit-dimensions",
      world: await worldView(),
      manualPayload: {
        updates: [
          {
            id: "routes",
            expectedVersion: routes.version,
            value: { ...routes.value, mio: { ...routes.value.mio, trust: 1 } },
          },
        ],
      },
      store: {
        listPluginData: (ns) =>
          store.listPluginData(sessionId, "world-init", ns),
      },
    };
    const edited = await editDimensions(editCtx);
    expect(getPendingProposals(edited).map((p) => p.type)).toEqual([
      "dimension.update",
    ]);
    await commitToolResults([edited], editCtx, store);
    expect((await dimensions()).routes.value.mio.trust).toBe(1);
    expect(await store.listCharacters(sessionId)).toEqual(before.characters);
    expect(
      await store.listPluginData(sessionId, "affinity", "affinity"),
    ).toEqual(scores);

    const routesAfter = await dimensions();
    const sync = createCharacterTools(store).find(
      (t) => t.name === "sync-characters",
    );
    await executeToolAndCommit(
      sync,
      { updates: [{ id: "npc-mikoeda-haruka", fields: { trust: 23 } }] },
      {
        ...ctx,
        turnId: "support-edit",
        pluginId: "char-creator",
        runtimeId: "char-creator/character-tracker",
        world: await worldView(),
      },
      store,
    );
    expect(
      (await store.listCharacters(sessionId)).find(
        (c) => c.id === "npc-mikoeda-haruka",
      ).fields,
    ).toMatchObject({ trust: 23, pressure: 55, publicCloseness: 3 });
    expect(await dimensions()).toEqual(routesAfter);
    expect(
      await store.listPluginData(sessionId, "affinity", "affinity"),
    ).toEqual(scores);
  });

  it("creates a player without resurrecting numeric relationship defaults", async () => {
    const { store, worldView } = await fixture("haruka-academy", locale);
    const ctx = {
      sessionId,
      turnId: "player-init",
      pluginId: "char-creator",
      runtimeId: "char-creator/player-init",
      locale,
      world: await worldView(),
      store: {
        listPlayerInputs: async () => [
          {
            formId: "char-creation",
            values: {
              characterName: "Alex",
              persona: "Quiet and curious",
              club: "Literature Club",
            },
          },
        ],
      },
    };
    const result = await initializePlayer(ctx);
    expect(getToolContent(result)).toMatchObject({
      playerExists: true,
      preGameDone: true,
    });
    await commitToolResults([result], ctx, store);
    const player = (await store.listCharacters(sessionId)).find(
      (c) => c.type === "player",
    );
    expect(player.name).toBe("Alex");
    expect(player.fields).toMatchObject({
      persona: "Quiet and curious",
      club: "Literature Club",
      publicCloseness: 0,
    });
    for (const field of ["affection", "trust", "pressure"])
      expect(player.fields).not.toHaveProperty(field);
  });

  it("keeps hidden route thresholds and paths on the dimension account", async () => {
    const { store, dimensions } = await fixture("haruka-academy", locale);
    const events = await store.listPluginData(
      sessionId,
      "story-events",
      "_hidden.events",
    );
    expect(events).toHaveLength(4);
    const byId = Object.fromEntries(events.map((r) => [r.key, r.value]));
    const dims = await dimensions();
    dims.routes.value.mio = { stage: "heartbeat", trust: 2, pressure: 3 };
    const state = {
      dimensions: dims,
      time: { hour: 16 },
      characters: [{ fields: { trust: 100 } }],
    };
    expect(evaluateCondition(byId["mio-the-club-room"].when, state)).toEqual({
      met: false,
      issues: [],
    });
    dims.routes.value.mio.trust = 3;
    expect(evaluateCondition(byId["mio-the-club-room"].when, state)).toEqual({
      met: true,
      issues: [],
    });
    expect(
      evaluateCondition(byId["mio-the-club-room"].when, {
        ...state,
        time: { hour: 15 },
      }).met,
    ).toBe(false);
    dims.routes.value.mio.stage = "familiar";
    expect(evaluateCondition(byId["mio-the-club-room"].when, state).met).toBe(
      false,
    );
    dims.routes.value.kaho.stage = "heartbeat";
    dims.festival.value.projects.closingSong.progress = 59;
    expect(evaluateCondition(byId["kaho-last-verse"].when, state).met).toBe(
      false,
    );
    dims.festival.value.projects.closingSong.progress = 60;
    expect(evaluateCondition(byId["kaho-last-verse"].when, state)).toEqual({
      met: true,
      issues: [],
    });
    dims.routes.value.akane.stage = "familiar";
    dims.clubReview.value.status = "building-case";
    expect(evaluateCondition(byId["akane-sisters-note"].when, state)).toEqual({
      met: true,
      issues: [],
    });
    dims.festival.value.milestones.stagePreview = "passed";
    const chained = {
      ...state,
      turn: 6,
      revealed: { "kaho-last-verse": { lastTurn: 3 } },
    };
    expect(
      evaluateCondition(byId["kaho-names-the-song"].when, chained),
    ).toEqual({ met: true, issues: [] });
    expect(
      evaluateCondition(byId["kaho-names-the-song"].when, {
        ...chained,
        turn: 5,
      }).met,
    ).toBe(false);
  });
});

it.each(["mistport", "lantern-barrow", "emberback"])(
  "preserves %s relationship and ability data in both real editions",
  async (worldId) => {
    const editions = await Promise.all(
      ["zh-CN", "en-US"].map((locale) => fixture(worldId, locale)),
    );
    const numbers = (fields) =>
      Object.fromEntries(
        Object.entries(fields).filter(([, v]) => typeof v === "number"),
      );
    const snapshots = await Promise.all(
      editions.map(async ({ store, schema }) => ({
        fields: Object.fromEntries(
          (await store.listCharacters(sessionId)).map((c) => [
            c.id,
            numbers(c.fields),
          ]),
        ),
        affinity: Object.fromEntries(
          (await store.listPluginData(sessionId, "affinity", "affinity")).map(
            (r) => [r.key, r.value.score],
          ),
        ),
        mechanics: schema.attributes
          .filter((a) => a.type === "number")
          .map(({ id, min, max, defaultValue }) => ({
            id,
            min,
            max,
            defaultValue,
          })),
      })),
    );
    expect(snapshots[0]).toEqual(snapshots[1]);
    const attrs = editions[0].schema.attributes.map((a) => a.id);
    if (worldId === "mistport") {
      expect(attrs).toEqual(
        expect.arrayContaining([
          "trust",
          "tideReading",
          "stealth",
          "diplomacy",
          "combat",
          "vitality",
        ]),
      );
      expect(
        Object.values(snapshots[0].fields)
          .map((f) => f.trust)
          .sort((a, b) => a - b),
      ).toEqual([5, 8, 10, 15, 25, 30, 40]);
      expect(snapshots[0].affinity).toEqual({});
    } else if (worldId === "lantern-barrow") {
      expect(attrs).toEqual(
        expect.arrayContaining([
          "trust",
          "hp",
          "might",
          "agility",
          "endurance",
          "wits",
          "insight",
          "presence",
        ]),
      );
      expect(
        Object.values(snapshots[0].affinity).sort((a, b) => a - b),
      ).toEqual([0, 3, 5, 10]);
    } else {
      expect(attrs).toEqual(
        expect.arrayContaining([
          "grit",
          "systems",
          "fieldcraft",
          "insight",
          "rapport",
        ]),
      );
      expect(
        Object.values(snapshots[0].affinity).sort((a, b) => a - b),
      ).toEqual([-2, 4, 6, 10, 12]);
    }
  },
);
