import {
  getPendingProposals,
  getToolContent,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it } from "vitest";
import handler from "../runtimes/story-cues/handler.js";

const day = { id: "a".repeat(64), mime: "image/png", size: 10 };
const night = { id: "b".repeat(64), mime: "image/png", size: 10 };
const characters = [
  { id: "aya", name: "阿雅", aliases: ["雅"], type: "npc" },
  { id: "chen", name: "陈远", type: "npc" },
  { id: "lin", name: "林月", type: "npc" },
  { id: "mei", name: "小梅", type: "npc" },
  { id: "rui", name: "小瑞", type: "npc" },
];
const aya = {
  characterId: "aya",
  displayName: "阿雅",
  active: true,
  position: "right",
  visual: { outfit: "uniform", expression: "smile" },
};
function context(story, data = {}, world = { characters, seats: [] }) {
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/story-cues",
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
    world,
    pluginData: {
      get: async (namespace, key) =>
        ({
          "scenes/scene-registry": {
            scenes: [{ sceneId: "library", name: "图书馆", day, night }],
          },
          ...data,
        })[`${namespace}/${key}`] ?? null,
    },
  };
}
const written = (result) =>
  getPendingProposals(result).map(({ payload }) => payload);
const directionOf = (result) =>
  written(result).find(({ namespace }) => namespace === "direction")?.value;

describe("scene-stage story cues", () => {
  it("matches a scene, keeps night, and resets its previous actors", async () => {
    const result = await handler(
      context(
        { cues: { scene: " 图书馆二楼 " } },
        {
          "stage/current": {
            sceneId: "classroom",
            variant: "night",
            source: "world",
          },
          "direction/current": { actors: [aya] },
        },
      ),
    );
    expect(written(result)).toMatchObject([
      {
        namespace: "stage",
        key: "current",
        value: { sceneId: "library", variant: "night", resolved: night },
      },
      {
        namespace: "direction",
        key: "current",
        value: { schemaVersion: 1, actors: [] },
      },
    ]);
  });

  it("writes nothing for the same scene, including a more specific location name", async () => {
    const result = await handler(
      context(
        { cues: { scene: "图书馆二楼" } },
        {
          "stage/current": {
            sceneId: "library",
            variant: "night",
            source: "world",
          },
          "direction/current": { actors: [aya] },
        },
      ),
    );
    expect(result.value).toMatchObject({
      skipped: true,
      reason: "no-op: scene unchanged",
    });
    expect(written(result)).toEqual([]);
  });

  it("uses day initially and leaves an unregistered location without a backdrop", async () => {
    const result = await handler(context({ cues: { scene: "废弃天文台" } }));
    expect(written(result)).toMatchObject([
      {
        namespace: "stage",
        value: { variant: "day", source: "none", resolved: null },
      },
    ]);
  });

  it("keeps continuing actors' positions and visuals, enters new actors, and removes absent actors", async () => {
    const result = await handler(
      context(
        {
          cues: { present: ["阿雅", "陈远"] },
          segments: [
            { kind: "dialogue", speaker: "阿雅", text: "你好。" },
            { kind: "dialogue", speaker: "陈远", text: "走吧。" },
            { kind: "narration", speaker: "阿雅", text: "雨停了。" },
          ],
        },
        {
          "direction/current": {
            actors: [
              aya,
              { characterId: "lin", displayName: "林月", position: "left" },
            ],
          },
        },
      ),
    );
    expect(directionOf(result).actors).toEqual([
      { ...aya, active: false },
      {
        characterId: "chen",
        displayName: "陈远",
        active: true,
        position: "left",
        transition: "fade",
      },
    ]);
  });

  it("uses exact aliases, deduplicates names, and focuses the last resolved action speaker", async () => {
    const result = await handler(
      context({
        cues: { present: ["雅", "阿雅", "陈远", "陈", "不存在"] },
        segments: [
          { kind: "dialogue", speaker: "陈远", text: "来吗？" },
          { kind: "action", speaker: "雅", text: "点头。" },
          { kind: "dialogue", speaker: "不存在", text: "回声。" },
        ],
      }),
    );
    expect(
      directionOf(result).actors.map(({ characterId, active }) => [
        characterId,
        active,
      ]),
    ).toEqual([
      ["aya", true],
      ["chen", false],
    ]);
    expect(getToolContent(result).value.diagnostics).toEqual([
      "unresolved character: 陈",
      "unresolved character: 不存在",
    ]);
  });

  it("caps resolved actors at four and fills free positions from left to right", async () => {
    const result = await handler(
      context({ cues: { present: characters.map(({ name }) => name) } }),
    );
    expect(
      directionOf(result).actors.map(({ characterId, position }) => [
        characterId,
        position,
      ]),
    ).toEqual([
      ["aya", "left"],
      ["chen", "center-left"],
      ["lin", "center"],
      ["mei", "center-right"],
    ]);
  });

  it.each([undefined, [], ["Unknown"]])(
    "keeps focus on a continuing actor when no staged speaker resolves: %j",
    async (speakers) => {
      const result = await handler(
        context(
          {
            cues: { present: ["陈远", "阿雅"] },
            segments: speakers?.map((speaker) => ({
              kind: "dialogue",
              speaker,
              text: "Hello",
            })),
          },
          { "direction/current": { actors: [aya] } },
        ),
      );
      expect(
        directionOf(result).actors.find(({ active }) => active).characterId,
      ).toBe("aya");
    },
  );

  it("starts presence afresh after a scene change with a single direction write", async () => {
    const result = await handler(
      context(
        { cues: { scene: "图书馆", present: ["阿雅"] } },
        {
          "stage/current": { sceneId: "classroom", variant: "night" },
          "direction/current": { actors: [aya] },
        },
      ),
    );
    expect(written(result).map(({ namespace }) => namespace)).toEqual([
      "stage",
      "direction",
    ]);
    expect(directionOf(result).actors).toEqual([
      {
        characterId: "aya",
        displayName: "阿雅",
        active: true,
        position: "left",
        transition: "fade",
      },
    ]);
  });

  it("excludes only the primary seat's current character, including when it has NPC type", async () => {
    const world = {
      characters: characters.map((character) =>
        character.id === "chen" ? { ...character, type: "player" } : character,
      ),
      seats: [
        {
          id: "primary",
          controller: "human",
          role: "player",
          characters: ["chen", "aya"],
          currentCharacterId: "aya",
        },
      ],
    };
    const result = await handler(
      context(
        { cues: { present: ["雅", "陈远"] } },
        { "direction/current": { actors: [aya] } },
        world,
      ),
    );
    expect(
      directionOf(result).actors.map(({ characterId }) => characterId),
    ).toEqual(["chen"]);
  });

  it.each([undefined, []])(
    "does not replace direction without a non-empty presence cue: %j",
    async (present) => {
      const result = await handler(
        context(
          { cues: { present, mood: "tense" } },
          { "direction/current": { actors: [aya] } },
        ),
      );
      expect(result.value.skipped).toBe(true);
      expect(written(result)).toEqual([]);
    },
  );

  it("removes old actors when a non-empty presence list resolves no names", async () => {
    const result = await handler(
      context(
        { cues: { present: ["Unknown"] } },
        { "direction/current": { actors: [aya] } },
      ),
    );
    expect(directionOf(result).actors).toEqual([]);
  });

  it.each([undefined, { narrativeOutput: "A quiet evening." }, { cues: {} }])(
    "skips absent story cues: %j",
    async (story) => {
      const result = await handler(context(story));
      expect(result).toMatchObject({
        outcome: "success",
        value: { skipped: true, reason: expect.any(String) },
      });
      expect(written(result)).toEqual([]);
    },
  );
});
