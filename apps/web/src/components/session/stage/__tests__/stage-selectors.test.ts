import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import {
  applySceneSetPreview,
  applyStageDirectionPreview,
  assignStations,
  computeSpriteLanes,
  computeSpriteSlots,
  deriveDecisionRecapFallback,
  extractInteractionChoices,
  extractPendingFormMessages,
  filterStalePrompts,
  hasSubmittedForm,
  initialStageReadStoryKey,
  mergeChoices,
  pluginIdForCapability,
  resolveBackdrop,
  resolveStageSpeakers,
  stageStoryKey,
  type SpritePosition,
  type StageCurrentRecord,
  type StageSpeaker,
} from "../stage-selectors.js";

const worldVisual: WorldVisual = {
  image: "/visuals/worlds/haruka-academy.webp",
  accent: "oklch(72% 0.15 350)",
  label: "Haruka Academy",
};

const ref = (id: string) => ({ id, mime: "image/png", size: 100 });

describe("stage story identity", () => {
  it("keeps streaming and durable messages in one turn on the same key", () => {
    expect(
      stageStoryKey({ id: "stream_turn-1_narrator", turnId: "turn-1" }),
    ).toBe("turn-1");
    expect(stageStoryKey({ id: "message-1", turnId: "turn-1" })).toBe("turn-1");
  });

  it("does not mark a streaming placeholder read on the first stage render", () => {
    expect(
      initialStageReadStoryKey({
        id: "stream_turn-1_narrator",
        turnId: "turn-1",
      }),
    ).toBeUndefined();
    expect(
      initialStageReadStoryKey({ id: "message-1", turnId: "turn-1" }),
    ).toBe("turn-1");
  });
});

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

  it('无数据: no scene-stage record at all shares the "none" fallback (world hero image)', () => {
    expect(resolveBackdrop(null, worldVisual)).toEqual({
      kind: "hero",
      ref: worldVisual.image,
    });
    expect(resolveBackdrop(undefined, worldVisual)).toEqual({
      kind: "hero",
      ref: worldVisual.image,
    });
  });
});

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

  it("keeps the previous frame while an unknown scene awaits resolution", () => {
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
    ).toMatchObject({ name: "学生会室", source: "pending" });
  });
});

describe("computeSpriteSlots", () => {
  // Real shapes: scene-cast keys speakers by the scoped `<sessionId>-<id>`
  // (scopedCharacterId), while character-presence keys records by the bare
  // `characterId`. The join must reconcile the two — a same-string fixture
  // would mask the break.
  const SESSION = "haruka-academy-1a2b3c4d";
  const speakers: StageSpeaker[] = [
    { id: `${SESSION}-lin`, name: "林月" },
    { id: `${SESSION}-archivist`, name: "档案员" },
    { id: `${SESSION}-ghost`, name: "无立绘的角色" },
  ];

  it("joins a scoped speaker id to a bare-keyed presence record", () => {
    const presence = { lin: { characterId: "lin", sprite: ref("lin-sprite") } };
    const slots = computeSpriteSlots(speakers.slice(0, 1), presence);
    expect(slots).toEqual([
      {
        characterId: `${SESSION}-lin`,
        displayName: "林月",
        ref: ref("lin-sprite"),
        active: true,
        pos: "center",
      },
    ]);
  });

  it("matches an unscoped speaker id by exact characterId", () => {
    const presence = { lin: { characterId: "lin", sprite: ref("lin-sprite") } };
    const slots = computeSpriteSlots([{ id: "lin", name: "林月" }], presence);
    expect(slots).toHaveLength(1);
    expect(slots[0].ref).toEqual(ref("lin-sprite"));
  });

  it("2 speakers split left/right", () => {
    const presence = {
      lin: { characterId: "lin", sprite: ref("lin-sprite") },
      archivist: { characterId: "archivist", sprite: ref("archivist-sprite") },
    };
    const slots = computeSpriteSlots(speakers.slice(0, 2), presence);
    expect(slots.map((s) => s.pos)).toEqual(["left", "right"]);
  });

  it("3 speakers: fresh layout centers the primary, wings the rest", () => {
    const presence = {
      lin: { characterId: "lin", sprite: ref("lin-sprite") },
      archivist: { characterId: "archivist", sprite: ref("archivist-sprite") },
      ghost: { characterId: "ghost", sprite: ref("ghost-sprite") },
    };
    const slots = computeSpriteSlots(speakers, presence);
    // Newcomers gravitate to center in salience order (ties break left):
    // primary center, second left, third right.
    expect(slots.map((s) => s.pos)).toEqual(["center", "left", "right"]);
  });

  it("marks speakers[0] active, falls back to avatar, and keeps artless speakers as null slots", () => {
    const presence = {
      lin: { characterId: "lin", sprite: ref("lin-sprite") },
      archivist: { characterId: "archivist", avatar: ref("archivist-avatar") }, // falls back to avatar
      // ghost has no presence entry at all — kept on stage with ref: null
    };
    const slots = computeSpriteSlots(speakers, presence);
    expect(slots).toHaveLength(3);
    expect(slots.find((s) => s.characterId === `${SESSION}-lin`)?.active).toBe(
      true,
    );
    expect(
      slots.find((s) => s.characterId === `${SESSION}-archivist`)?.active,
    ).toBe(false);
    expect(
      slots.find((s) => s.characterId === `${SESSION}-archivist`)?.ref,
    ).toEqual(ref("archivist-avatar"));
    const ghost = slots.find((s) => s.characterId === `${SESSION}-ghost`);
    expect(ghost?.ref).toBeNull();
    expect(ghost?.displayName).toBe("无立绘的角色");
    // stations still count the fallback slot: 3 speakers, primary centered
    expect(slots.map((s) => s.pos)).toEqual(["center", "left", "right"]);
  });

  it("keeps an artless primary speaker on stage as an active null slot (no nameplate mismatch)", () => {
    // The bug: speakers[0] (林月) has no art, only the second speaker does.
    // Dropping 林月 left 档案员's sprite alone while the nameplate said 林月.
    const presence = {
      archivist: { characterId: "archivist", sprite: ref("archivist-sprite") },
    };
    const slots = computeSpriteSlots(speakers.slice(0, 2), presence);
    expect(slots).toHaveLength(2);
    const lin = slots.find((s) => s.characterId === `${SESSION}-lin`);
    expect(lin?.ref).toBeNull();
    expect(lin?.active).toBe(true);
    expect(slots.map((s) => s.pos)).toEqual(["left", "right"]);
  });

  it("moves focus to the first remaining actor while a leaver animates out", () => {
    const presence = {
      lin: { characterId: "lin", sprite: ref("lin-sprite") },
      archivist: { characterId: "archivist", sprite: ref("archivist-sprite") },
    };
    const slots = computeSpriteSlots(
      [
        { id: "lin", name: "林月", exiting: true, transition: "fade" },
        { id: "archivist", name: "档案员" },
      ],
      presence,
    );
    expect(slots[0]).toMatchObject({ exiting: true, active: false });
    expect(slots[1]).toMatchObject({ active: true });
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

describe("assignStations", () => {
  const empty: ReadonlyMap<string, SpritePosition> = new Map();
  const at = (m: ReadonlyMap<string, SpritePosition>, id: string) => m.get(id);

  it("speaker-order swap keeps every station (the sprite-drift regression)", () => {
    const prev = assignStations(empty, ["a", "b"]);
    expect([at(prev, "a"), at(prev, "b")]).toEqual(["left", "right"]);

    // b becomes the primary speaker — salience order flips, nobody moves.
    const next = assignStations(prev, ["b", "a"]);
    expect(at(next, "a")).toBe("left");
    expect(at(next, "b")).toBe("right");
  });

  it("a newcomer fills the free station without moving survivors", () => {
    const prev = assignStations(empty, ["a", "b"]);
    const next = assignStations(prev, ["a", "b", "c"]);
    expect(at(next, "a")).toBe("left");
    expect(at(next, "b")).toBe("right");
    expect(at(next, "c")).toBe("center");
  });

  it("a leaver frees their station without moving survivors", () => {
    const trio = assignStations(assignStations(empty, ["a", "b"]), [
      "a",
      "b",
      "c",
    ]);
    const next = assignStations(trio, ["b", "a"]); // c left, b now primary
    expect(at(next, "a")).toBe("left");
    expect(at(next, "b")).toBe("right");
  });

  it("a solo centered speaker steps aside for a newcomer", () => {
    const solo = assignStations(empty, ["a"]);
    expect(at(solo, "a")).toBe("center");

    const duo = assignStations(solo, ["a", "b"]);
    expect(at(duo, "a")).toBe("left"); // nearest free to center, ties break left
    expect(at(duo, "b")).toBe("right");
  });

  it("an empty cast (sticky narration turn) keeps the memory untouched", () => {
    const prev = assignStations(empty, ["a", "b"]);
    expect(assignStations(prev, [])).toBe(prev);
    // …so the returning cast lands on their old spots, whatever the order.
    const back = assignStations(assignStations(prev, []), ["b", "a"]);
    expect(at(back, "a")).toBe("left");
    expect(at(back, "b")).toBe("right");
  });

  it("a re-entering character prefers their remembered spot", () => {
    const duo = assignStations(empty, ["a", "b"]); // a left, b right
    const solo = assignStations(duo, ["a"]); // b leaves, a re-centers
    expect(at(solo, "a")).toBe("center");

    const back = assignStations(solo, ["a", "b"]); // b returns
    expect(at(back, "b")).toBe("right"); // remembered spot, still free
    expect(at(back, "a")).toBe("left"); // displaced from center, ties break left
  });

  it("is idempotent (safe under StrictMode double render)", () => {
    const prev = assignStations(empty, ["a", "b", "c"]);
    const again = assignStations(prev, ["a", "b", "c"]);
    expect([...again.entries()]).toEqual([...prev.entries()]);
  });
});

describe("computeSpriteLanes", () => {
  it("a lone sprite is capped and centered instead of blanketing the stage", () => {
    expect(computeSpriteLanes(["center"])).toEqual([
      { leftPct: 20, widthPct: 60 },
    ]);
  });

  it("two sprites split the stage into non-overlapping halves", () => {
    expect(computeSpriteLanes(["left", "right"])).toEqual([
      { leftPct: 0, widthPct: 50 },
      { leftPct: 50, widthPct: 50 },
    ]);
  });

  it("lane order follows station rank, not input order", () => {
    expect(computeSpriteLanes(["right", "left"])).toEqual([
      { leftPct: 50, widthPct: 50 },
      { leftPct: 0, widthPct: 50 },
    ]);
  });

  it("speaker focus does not change lane geometry", () => {
    const lanes = computeSpriteLanes(["left", "center", "right"]);
    expect(lanes[0].widthPct).toBeCloseTo(100 / 3, 6);
    expect(lanes[1].widthPct).toBeCloseTo(100 / 3, 6);
    expect(lanes[2].widthPct).toBeCloseTo(100 / 3, 6);
    // Contiguous, no overlap: each lane starts where the previous ends.
    expect(lanes[0].leftPct).toBeCloseTo(0, 6);
    expect(lanes[1].leftPct).toBeCloseTo(lanes[0].widthPct, 6);
    expect(lanes[2].leftPct).toBeCloseTo(
      lanes[1].leftPct + lanes[1].widthPct,
      6,
    );
    expect(lanes[2].leftPct + lanes[2].widthPct).toBeCloseTo(100, 6);
  });

  it("a solo speaker keeps the capped centered lane", () => {
    expect(computeSpriteLanes(["center"])).toEqual([
      { leftPct: 20, widthPct: 60 },
    ]);
  });

  it("lanes tile the stage without overlap for any cast size", () => {
    for (const positions of [
      ["left", "center", "right"],
      ["left", "center-left", "center-right", "right"],
    ] as const) {
      const lanes = computeSpriteLanes(positions);
      const width = 100 / positions.length;
      const sorted = [...lanes].sort((a, b) => a.leftPct - b.leftPct);
      sorted.forEach((lane, i) => {
        expect(lane.widthPct).toBeCloseTo(width, 6);
        expect(lane.leftPct).toBeCloseTo(i * width, 6);
      });
    }
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

describe("extractPendingFormMessages", () => {
  const formMessage: StreamMessage = {
    id: "msg-form-1",
    role: "assistant",
    content: "",
    timestamp: "2026-07-03T00:00:00.000Z",
    turnId: "turn-1",
    block: {
      type: "interactive_form",
      data: {
        type: "form",
        interactionId: "sign-up",
        fields: [{ name: "codename", label: "Codename", required: true }],
      },
    },
  };
  const choiceMessage: StreamMessage = {
    id: "msg-choice-1",
    role: "assistant",
    content: "",
    timestamp: "2026-07-03T00:00:01.000Z",
    turnId: "turn-1",
    block: {
      type: "interactive_choice",
      data: { type: "choice", choices: [{ id: "a", label: "Agree" }] },
    },
  };

  it("returns pending form blocks but not choice blocks", () => {
    const result = extractPendingFormMessages(
      [formMessage, choiceMessage],
      new Set(),
    );
    expect(result).toEqual([formMessage]);
  });

  it("drops a form once it has been submitted", () => {
    expect(
      extractPendingFormMessages([formMessage], new Set(["msg-form-1"])),
    ).toEqual([]);
  });

  describe("hasSubmittedForm", () => {
    it("is false while the opening form is still pending", () => {
      expect(hasSubmittedForm([formMessage, choiceMessage], new Set())).toBe(
        false,
      );
    });

    it("is true once a form block has been submitted", () => {
      expect(hasSubmittedForm([formMessage], new Set(["msg-form-1"]))).toBe(
        true,
      );
    });

    it("ignores submitted non-form blocks (choices)", () => {
      expect(hasSubmittedForm([choiceMessage], new Set(["msg-choice-1"]))).toBe(
        false,
      );
    });
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
      recap: "You followed the archivist into the restricted library.",
      decision: "What will you investigate first?",
      prompt2Text: "追问档案员",
      prompt2Label: { zh: "追问", en: "Ask" },
      prompt1Text: "环顾四周",
      prompt1Label: { zh: "观察", en: "Observe" },
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
    expect(promptItems[0]).toMatchObject({ description: "观察" });
    expect(merged.context).toEqual({
      scene: "library",
      recap: "You followed the archivist into the restricted library.",
      // A pending interaction is authoritative over a generated question.
      decision: "How do you respond?",
    });
    expect(merged.groups).toHaveLength(2);
    expect(merged.groups[0]).toMatchObject({
      id: "interaction:block-1",
      prompt: "How do you respond?",
    });
    expect(merged.groups[1]).toMatchObject({
      id: "scene-prompts",
      prompt: "What will you investigate first?",
    });
    expect(merged.twoColumn).toBe(false);
  });

  it("uses scene-prompts context when no interaction question is pending", () => {
    const merged = mergeChoices(
      [],
      {
        scene: { zh: "雨夜校舍", en: "Rainy school" },
        recap: {
          zh: "你答应放学后去旧校舍找她。",
          en: "You agreed to meet her.",
        },
        decision: {
          zh: "你要从哪一侧进入？",
          en: "Which side will you enter?",
        },
        prompt1Text: "从亮着灯的正门进去",
      },
      "zh-CN",
    );

    expect(merged.context).toEqual({
      scene: "雨夜校舍",
      recap: "你答应放学后去旧校舍找她。",
      decision: "你要从哪一侧进入？",
    });
    expect(merged.groups).toEqual([
      expect.objectContaining({ id: "scene-prompts", prompt: undefined }),
    ]);
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

describe("deriveDecisionRecapFallback", () => {
  it("normalizes a short current story for legacy prompt rows", () => {
    expect(
      deriveDecisionRecapFallback(
        "纸还在你手里。\n\n被划掉的那半句，你其实认得字。",
      ),
    ).toBe("纸还在你手里。 被划掉的那半句，你其实认得字。");
  });

  it("keeps the latest complete sentences within the decision-panel limit", () => {
    expect(
      deriveDecisionRecapFallback(
        "你走进教室。凛把采访本推到桌边。澪问你放学后是否需要带路。窗外又传来吉他声。",
        28,
      ),
    ).toBe("澪问你放学后是否需要带路。窗外又传来吉他声。");
  });

  it("keeps a closing quote with the sentence it belongs to", () => {
    expect(
      deriveDecisionRecapFallback(
        "凛问：『你会先回应谁？』夏帆没理，只比了个『等你』的口型。纸还在你手里。",
        32,
      ),
    ).toBe("夏帆没理，只比了个『等你』的口型。纸还在你手里。");
  });

  it("returns undefined for an empty story", () => {
    expect(deriveDecisionRecapFallback(" \n ")).toBeUndefined();
  });
});

describe("filterStalePrompts", () => {
  it("keeps prompts stamped with the current turn", () => {
    const ns = { __turnId: "turn-5", prompt1Text: "环顾四周" };
    expect(filterStalePrompts(ns, "turn-5")).toBe(ns);
  });

  it("drops prompts stamped with a past turn", () => {
    const ns = { __turnId: "turn-4", prompt1Text: "环顾四周" };
    expect(filterStalePrompts(ns, "turn-5")).toEqual({});
  });

  it("keeps prompts with no __turnId stamp (back-compat with old data)", () => {
    const ns = { prompt1Text: "环顾四周" };
    expect(filterStalePrompts(ns, "turn-5")).toBe(ns);
  });
});

describe("pluginIdForCapability", () => {
  const carrier = (id: string, isActive: boolean, capabilities: string[]) => ({
    id,
    isActive,
    capabilities,
  });

  it("returns the active plugin that declares the capability", () => {
    const plugins = [
      carrier("scene-stage", true, ["scene-stage"]),
      carrier("other", true, ["something-else"]),
    ];
    expect(pluginIdForCapability(plugins, "scene-stage")).toBe("scene-stage");
  });

  it("skips an inactive provider even when it declares the capability", () => {
    const plugins = [carrier("scene-stage", false, ["scene-stage"])];
    expect(pluginIdForCapability(plugins, "scene-stage")).toBeUndefined();
  });

  it("returns undefined when no active plugin provides the capability", () => {
    const plugins = [carrier("other", true, ["something-else"])];
    // No fall back to the capability name as an id.
    expect(pluginIdForCapability(plugins, "scene-stage")).toBeUndefined();
  });

  it("picks the lexicographically smallest id among active matches", () => {
    // Deterministic regardless of input order.
    const plugins = [
      carrier("zeta-stage", true, ["scene-stage"]),
      carrier("alpha-stage", true, ["scene-stage"]),
    ];
    expect(pluginIdForCapability(plugins, "scene-stage")).toBe("alpha-stage");
    expect(pluginIdForCapability([...plugins].reverse(), "scene-stage")).toBe(
      "alpha-stage",
    );
  });
});
