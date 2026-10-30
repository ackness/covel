import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";
import handler from "../runtimes/story-cues/handler.js";

const registry = {
  moods: [{ id: "Low Lamps" }],
  tracks: [{ id: "battle", file: "battle.mp3", moods: ["tense"] }],
};
function context(story, state = {}, tracks = registry) {
  return {
    pluginId: "soundtrack",
    runtimeId: "soundtrack/story-cues",
    sessionId: "s",
    turnId: "turn-1",
    inputs: story
      ? {
          story: {
            cardinality: "one",
            value: story,
            source: {
              pluginId: "story-fixture",
              runtimeId: "story-fixture",
              resultId: "story-result",
            },
          },
        }
      : {},
    pluginData: {
      get: async (namespace, key) =>
        namespace === "tracks" ? tracks : state[key],
    },
  };
}
const written = (result) =>
  getPendingProposals(result).map(({ payload }) => payload);

describe("soundtrack story cues", () => {
  it.each([
    [" Tense ", "tense"],
    ["lowlamps", "Low Lamps"],
    [" SILENCE ", "silence"],
  ])("records the world's spelling for %s", async (mood, expected) => {
    const result = await handler(context({ cues: { mood } }));
    expect(getToolContent(result).outcome).toBe("success");
    expect(written(result)).toEqual([
      {
        namespace: "state",
        key: "mood",
        value: { mood: expected, turnId: "turn-1" },
      },
    ]);
  });

  it("skips a repeated mood", async () => {
    const result = await handler(
      context({ cues: { mood: "Tense" } }, { mood: { mood: "tense" } }),
    );
    expect(result.value).toEqual({
      skipped: true,
      reason: "no-op: mood unchanged",
    });
    expect(written(result)).toEqual([]);
  });

  it("keeps the current mood and reports an unknown mood", async () => {
    const result = await handler(
      context({ cues: { mood: "happy" } }, { mood: { mood: "tense" } }),
    );
    expect(result).toMatchObject({
      outcome: "success",
      value: { skipped: true, reason: "mood not in this world's list" },
    });
    expect(written(result)).toEqual([]);
  });

  it("records a trimmed scene without a scene plugin", async () => {
    const result = await handler(context({ cues: { scene: " Library " } }));
    expect(written(result)).toEqual([
      {
        namespace: "state",
        key: "scene",
        value: { name: "Library", turnId: "turn-1" },
      },
    ]);
  });

  it("skips an unchanged scene", async () => {
    const result = await handler(
      context({ cues: { scene: " Library " } }, { scene: { name: "Library" } }),
    );
    expect(result.value).toEqual({
      skipped: true,
      reason: "no-op: scene unchanged",
    });
    expect(written(result)).toEqual([]);
  });

  it("records both facts, and still follows a scene when its mood is unknown", async () => {
    const both = await handler(
      context({ cues: { scene: "Library", mood: "Tense" } }),
    );
    expect(written(both).map(({ key }) => key)).toEqual(["mood", "scene"]);
    const partial = await handler(
      context({ cues: { scene: "Library", mood: "happy" } }),
    );
    expect(written(partial).map(({ key }) => key)).toEqual(["scene"]);
    expect(getToolContent(partial).value.reasons).toContain(
      "mood not in this world's list",
    );
  });

  it.each([null, { tracks: [] }])(
    "skips a world with no track list: %j",
    async (tracks) => {
      const result = await handler(
        context({ cues: { mood: "tense", scene: "Library" } }, {}, tracks),
      );
      expect(result.value).toEqual({
        skipped: true,
        reason: "the world ships no track list",
      });
      expect(written(result)).toEqual([]);
    },
  );

  it.each([
    undefined,
    { narrativeOutput: "A quiet evening." },
    { cues: {} },
    { cues: { present: ["Aya"] } },
  ])("skips a story without relevant cues: %j", async (story) => {
    const result = await handler(context(story));
    expect(result).toMatchObject({
      outcome: "success",
      value: { skipped: true, reason: expect.any(String) },
    });
    expect(written(result)).toEqual([]);
  });
});
