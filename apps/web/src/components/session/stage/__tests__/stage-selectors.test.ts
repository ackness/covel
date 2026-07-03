import { describe, expect, it } from "vitest";
import type { StreamMessage } from "@/stores/session-store.js";
import type { WorldVisual } from "@/lib/world-visuals.js";
import {
  computeSpriteSlots,
  extractInteractionChoices,
  extractPendingFormMessages,
  filterStalePrompts,
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

  it("3-4 speakers distribute evenly", () => {
    const presence = {
      lin: { characterId: "lin", sprite: ref("lin-sprite") },
      archivist: { characterId: "archivist", sprite: ref("archivist-sprite") },
      ghost: { characterId: "ghost", sprite: ref("ghost-sprite") },
    };
    const slots = computeSpriteSlots(speakers, presence);
    expect(slots.map((s) => s.pos)).toEqual(["left", "center", "right"]);
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
    // stations still count the fallback slot: 3 speakers → left/center/right
    expect(slots.map((s) => s.pos)).toEqual(["left", "center", "right"]);
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
