import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  discoverPlugins,
  loadPluginManifest,
  loadRuntime,
} from "@covel/plugin-loader";
import { createPluginTestStore } from "@covel/plugin-test-utils";
import { commitExecution, executeTurn } from "@covel/runtime";

const now = "2026-10-30T00:00:00Z";
const story = {
  segments: [{ kind: "dialogue", speaker: "陈远", text: "这里很安静。" }],
  cues: { scene: "图书馆", present: ["阿雅", "陈远"], mood: "Tense" },
};
const storyRuntime = {
  name: "story-fixture",
  pluginId: "story-fixture",
  runtimeType: "function",
  outputKind: "story",
  outputContract: "narrative-engine@2",
  stage: "narrative",
};
const runtimeNames = [
  "scene-stage/story-cues",
  "scene-stage/resolver",
  "scene-stage/direction",
  "soundtrack/story-cues",
  "soundtrack/cue",
  "soundtrack/scene",
];
let manifests;
let loaded;

beforeAll(async () => {
  const discoveries = (
    await discoverPlugins(path.resolve(import.meta.dirname, "../.."))
  ).filter(({ id }) => ["scene-stage", "soundtrack"].includes(id));
  manifests = [];
  loaded = new Map();
  for (const discovery of discoveries) {
    const selected = (await loadPluginManifest(discovery))
      .map(({ manifest }) => manifest)
      .filter(({ name }) => runtimeNames.includes(name));
    manifests.push(...selected);
    for (const manifest of selected)
      loaded.set(manifest.name, await loadRuntime(discovery, manifest.name));
  }
});

async function fixture({
  output = story,
  events = [],
  withStory = true,
  withStage = true,
} = {}) {
  const store = await createPluginTestStore({
    sessionId: "s",
    pluginId: "scene-stage",
  });
  await store.updateSession("s", {
    activePlugins: ["scene-stage", "soundtrack", "story-fixture"],
    locale: "zh-CN",
    seats: [
      {
        id: "primary",
        controller: "human",
        role: "player",
        characters: ["aya", "chen"],
        currentCharacterId: "aya",
      },
    ],
  });
  for (const [id, name] of [
    ["aya", "阿雅"],
    ["chen", "陈远"],
    ["lin", "林月"],
  ])
    await store.upsertCharacter({
      id,
      name,
      sessionId: "s",
      type: "player",
      fields: {},
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  const seed = async (pluginId, namespace, key, value) =>
    store.setPluginData({
      id: `${pluginId}-${namespace}`,
      sessionId: "s",
      pluginId,
      namespace,
      key,
      value,
      createdAt: now,
      updatedAt: now,
    });
  await seed("scene-stage", "scenes", "scene-registry", {
    scenes: [
      { sceneId: "library", name: "图书馆" },
      { sceneId: "classroom", name: "教室" },
    ],
  });
  await seed("scene-stage", "stage", "current", {
    sceneId: "classroom",
    name: "教室",
    variant: "night",
    source: "world",
    turnId: "old",
  });
  await seed("scene-stage", "direction", "current", {
    schemaVersion: 1,
    actors: [{ characterId: "lin", displayName: "林月", active: true }],
    turnId: "old",
  });
  await seed("soundtrack", "tracks", "music-registry", {
    tracks: [{ id: "battle", file: "battle.mp3", moods: ["tense"] }],
  });
  await seed("soundtrack", "state", "mood", { mood: "calm", turnId: "old" });
  await seed("soundtrack", "state", "scene", { name: "教室", turnId: "old" });

  const selected = manifests.filter(
    ({ pluginId }) => withStage || pluginId !== "scene-stage",
  );
  const execution = await executeTurn(
    {
      origin: "player",
      sessionId: "s",
      turnId: "new",
      playerMessage: "去图书馆。",
      locale: "zh-CN",
    },
    [...(withStory ? [storyRuntime] : []), ...selected],
    {
      store,
      llm: {
        generate: async () => {
          throw new Error("Function story does not call a model");
        },
      },
      getPluginSource: () => "builtin",
      loadRuntime: async (manifest) =>
        manifest.name === storyRuntime.name
          ? {
              manifest,
              promptTemplate: "",
              handler: async () => ({
                outcome: "success",
                value: output,
                effects: { events },
              }),
            }
          : loaded.get(manifest.name),
    },
  );
  const read = async (pluginId, namespace, key) =>
    (await store.getPluginData("s", pluginId, namespace, key))?.value;
  const commit = (extraInTx) =>
    commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: "new", durationMs: 1 },
      extraInTx,
    });
  return { execution, read, commit };
}

describe("story cues committed by presentation plugins", () => {
  it("commits the story's scene, presence, focus and music together", async () => {
    const { execution, read, commit } = await fixture();
    expect(
      manifests.filter(({ name }) => name.endsWith("/story-cues")),
    ).toHaveLength(2);
    expect(
      execution.result.runtimeResults.every(
        ({ status }) => status === "success",
      ),
    ).toBe(true);
    expect(await read("scene-stage", "stage", "current")).toMatchObject({
      sceneId: "classroom",
    });
    expect(await read("soundtrack", "state", "mood")).toMatchObject({
      mood: "calm",
    });
    expect((await commit()).status).toBe("committed");
    expect(await read("scene-stage", "stage", "current")).toMatchObject({
      sceneId: "library",
      variant: "night",
      turnId: "new",
    });
    expect((await read("scene-stage", "direction", "current")).actors).toEqual([
      {
        characterId: "chen",
        displayName: "陈远",
        active: true,
        position: "left",
        transition: "fade",
      },
    ]);
    expect(await read("soundtrack", "state", "mood")).toEqual({
      mood: "tense",
      turnId: "new",
    });
    expect(await read("soundtrack", "state", "scene")).toEqual({
      name: "图书馆",
      turnId: "new",
    });
  });

  it("follows the story's scene and mood without a scene provider", async () => {
    const { read, commit } = await fixture({ withStage: false });
    expect((await commit()).status).toBe("committed");
    expect(await read("soundtrack", "state", "scene")).toMatchObject({
      name: "图书馆",
    });
    expect(await read("soundtrack", "state", "mood")).toMatchObject({
      mood: "tense",
    });
  });

  it("lets explicit events override cues from the same story", async () => {
    const { read, commit } = await fixture({
      events: [
        {
          topic: "stage.direction",
          data: {
            cues: [
              { type: "stage.clear", transition: "fade" },
              {
                type: "actor.enter",
                character: "林月",
                position: "right",
                focus: true,
              },
            ],
          },
        },
        { topic: "scene.set", data: { location: "教室", timeOfDay: "day" } },
        { topic: "music.cue", data: { mood: "silence" } },
      ],
    });
    expect((await commit()).status).toBe("committed");
    expect(await read("scene-stage", "stage", "current")).toMatchObject({
      sceneId: "classroom",
      variant: "day",
    });
    expect((await read("scene-stage", "direction", "current")).actors).toEqual([
      {
        characterId: "lin",
        displayName: "林月",
        active: true,
        position: "right",
      },
    ]);
    expect(await read("soundtrack", "state", "mood")).toMatchObject({
      mood: "silence",
    });
    expect(await read("soundtrack", "state", "scene")).toMatchObject({
      name: "教室",
    });
  });

  it.each([{ withStory: false }, { output: { narrativeOutput: "雨停了。" } }])(
    "succeeds without changing presentation when the story has no cues: %j",
    async (options) => {
      const { execution, read, commit } = await fixture(options);
      const results = execution.result.runtimeResults.filter(({ runtimeId }) =>
        runtimeId.endsWith("/story-cues"),
      );
      expect(results).toHaveLength(2);
      for (const result of results)
        expect(result).toMatchObject({
          status: "success",
          output: { skipped: true, reason: expect.any(String) },
        });
      expect((await commit()).status).toBe("committed");
      expect(await read("scene-stage", "stage", "current")).toMatchObject({
        sceneId: "classroom",
        turnId: "old",
      });
      expect(await read("soundtrack", "state", "mood")).toMatchObject({
        mood: "calm",
        turnId: "old",
      });
    },
  );

  it("keeps cue updates out of storage when the commit fails", async () => {
    const { read, commit } = await fixture();
    expect(
      (
        await commit(async () => {
          throw new Error("commit failed");
        })
      ).status,
    ).toBe("failed");
    expect(await read("scene-stage", "stage", "current")).toMatchObject({
      sceneId: "classroom",
      turnId: "old",
    });
    expect(
      (await read("scene-stage", "direction", "current")).actors[0].characterId,
    ).toBe("lin");
    expect(await read("soundtrack", "state", "mood")).toMatchObject({
      mood: "calm",
      turnId: "old",
    });
    expect(await read("soundtrack", "state", "scene")).toMatchObject({
      name: "教室",
      turnId: "old",
    });
  });
});
