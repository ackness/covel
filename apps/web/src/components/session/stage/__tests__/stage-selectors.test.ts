import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import {
  computeSpriteSlots,
  extractInteractionChoices,
  mergeChoices,
  resolveBackdrop,
  type StageCurrentRecord,
  type StageSpeaker,
} from "../stage-selectors.js";

const worldVisual: WorldVisual = {
  image: "/visuals/worlds/haruka-academy.webp",
  accent: "oklch(72% 0.15 350)",
  label: "Haruka Academy",
};

const ref = (id: string) => ({ id, mime: "image/png", size: 100 });

describe("resolveBackdrop", () => {
  it("有图: a resolved MediaRef renders the scene", () => {
    const stage: StageCurrentRecord = {
      name: "教室",
      source: "world",
      resolved: ref("scene-1"),
    };
    expect(resolveBackdrop(stage, worldVisual)).toEqual({
      kind: "scene",
      ref: ref("scene-1"),
    });
  });

  it("pending: generating keeps the previous frame (or hero) with a badge", () => {
    const stage: StageCurrentRecord = {
      name: "unknown-alley",
      source: "pending",
      resolved: null,
    };
    expect(resolveBackdrop(stage, worldVisual)).toEqual({
      kind: "previous-or-hero",
      pendingBadge: true,
    });
  });

  it("none: explicit no-art location falls back to the world hero image", () => {
    const stage: StageCurrentRecord = {
      name: "storage-closet",
      source: "none",
      resolved: null,
    };
    expect(resolveBackdrop(stage, worldVisual)).toEqual({
      kind: "hero",
      ref: worldVisual.image,
    });
  });

  it("无数据: no scene-stage record at all falls back to a theme gradient", () => {
    expect(resolveBackdrop(null, worldVisual)).toEqual({ kind: "gradient" });
    expect(resolveBackdrop(undefined, worldVisual)).toEqual({
      kind: "gradient",
    });
  });
});

describe("computeSpriteSlots", () => {
  const speakers: StageSpeaker[] = [
    { id: "lin", name: "林月" },
    { id: "archivist", name: "档案员" },
    { id: "ghost", name: "无立绘的角色" },
  ];

  it("1 speaker stations at right", () => {
    const presence = { lin: { sprite: ref("lin-sprite") } };
    const slots = computeSpriteSlots(speakers.slice(0, 1), presence);
    expect(slots).toEqual([
      {
        characterId: "lin",
        displayName: "林月",
        ref: ref("lin-sprite"),
        active: true,
        pos: "right",
      },
    ]);
  });

  it("2 speakers split left/right", () => {
    const presence = {
      lin: { sprite: ref("lin-sprite") },
      archivist: { sprite: ref("archivist-sprite") },
    };
    const slots = computeSpriteSlots(speakers.slice(0, 2), presence);
    expect(slots.map((s) => s.pos)).toEqual(["left", "right"]);
  });

  it("3-4 speakers distribute evenly", () => {
    const presence = {
      lin: { sprite: ref("lin-sprite") },
      archivist: { sprite: ref("archivist-sprite") },
      ghost: { sprite: ref("ghost-sprite") },
    };
    const slots = computeSpriteSlots(speakers, presence);
    expect(slots.map((s) => s.pos)).toEqual(["left", "center", "right"]);
  });

  it("marks speakers[0] active, and drops characters with no sprite/avatar", () => {
    const presence = {
      lin: { sprite: ref("lin-sprite") },
      archivist: { avatar: ref("archivist-avatar") }, // falls back to avatar
      // ghost has no presence entry at all — filtered out
    };
    const slots = computeSpriteSlots(speakers, presence);
    expect(slots).toHaveLength(2);
    expect(slots.find((s) => s.characterId === "lin")?.active).toBe(true);
    expect(slots.find((s) => s.characterId === "archivist")?.active).toBe(
      false,
    );
    expect(slots.find((s) => s.characterId === "archivist")?.ref).toEqual(
      ref("archivist-avatar"),
    );
    expect(slots.some((s) => s.characterId === "ghost")).toBe(false);
  });
});

describe("extractInteractionChoices", () => {
  function choiceMessage(
    overrides: Partial<StreamMessage> = {},
  ): StreamMessage {
    return {
      id: "msg-choice-1",
      role: "assistant",
      content: "",
      timestamp: "2026-07-03T00:00:00.000Z",
      turnId: "turn-1",
      block: {
        type: "interactive_choice",
        data: {
          type: "choice",
          interactionId: "pick-path",
          prompt: "How do you respond?",
          choices: [
            { id: "a", label: "Agree" },
            { id: "b", label: "Refuse", description: "Walk away" },
          ],
        },
      },
      ...overrides,
    };
  }

  it("returns the pending choice block when nothing has been submitted", () => {
    const messages = [choiceMessage()];
    const result = extractInteractionChoices(messages, new Set());
    expect(result).toEqual([
      {
        blockId: "msg-choice-1",
        turnId: "turn-1",
        interactionId: "pick-path",
        prompt: "How do you respond?",
        choices: [
          { id: "a", label: "Agree" },
          { id: "b", label: "Refuse", description: "Walk away" },
        ],
        submitBehavior: undefined,
      },
    ]);
  });

  it("returns nothing once the block is submitted", () => {
    const messages = [choiceMessage()];
    const result = extractInteractionChoices(
      messages,
      new Set(["msg-choice-1"]),
    );
    expect(result).toEqual([]);
  });

  it("returns nothing once a later player message supersedes the block", () => {
    const messages = [
      choiceMessage(),
      {
        id: "msg-2",
        role: "user",
        content: "Agree",
        timestamp: "2026-07-03T00:00:01.000Z",
      } satisfies StreamMessage,
    ];
    expect(extractInteractionChoices(messages, new Set())).toEqual([]);
  });
});

describe("mergeChoices", () => {
  const interactionChoices = [
    {
      blockId: "block-1",
      turnId: "turn-1",
      interactionId: "pick-path",
      prompt: "How do you respond?",
      choices: [
        { id: "a", label: "Agree" },
        { id: "b", label: "Refuse" },
      ],
    },
  ];

  it("orders interaction choices before scene-prompts, unpacking prompt{N} by ascending N", () => {
    const prompts = {
      scene: "library",
      prompt2Text: "追问档案员",
      prompt2Label: { zh: "追问", en: "Ask" },
      prompt2Icon: "lightbulb",
      prompt2Color: "purple",
      prompt1Text: "环顾四周",
      prompt1Label: { zh: "观察", en: "Observe" },
      prompt1Icon: "eye",
      prompt1Color: "blue",
    };
    const merged = mergeChoices(interactionChoices, prompts, "zh-CN");

    expect(merged.items.map((i) => i.kind)).toEqual([
      "interaction",
      "interaction",
      "prompt",
      "prompt",
    ]);
    const promptItems = merged.items.filter((i) => i.kind === "prompt");
    expect(promptItems.map((i) => i.label)).toEqual(["环顾四周", "追问档案员"]);
    expect(promptItems[0]).toMatchObject({
      description: "观察",
      icon: "eye",
      color: "blue",
    });
    expect(merged.twoColumn).toBe(false);
  });

  it("skips empty prompt slots", () => {
    const prompts = {
      prompt1Text: "环顾四周",
      prompt1Label: { zh: "观察", en: "Observe" },
      prompt2Text: "",
      prompt3Text: "   ",
      prompt4Text: "追问档案员",
      prompt4Label: { zh: "追问", en: "Ask" },
    };
    const merged = mergeChoices([], prompts, "zh-CN");
    expect(merged.items.map((i) => i.label)).toEqual([
      "环顾四周",
      "追问档案员",
    ]);
  });

  it("marks the list two-column once combined items exceed 6", () => {
    const prompts = {
      prompt1Text: "p1",
      prompt2Text: "p2",
      prompt3Text: "p3",
      prompt4Text: "p4",
      prompt5Text: "p5",
      prompt6Text: "p6",
    };
    const manyInteraction = [
      {
        blockId: "block-1",
        turnId: "turn-1",
        interactionId: "pick-path",
        prompt: "",
        choices: [{ id: "a", label: "Agree" }],
      },
    ];
    const merged = mergeChoices(manyInteraction, prompts, "zh-CN");
    expect(merged.items).toHaveLength(7);
    expect(merged.twoColumn).toBe(true);
  });
});
