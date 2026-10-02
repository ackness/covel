import { describe, expect, it } from "vitest";
import {
  applySceneSetPreview,
  applyStageDirectionPreview,
  resolveStageSpeakers,
} from "../lib/stage-view.js";
type StageCurrentRecord = Record<string, unknown>;
type StageSpeaker = {
  id: string;
  name: string;
  position?: string;
  visual?: Record<string, string>;
};
const ref = (id: string) => ({ id, mime: "image/png", size: 100 });

describe("applySceneSetPreview", () => {
  const registry = {
    scenes: [
      {
        sceneId: "classroom",
        name: "二年 B 组",
        locationRef: "教室",
        day: ref("classroom-day"),
        night: ref("classroom-night"),
      },
    ],
  };

  it("switches to imported day/night art immediately", () => {
    expect(
      applySceneSetPreview(
        undefined,
        registry,
        { location: "二年 B 组", timeOfDay: "night" },
        "turn-2",
      ),
    ).toMatchObject({
      sceneId: "classroom",
      name: "二年 B 组",
      variant: "night",
      source: "world",
      resolved: ref("classroom-night"),
      turnId: "turn-2",
    });
  });

  it("uses normalized locationRef matching", () => {
    expect(
      applySceneSetPreview(undefined, registry, {
        location: " 教 室 ",
        timeOfDay: "day",
      }),
    ).toMatchObject({ resolved: ref("classroom-day") });
  });

  it("previews an unknown scene without a backdrop, as the resolver will", () => {
    const previous: StageCurrentRecord = {
      sceneId: "classroom",
      name: "二年 B 组",
      source: "world",
      resolved: ref("classroom-day"),
    };
    expect(
      applySceneSetPreview(previous, registry, {
        location: "学生会室",
        timeOfDay: "day",
      }),
    ).toMatchObject({ name: "学生会室", source: "none", resolved: undefined });
  });
});

describe("resolveStageSpeakers", () => {
  const fallback: StageSpeaker[] = [{ id: "legacy-rin", name: "朝仓凛" }];

  it("uses scene-cast until direction state exists", () => {
    expect(resolveStageSpeakers(undefined, fallback)).toEqual(fallback);
  });

  it("treats an explicit empty actor list as an authoritative stage clear", () => {
    expect(resolveStageSpeakers({ actors: [] }, fallback)).toEqual([]);
  });

  it("moves the focused actor first and preserves visual requests", () => {
    expect(
      resolveStageSpeakers(
        {
          actors: [
            {
              characterId: "rin",
              displayName: "朝仓凛",
              position: "left",
              visual: { outfit: "uniform", expression: "neutral" },
            },
            {
              characterId: "kaho",
              displayName: "椎名夏帆",
              active: true,
              position: "right",
              transition: "dissolve",
              visual: { variantId: "summer-smile" },
            },
          ],
        },
        fallback,
      ),
    ).toEqual([
      {
        id: "kaho",
        name: "椎名夏帆",
        position: "right",
        transition: "dissolve",
        visual: { variantId: "summer-smile" },
      },
      {
        id: "rin",
        name: "朝仓凛",
        position: "left",
        visual: { outfit: "uniform", expression: "neutral" },
      },
    ]);
  });

  it("drops duplicate or invalid explicit positions for automatic placement", () => {
    expect(
      resolveStageSpeakers(
        {
          actors: [
            { characterId: "a", displayName: "A", position: "left" },
            { characterId: "b", displayName: "B", position: "left" },
            { characterId: "c", displayName: "C", position: "ceiling" },
          ],
        },
        fallback,
      ),
    ).toEqual([
      { id: "a", name: "A", position: "left" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ]);
  });
});

describe("applyStageDirectionPreview", () => {
  const presence = {
    rin: { characterId: "rin", displayName: "朝仓凛" },
    kaho: { characterId: "kaho", displayName: "椎名夏帆" },
  };

  it("applies enter, visual, position and focus cues before commit", () => {
    const result = applyStageDirectionPreview(
      [
        {
          id: "rin",
          name: "朝仓凛",
          position: "left",
          visual: { variantId: "uniform-playful", outfit: "uniform" },
        },
      ],
      presence,
      [
        {
          type: "actor.update",
          character: "凛",
          expression: "surprised",
        },
        {
          type: "actor.enter",
          character: "椎名夏帆",
          position: "right",
          variantId: "summer-smile",
          transition: "slide-right",
          focus: true,
        },
      ],
    );
    expect(result).toEqual([
      {
        id: "kaho",
        name: "椎名夏帆",
        position: "right",
        visual: { variantId: "summer-smile" },
        transition: "slide-right",
      },
      {
        id: "rin",
        name: "朝仓凛",
        position: "left",
        visual: { outfit: "uniform", expression: "surprised" },
      },
    ]);
  });

  it("previews an authoritative clear with exits and ignores unresolved actors", () => {
    expect(
      applyStageDirectionPreview([{ id: "rin", name: "朝仓凛" }], presence, [
        { type: "actor.update", character: "不存在", expression: "smile" },
        { type: "stage.clear" },
      ]),
    ).toEqual([
      {
        id: "rin",
        name: "朝仓凛",
        exiting: true,
        transition: "fade",
      },
    ]);
  });

  it("admits new actors after a full stage is cleared in the same event", () => {
    const fullStage = ["a", "b", "c", "d"].map((id) => ({
      id,
      name: id.toUpperCase(),
    }));
    const result = applyStageDirectionPreview(
      fullStage,
      {
        ...presence,
        newcomer: { characterId: "newcomer", displayName: "Newcomer" },
      },
      [
        { type: "stage.clear", transition: "fade" },
        { type: "actor.enter", character: "Newcomer", focus: true },
      ],
    );

    expect(result).toHaveLength(4);
    expect(result[0]).toMatchObject({
      id: "newcomer",
      name: "Newcomer",
    });
    expect(result.filter((actor) => actor.exiting)).toHaveLength(3);
  });

  it("keeps a leaving actor for the requested speculative exit animation", () => {
    expect(
      applyStageDirectionPreview(
        [
          { id: "rin", name: "朝仓凛", position: "left" },
          { id: "kaho", name: "椎名夏帆", position: "right" },
        ],
        presence,
        [
          {
            type: "actor.leave",
            character: "朝仓凛",
            transition: "slide-left",
          },
        ],
      ),
    ).toEqual([
      {
        id: "rin",
        name: "朝仓凛",
        position: "left",
        exiting: true,
        transition: "slide-left",
      },
      { id: "kaho", name: "椎名夏帆", position: "right" },
    ]);
  });
});
