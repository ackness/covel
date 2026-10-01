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
