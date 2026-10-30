import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { createPluginTestStore } from "@covel/plugin-test-utils";
import { commitExecution, executeTurn } from "@covel/runtime";

const now = "2026-10-30T00:00:00Z";
const oldActor = {
  characterId: "rin",
  displayName: "Rin",
  active: true,
  visual: { outfit: "uniform" },
};
const sceneEvent = {
  topic: "scene.set",
  data: { location: "Library", timeOfDay: "day" },
};
const directionEvent = {
  topic: "stage.direction",
  data: { cues: [{ type: "actor.enter", character: "Mio", focus: true }] },
};

async function fixture(events) {
  const store = await createPluginTestStore({
    sessionId: "s",
    pluginId: "scene-stage",
  });
  await store.updateSession("s", {
    activePlugins: ["scene-stage", "scene-fixture"],
    locale: "en-US",
  });
  for (const [id, name] of [
    ["rin", "Rin"],
    ["mio", "Mio"],
  ])
    await store.upsertCharacter({
      id,
      name,
      sessionId: "s",
      type: "npc",
      fields: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  for (const [namespace, value] of [
    [
      "stage",
      {
        sceneId: "classroom",
        name: "Classroom",
        variant: "day",
        source: "world",
        turnId: "old",
      },
    ],
    ["direction", { schemaVersion: 1, actors: [oldActor], turnId: "old" }],
    [
      "scenes",
      {
        scenes: [
          { sceneId: "library", name: "Library" },
          { sceneId: "classroom", name: "Classroom" },
        ],
      },
    ],
  ])
    await store.setPluginData({
      id: namespace,
      sessionId: "s",
      pluginId: "scene-stage",
      namespace,
      key: namespace === "scenes" ? "scene-registry" : "current",
      value,
      createdAt: now,
      updatedAt: now,
    });
  const discovery = (
    await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
  ).find(({ id }) => id === "scene-stage");
  const manifests = (await loadPluginManifest(discovery))
    .map(({ manifest }) => manifest)
    .filter(({ name }) =>
      ["scene-stage/direction", "scene-stage/resolver"].includes(name),
    );
  const loaded = new Map(
    await Promise.all(
      manifests.map(async (manifest) => [
        manifest.name,
        await loadRuntime(discovery, manifest.name),
      ]),
    ),
  );
  const emitter = {
    name: "scene-fixture",
    pluginId: "scene-fixture",
    runtimeType: "function",
    outputKind: "system",
    stage: "pre-turn",
    trigger: { type: "auto" },
  };
  const execution = await executeTurn(
    {
      origin: "player",
      sessionId: "s",
      turnId: "new",
      playerMessage: "Go to the library.",
      locale: "en-US",
    },
    [emitter, ...manifests],
    {
      store,
      llm: {
        generate: async () => {
          throw new Error("Function regression does not call a model");
        },
      },
      getPluginSource: () => "builtin",
      loadRuntime: async (manifest) =>
        manifest.name === emitter.name
          ? {
              manifest,
              promptTemplate: "",
              handler: async () => ({
                outcome: "success",
                value: {},
                effects: { events },
              }),
            }
          : loaded.get(manifest.name),
    },
  );
  const read = async (namespace) =>
    (await store.getPluginData("s", "scene-stage", namespace, "current"))
      ?.value;
  const commit = (extraInTx) =>
    commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "new", durationMs: 1 },
      extraInTx,
    });
  return { store, execution, read, commit };
}

describe("scene transition event followers", () => {
  it.each([
    [sceneEvent, directionEvent],
    [directionEvent, sceneEvent],
  ])(
    "applies new actor cues to the reset overlay for either event order: %j",
    async (...events) => {
      const { execution, read, commit } = await fixture(events);
      expect(
        execution.result.runtimeResults.map(({ runtimeId, status }) => [
          runtimeId,
          status,
        ]),
      ).toEqual([
        ["scene-fixture", "success"],
        ["scene-stage/resolver", "success"],
        ["scene-stage/direction", "success"],
      ]);
      expect((await read("direction")).actors).toEqual([oldActor]);
      expect((await commit()).status).toBe("committed");
      expect(await read("stage")).toMatchObject({ sceneId: "library" });
      expect((await read("direction")).actors).toEqual([
        { characterId: "mio", displayName: "Mio", active: true },
      ]);
    },
  );

  it("clears existing actors when a changed scene has no new actor cues", async () => {
    const { read, commit } = await fixture([sceneEvent]);
    expect((await commit()).status).toBe("committed");
    expect((await read("direction")).actors).toEqual([]);
  });

  it("does not clear actors for a same-scene day/night change", async () => {
    const { read, commit } = await fixture([
      { ...sceneEvent, data: { location: "Classroom", timeOfDay: "night" } },
    ]);
    expect((await commit()).status).toBe("committed");
    expect((await read("direction")).actors).toEqual([oldActor]);
  });

  it("keeps direction-only events available without a resolver trigger", async () => {
    const { execution, read, commit } = await fixture([directionEvent]);
    expect(
      execution.result.runtimeResults.map(({ runtimeId }) => runtimeId),
    ).not.toContain("scene-stage/resolver");
    expect((await commit()).status).toBe("committed");
    expect(
      (await read("direction")).actors.map(({ characterId }) => characterId),
    ).toEqual(["rin", "mio"]);
  });

  it("rolls the new backdrop and actor reset back together", async () => {
    const { read, commit } = await fixture([sceneEvent, directionEvent]);
    expect(
      (
        await commit(async () => {
          throw new Error("commit failed");
        })
      ).status,
    ).toBe("failed");
    expect(await read("stage")).toMatchObject({ sceneId: "classroom" });
    expect((await read("direction")).actors).toEqual([oldActor]);
  });
});
