import { describe, expect, it, vi } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../runtimes/seed/handler.js";

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
    { sceneId: "library", name: "图书馆", day: LIBRARY_DAY, night: null },
  ],
};

function makeCtx({ registry = REGISTRY, previous = null, noPluginData } = {}) {
  const get = vi.fn(async (namespace, key) => {
    if (namespace === "scenes" && key === "scene-registry") return registry;
    if (namespace === "stage" && key === "current") return previous;
    return null;
  });
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/seed",
    sessionId: "sess-1",
    turnId: "turn-1",
    pluginData: noPluginData
      ? undefined
      : { get, set: vi.fn(), list: vi.fn(), delete: vi.fn() },
  };
}

describe("scene-stage seed handler", () => {
  it("seeds the registry's first scene as the day variant", async () => {
    const result = await handler(makeCtx());

    expect(result.completion).toBe("done");
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      type: "plugin.data",
      source: { pluginId: "scene-stage", runtimeId: "scene-stage/seed" },
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

  it("never overwrites a stage the narrative already established", async () => {
    const previous = { sceneId: "library", name: "图书馆", variant: "night" };
    const result = await handler(makeCtx({ previous }));

    expect(result.value).toMatchObject({ skipped: true });
    expect(getPendingProposals(result)).toHaveLength(0);
    expect(result.completion).toBe("done");
  });

  it("stays a no-op for worlds that ship no scene registry", async () => {
    const result = await handler(makeCtx({ registry: null }));

    expect(result.value).toMatchObject({
      skipped: true,
      reason: "no scene registry",
    });
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("skips an empty scenes array rather than seeding a blank stage", async () => {
    const registry = { schemaVersion: 1, scenes: [] };
    const result = await handler(makeCtx({ registry }));

    expect(result.value).toMatchObject({ skipped: true });
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("reports done even without plugin-data access so setup can never wedge", async () => {
    const result = await handler(makeCtx({ noPluginData: true }));

    expect(result.completion).toBe("done");
    expect(result.outcome).toBe("success");
  });
});
