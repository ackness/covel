import { describe, expect, it, vi } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../runtimes/resolver/handler.js";

const TOPIC = "scene.set";

function ref(id) {
  return { id: id.repeat(64).slice(0, 64), mime: "image/png", size: 1024 };
}

const CLASSROOM_DAY = ref("1");
const CLASSROOM_NIGHT = ref("2");
const LIBRARY_DAY = ref("3");
const SESSION_DAY = ref("4");

const REGISTRY = {
  schemaVersion: 1,
  registryId: "scene-registry",
  style: {
    prefix: "Visual novel background, ",
    suffix: ", clean composition",
    nightSuffix: ", night time",
  },
  scenes: [
    {
      sceneId: "classroom",
      name: "二年 B 组教室",
      day: CLASSROOM_DAY,
      night: CLASSROOM_NIGHT,
    },
    {
      sceneId: "library",
      name: "图书馆",
      locationRef: "图书馆",
      day: LIBRARY_DAY,
      night: null,
    },
  ],
};

function makeCtx({
  location,
  timeOfDay = "day",
  visualHint,
  registry = REGISTRY,
  previous = null,
  generatedRows = [],
  userSettings = { autoGenerateScenes: true, maxGeneratedScenes: 10 },
  noTriggerEvent = false,
} = {}) {
  const get = vi.fn(async (namespace, key) => {
    if (namespace === "scenes" && key === "scene-registry") return registry;
    if (namespace === "stage" && key === "current") return previous;
    return null;
  });
  const list = vi.fn(async (namespace) => {
    if (namespace === "generated") return generatedRows;
    return [];
  });
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/resolver",
    sessionId: "sess-1",
    turnId: "turn-1",
    userSettings,
    triggerEvent: noTriggerEvent
      ? undefined
      : {
          topic: TOPIC,
          data: {
            location,
            timeOfDay,
            ...(visualHint ? { visualHint } : {}),
          },
        },
    pluginData: { get, set: vi.fn(), list, delete: vi.fn() },
  };
}

describe("scene-stage resolver handler", () => {
  it("1. exact name match writes stage/current with source=world", async () => {
    const ctx = makeCtx({ location: "二年 B 组教室", timeOfDay: "day" });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      source: { pluginId: "scene-stage", runtimeId: "scene-stage/resolver" },
      sessionId: "sess-1",
      turnId: "turn-1",
      payload: {
        namespace: "stage",
        key: "current",
        value: {
          sceneId: "classroom",
          name: "二年 B 组教室",
          variant: "day",
          source: "world",
          day: CLASSROOM_DAY,
          night: CLASSROOM_NIGHT,
          resolved: CLASSROOM_DAY,
          sourceLabel: { zh: "世界背景", en: "World art" },
          turnId: "turn-1",
        },
      },
    });
  });

  it("2. locationRef fuzzy substring match hits the library scene", async () => {
    const ctx = makeCtx({ location: "图书馆二楼窗边", timeOfDay: "day" });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "library",
      source: "world",
      resolved: LIBRARY_DAY,
    });
  });

  it("3. missing night image falls back to the day ref", async () => {
    const ctx = makeCtx({ location: "图书馆", timeOfDay: "night" });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "library",
      variant: "night",
      night: null,
      resolved: LIBRARY_DAY,
    });
  });

  it("4. no-op when previous stage has the same sceneId and variant", async () => {
    const previous = {
      sceneId: "classroom",
      name: "二年 B 组教室",
      variant: "day",
      source: "world",
      day: CLASSROOM_DAY,
      night: CLASSROOM_NIGHT,
      resolved: CLASSROOM_DAY,
    };
    const ctx = makeCtx({
      location: "二年 B 组教室",
      timeOfDay: "day",
      previous,
    });
    const result = await handler(ctx);

    expect(result.skipped).toBe(true);
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(result.events).toBeUndefined();
  });

  it("5. unmatched location with the gate open queues a generate-requested event", async () => {
    const ctx = makeCtx({
      location: "废弃天文台",
      timeOfDay: "day",
      visualHint: "an abandoned observatory at dusk",
      generatedRows: [],
      userSettings: { autoGenerateScenes: true, maxGeneratedScenes: 10 },
    });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      source: "pending",
      day: null,
      night: null,
      resolved: null,
      sourceLabel: { zh: "背景生成中…", en: "Generating…" },
    });
    const sceneId = proposals[0].payload.value.sceneId;
    expect(sceneId).toMatch(/^gen-[0-9a-f]{8}$/);
    expect(result.events).toEqual([
      {
        topic: "scene-stage.generate.requested",
        data: {
          sceneId,
          location: "废弃天文台",
          visualHint: "an abandoned observatory at dusk",
          variant: "day",
        },
      },
    ]);
  });

  it("6a. unmatched location with the gate closed resolves source=none, no event", async () => {
    const ctx = makeCtx({
      location: "废弃天文台",
      userSettings: { autoGenerateScenes: false, maxGeneratedScenes: 10 },
    });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      source: "none",
      resolved: null,
      sourceLabel: { zh: "无背景", en: "No backdrop" },
    });
    expect(result.events).toBeUndefined();
  });

  it("6b. unmatched location at the per-session generation cap resolves source=none", async () => {
    const generatedRows = Array.from({ length: 10 }, (_, i) => ({
      key: `gen-${i}`,
      value: {
        sceneId: `gen-${i}`,
        location: `地点${i}`,
        day: SESSION_DAY,
        night: null,
      },
    }));
    const ctx = makeCtx({
      location: "废弃天文台",
      generatedRows,
      userSettings: { autoGenerateScenes: true, maxGeneratedScenes: 10 },
    });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value.source).toBe("none");
    expect(result.events).toBeUndefined();
  });

  it("7. session-generated scene match resolves source=session", async () => {
    const generatedRows = [
      {
        key: "gen-abcd1234",
        value: {
          sceneId: "gen-abcd1234",
          location: "地下室",
          day: SESSION_DAY,
          night: null,
        },
      },
    ];
    const ctx = makeCtx({ location: "地下室", generatedRows });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "gen-abcd1234",
      source: "session",
      day: SESSION_DAY,
      resolved: SESSION_DAY,
      sourceLabel: { zh: "本局生成", en: "Generated this session" },
    });
  });

  it("7b. session match missing the requested variant backfills via generate-requested when gated open", async () => {
    const generatedRows = [
      {
        key: "gen-abcd1234",
        value: {
          sceneId: "gen-abcd1234",
          location: "地下室",
          day: SESSION_DAY,
          night: null,
        },
      },
    ];
    const ctx = makeCtx({
      location: "地下室",
      timeOfDay: "night",
      generatedRows,
      userSettings: { autoGenerateScenes: true, maxGeneratedScenes: 10 },
    });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "gen-abcd1234",
      source: "session",
      variant: "night",
      night: null,
      resolved: SESSION_DAY,
    });
    expect(result.events).toEqual([
      {
        topic: "scene-stage.generate.requested",
        data: { sceneId: "gen-abcd1234", location: "地下室", variant: "night" },
      },
    ]);
  });

  it("7c. session match missing the requested variant only falls back, no event, when the gate is closed", async () => {
    const generatedRows = [
      {
        key: "gen-abcd1234",
        value: {
          sceneId: "gen-abcd1234",
          location: "地下室",
          day: SESSION_DAY,
          night: null,
        },
      },
    ];
    const ctx = makeCtx({
      location: "地下室",
      timeOfDay: "night",
      generatedRows,
      userSettings: { autoGenerateScenes: false, maxGeneratedScenes: 10 },
    });
    const result = await handler(ctx);

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      source: "session",
      variant: "night",
      resolved: SESSION_DAY,
    });
    expect(result.events).toBeUndefined();
  });

  it("8a. skips without writing when there is no trigger event", async () => {
    const ctx = makeCtx({ location: "二年 B 组教室", noTriggerEvent: true });
    const result = await handler(ctx);

    expect(result.skipped).toBe(true);
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(ctx.pluginData.get).not.toHaveBeenCalled();
  });

  it("8b. skips without writing when location is empty", async () => {
    const ctx = makeCtx({ location: "   " });
    const result = await handler(ctx);

    expect(result.skipped).toBe(true);
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(ctx.pluginData.get).not.toHaveBeenCalled();
  });

  it("9. day-to-night switch on the same scene writes a new variant, not a no-op", async () => {
    const previous = {
      sceneId: "classroom",
      name: "二年 B 组教室",
      variant: "day",
      source: "world",
      day: CLASSROOM_DAY,
      night: CLASSROOM_NIGHT,
      resolved: CLASSROOM_DAY,
    };
    const ctx = makeCtx({
      location: "二年 B 组教室",
      timeOfDay: "night",
      previous,
    });
    const result = await handler(ctx);

    expect(result.skipped).toBeUndefined();
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "classroom",
      variant: "night",
      resolved: CLASSROOM_NIGHT,
    });
  });
});
