import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it, vi } from "vitest";

import handler from "../runtimes/resolver/handler.js";

const TOPIC = "scene.set";

function ref(id) {
  return { id: id.repeat(64).slice(0, 64), mime: "image/png", size: 1024 };
}

const CLASSROOM_DAY = ref("1");
const CLASSROOM_NIGHT = ref("2");
const LIBRARY_DAY = ref("3");

const REGISTRY = {
  schemaVersion: 1,
  registryId: "scene-registry",
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
  registry = REGISTRY,
  previous = null,
  noTriggerEvent = false,
} = {}) {
  const get = vi.fn(async (namespace, key) => {
    if (namespace === "scenes" && key === "scene-registry") return registry;
    if (namespace === "stage" && key === "current") return previous;
    return null;
  });
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/resolver",
    sessionId: "sess-1",
    turnId: "turn-1",
    triggerEvent: noTriggerEvent
      ? undefined
      : { topic: TOPIC, data: { location, timeOfDay } },
    pluginData: { get, set: vi.fn(), list: vi.fn(), delete: vi.fn() },
  };
}

// The handler returns the canonical HandlerResult; the business value (stage /
// skipped marker) is under `getToolContent(result).value`.
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
          variantLabel: { zh: "白天", en: "Day" },
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

    expect(getToolContent(result).value.skipped).toBe(true);
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(getToolContent(result).effects?.events).toBeUndefined();
  });

  it("5. unmatched location has no backdrop and requests nothing", async () => {
    const result = await handler(makeCtx({ location: "废弃天文台" }));

    const proposals = getPendingProposals(result);
    expect(proposals[0].payload.value).toMatchObject({
      name: "废弃天文台",
      source: "none",
      day: null,
      night: null,
      resolved: null,
      sourceLabel: { zh: "无背景", en: "No backdrop" },
    });
    expect(proposals[0].payload.value.sceneId).toMatch(/^loc-[0-9a-f]{8}$/);
    expect(getToolContent(result).effects).toBeUndefined();
  });

  it("6. re-emitted scene.set for the same unmatched location is a no-op", async () => {
    const location = "废弃天文台";
    const first = await handler(makeCtx({ location }));
    const stage = getPendingProposals(first)[0].payload.value;

    const result = await handler(makeCtx({ location, previous: stage }));

    expect(getToolContent(result).value).toMatchObject({
      skipped: true,
      reason: "no-op: scene/variant unchanged",
    });
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("8a. skips without writing when there is no trigger event", async () => {
    const ctx = makeCtx({ location: "二年 B 组教室", noTriggerEvent: true });
    const result = await handler(ctx);

    expect(getToolContent(result).value.skipped).toBe(true);
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(ctx.pluginData.get).not.toHaveBeenCalled();
  });

  it("8b. skips without writing when location is empty", async () => {
    const ctx = makeCtx({ location: "   " });
    const result = await handler(ctx);

    expect(getToolContent(result).value.skipped).toBe(true);
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

    expect(getToolContent(result).value.skipped).toBeUndefined();
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.value).toMatchObject({
      sceneId: "classroom",
      variant: "night",
      resolved: CLASSROOM_NIGHT,
    });
  });
});
