import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginRegistry } from "@covel/plugin-loader";
import { registerDimensionProvider } from "../helpers/dimension-provider.js";
import {
  importWorldDataForSession,
  syncWorldDataForSession,
} from "../../src/world-data/session-import.js";

const at = "2026-10-01T00:00:00Z";
const definition = (value: number) => ({
  name: "Stamina",
  schema: { type: "integer", minimum: 0 },
  initialValue: value,
});
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const store = createMemoryStore();
  const registry = createPluginRegistry();
  await registerDimensionProvider(registry);
  await store.createSession({
    id: "session",
    worldId: "world",
    phase: "playing",
    status: "active",
    setupRuntimes: {},
    completedPlayerTurns: 0,
    metadata: {},
    locale: "en-US",
    activePlugins: ["world-init"],
    createdAt: at,
    updatedAt: at,
  });
  return {
    store,
    registry,
    sessionId: "session",
    worldId: "world",
    now: at,
    preflight: { activePlugins: ["world-init"], registry },
  };
}

describe("dynamic dimension author import and sync", () => {
  it("stores a localized dimension in the session's language only", async () => {
    const args = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), "covel-dimension-locale-"));
    roots.push(root);
    const world = path.join(root, "world");
    await mkdir(world, { recursive: true });
    await writeFile(
      path.join(world, "world.yaml"),
      JSON.stringify({
        id: "world",
        dimensions: {
          mood: {
            name: { "zh-CN": "气氛", "en-US": "Mood" },
            schema: {
              type: "object",
              properties: { note: { type: "string", "x-i18n": true } },
            },
            initialValue: { note: { "zh-CN": "平静", "en-US": "Calm" } },
            updateRule: {
              "zh-CN": "气氛变化时更新。",
              "en-US": "Update when the mood changes.",
            },
          },
        },
      }),
    );
    const options = { ...args, worldsDirs: [root] };
    await importWorldDataForSession(options);
    const record = (await args.store.getPluginData(
      "session",
      "world-init",
      "_dimensions",
      "mood",
    ))!.value;
    // The fixture session is en-US. No locale map survives the import.
    expect(record).toMatchObject({
      value: { note: "Calm" },
      definition: {
        initialValue: { note: "Calm" },
        updateRule: "Update when the mood changes.",
        // The name is a label and stays localizable for the UI language.
        name: { "zh-CN": "气氛", "en-US": "Mood" },
      },
    });
    // The same package compares equal on the next sync.
    expect(
      (await syncWorldDataForSession({ ...options, dryRun: false })).conflicts,
    ).toEqual([]);
  });

  it("resolves external over inline and descriptor replacement, then protects progress even with force", async () => {
    const args = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), "covel-dimension-import-"));
    roots.push(root);
    const world = path.join(root, "world");
    await mkdir(path.join(world, "data"), { recursive: true });
    await writeFile(
      path.join(world, "world.yaml"),
      JSON.stringify({
        id: "world",
        dimensions: { stamina: definition(1), replaced: definition(1) },
        dimensionSources: { stamina: "data/stamina.yaml" },
        worldData: "data/world.data.yaml",
      }),
    );
    await writeFile(
      path.join(world, "data/stamina.yaml"),
      JSON.stringify(definition(2)),
    );
    await writeFile(
      path.join(world, "data/world.data.yaml"),
      JSON.stringify({
        schemaVersion: 1,
        sources: {
          dims: {
            kind: "yaml",
            path: "data/dimensions.yaml",
            schema: "covel://world/dimensions",
            to: "world:metadata.dimensions",
          },
        },
      }),
    );
    await writeFile(
      path.join(world, "data/dimensions.yaml"),
      JSON.stringify({ stamina: definition(3) }),
    );
    const options = { ...args, worldsDirs: [root] };
    await importWorldDataForSession(options);
    expect(
      (
        await args.store.listPluginData("session", "world-init", "_dimensions")
      ).map((row) => row.key),
    ).toEqual(["stamina"]);
    const record = (await args.store.getPluginData(
      "session",
      "world-init",
      "_dimensions",
      "stamina",
    ))!.value as Record<string, unknown>;
    expect(record).toMatchObject({ value: 3, version: 1 });
    await args.store.compareAndSetPluginDataBatch("session", "world-init", [
      {
        namespace: "_dimensions",
        key: "stamina",
        expectedVersion: 1,
        value: { ...record, value: 4, version: 2 },
        timestamp: at,
      },
    ]);
    expect(
      (await syncWorldDataForSession({ ...options, dryRun: false })).conflicts,
    ).toEqual([]);
    await writeFile(path.join(world, "data/dimensions.yaml"), "{}");
    expect(
      (
        await syncWorldDataForSession({
          ...options,
          dryRun: false,
          force: true,
        })
      ).conflicts,
    ).toHaveLength(1);
    expect(
      (await args.store.getPluginData(
        "session",
        "world-init",
        "_dimensions",
        "stamina",
      ))!.value,
    ).toMatchObject({ value: 4, version: 2 });
    await args.store.close();
  });
  it("syncs portable declarations without a descriptor and conflicts with pending debt", async () => {
    const args = await fixture();
    await args.store.upsertWorld({
      id: "world",
      name: "World",
      description: "",
      metadata: { dimensions: { stamina: definition(1) } },
      createdAt: at,
    });
    await importWorldDataForSession({ ...args, worldsDirs: [] });
    await args.store.setPluginData({
      id: "receipt",
      sessionId: "session",
      pluginId: "world-init",
      namespace: "_dimension-settlements",
      key: "source",
      value: {
        source: { resultId: "source", turnNumber: 1 },
        sourceTurnId: "turn",
        definitions: { stamina: definition(1) },
        readVersions: { stamina: 1 },
        status: "pending-settlement",
        version: 1,
      },
      createdAt: at,
      updatedAt: at,
    });
    await args.store.upsertWorld({
      id: "world",
      name: "World",
      description: "",
      metadata: { dimensions: { stamina: definition(9) } },
      createdAt: at,
    });
    expect(
      (
        await syncWorldDataForSession({
          ...args,
          worldsDirs: [],
          dryRun: false,
          force: true,
        })
      ).conflicts,
    ).toHaveLength(1);
    expect(
      (await args.store.getPluginData(
        "session",
        "world-init",
        "_dimensions",
        "stamina",
      ))!.value,
    ).toMatchObject({ value: 1, version: 1 });
    await args.store.close();
  });
  it("protects a dimension initialized in play, which has no import ledger, while its settlement is pending", async () => {
    const args = await fixture();
    const world = (initialValue: number) =>
      args.store.upsertWorld({
        id: "world",
        name: "World",
        description: "",
        metadata: { dimensions: { stamina: definition(initialValue) } },
        createdAt: at,
      });
    const sync = () =>
      syncWorldDataForSession({ ...args, worldsDirs: [], dryRun: false });
    const record = async () =>
      (await args.store.getPluginData(
        "session",
        "world-init",
        "_dimensions",
        "stamina",
      ))!.value;
    const receipt = (status: string) =>
      args.store.setPluginData({
        id: "receipt",
        sessionId: "session",
        pluginId: "world-init",
        namespace: "_dimension-settlements",
        key: "source",
        value: {
          source: { resultId: "source", turnNumber: 1 },
          sourceTurnId: "turn",
          definitions: { stamina: definition(1) },
          readVersions: { stamina: 1 },
          status,
          version: 1,
        },
        createdAt: at,
        updatedAt: at,
      });
    // What a committed `dimension.initialize` leaves: a bound provider and a
    // versioned record, with no world-data import ledger row.
    await world(1);
    await args.store.updateSession("session", {
      metadata: { _dimensionProviderPluginId: "world-init" },
    });
    await args.store.setPluginData({
      id: "stamina",
      sessionId: "session",
      pluginId: "world-init",
      namespace: "_dimensions",
      key: "stamina",
      value: { definition: definition(1), value: 1, version: 1 },
      createdAt: at,
      updatedAt: at,
    });
    await receipt("pending-settlement");
    expect(await args.store.listWorldDataImportLedger("session")).toEqual([]);

    await world(2);
    expect((await sync()).conflicts).toEqual([
      expect.objectContaining({ key: "stamina", reason: "modified" }),
    ]);
    expect(await record()).toMatchObject({
      definition: { initialValue: 1 },
      value: 1,
      version: 1,
    });
    expect(await args.store.listWorldDataImportLedger("session")).toEqual([]);

    // The unchanged declaration is not a conflict.
    await world(1);
    expect((await sync()).conflicts).toEqual([]);
    expect(await record()).toMatchObject({ value: 1, version: 1 });

    // Once the narrative is settled the new declaration can be adopted.
    await world(2);
    await receipt("no-change");
    expect((await sync()).conflicts).toEqual([]);
    expect(await record()).toMatchObject({
      definition: { initialValue: 2 },
      value: 2,
    });
    await args.store.close();
  });
  it("imports and syncs inline/external worlds with no worldData descriptor", async () => {
    const args = await fixture();
    const root = await mkdtemp(path.join(tmpdir(), "covel-dimension-inline-"));
    roots.push(root);
    const world = path.join(root, "world");
    await mkdir(world);
    await writeFile(
      path.join(world, "world.yaml"),
      JSON.stringify({
        id: "world",
        dimensions: { stamina: definition(1) },
        dimensionSources: { stamina: "stamina.yaml" },
      }),
    );
    await writeFile(
      path.join(world, "stamina.yaml"),
      JSON.stringify(definition(2)),
    );
    const options = { ...args, worldsDirs: [root] };
    await importWorldDataForSession(options);
    expect(
      (await args.store.getPluginData(
        "session",
        "world-init",
        "_dimensions",
        "stamina",
      ))!.value,
    ).toMatchObject({ value: 2, version: 1 });
    await writeFile(
      path.join(world, "stamina.yaml"),
      JSON.stringify(definition(3)),
    );
    await syncWorldDataForSession({ ...options, dryRun: false });
    expect(
      (await args.store.getPluginData(
        "session",
        "world-init",
        "_dimensions",
        "stamina",
      ))!.value,
    ).toMatchObject({ value: 3, version: 2 });
    await args.store.close();
  });
});
