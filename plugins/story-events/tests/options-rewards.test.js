import { describe, expect, it, vi } from "vitest";
import {
  findExactSelectedOption,
  mergeStageChoices,
  publicOptionView,
} from "../lib/options.js";
import { grantRewards, itemAlreadyAddedThisTurn } from "../lib/rewards.js";

describe("hidden options projection and matching", () => {
  const event = { id: "backroom", priority: 10, exclusive: true };
  const option = {
    id: "show-note",
    label: { "en-US": "Hidden Action", "zh-CN": "隐藏行动" },
    text: {
      "en-US": "Show Qi's note to Su Yao.",
      "zh-CN": "向苏窈展示齐老的便笺。",
    },
    hint: { "en-US": "She hesitated.", "zh-CN": "她刚才迟疑了。" },
    when: { item: "Qi's Note", exists: true },
    payload: "SECRET-OPTION-PAYLOAD",
    rewards: [{ id: "r1", kind: "item", item: "SECRET-ITEM" }],
    expiresAfterTurns: 3,
  };

  it("projects only public display fields and strips payload, rewards, and when", () => {
    const view = publicOptionView(
      option,
      event,
      { locale: "en-US" },
      { turn: 4, turnId: "t-4" },
    );
    expect(view).toEqual({
      id: "show-note",
      eventId: "backroom",
      text: "Show Qi's note to Su Yao.",
      label: "Hidden Action",
      hint: "She hesitated.",
      priority: 10,
      unlockedTurn: 4,
      unlockedTurnId: "t-4",
      expiresAtTurn: 7,
      persist: false,
      once: true,
      exclusive: true,
    });
    expect(JSON.stringify(view)).not.toContain("SECRET");
  });

  it("matches exact player input after normalizing quotes, spaces, and punctuation", () => {
    const active = {
      "show-note": {
        id: "show-note",
        eventId: "backroom",
        text: "Show Qi's note to Su Yao.",
      },
    };
    expect(
      findExactSelectedOption(active, "  “Show   Qi's note to Su Yao!” ")?.id,
    ).toBe("show-note");
    expect(findExactSelectedOption(active, "Walk away")).toBeNull();
  });

  it("merges unlocked options ahead of guide choices in stage.choices@1", () => {
    const previous = {
      turnId: "t-5",
      scene: "Appraisal Room",
      decision: "What do you do?",
      choices: [{ id: "prompt:1", text: "Leave quietly", label: "Act" }],
    };
    const rows = [
      {
        key: "show-note",
        value: {
          id: "show-note",
          eventId: "backroom",
          text: "Show Qi's note to Su Yao.",
          label: "Hidden Action",
          priority: 10,
        },
      },
    ];
    expect(mergeStageChoices(previous, rows, {})).toEqual({
      turnId: "t-5",
      scene: "Appraisal Room",
      decision: "What do you do?",
      choices: [
        {
          id: "hidden:show-note",
          text: "Show Qi's note to Su Yao.",
          label: "Hidden Action",
        },
        { id: "prompt:1", text: "Leave quietly", label: "Act" },
      ],
    });
    // Without active hidden options, previous passes through unchanged.
    expect(mergeStageChoices(previous, [], {})).toBe(previous);
    // Works standalone when guide is not enabled.
    expect(mergeStageChoices(null, rows, {})).toEqual({
      choices: [
        {
          id: "hidden:show-note",
          text: "Show Qi's note to Su Yao.",
          label: "Hidden Action",
        },
      ],
    });
  });
});

describe("hidden reward settlement", () => {
  function baseCtx(services = undefined) {
    return {
      sessionId: "s-1",
      turnId: "t-5",
      pluginId: "story-events",
      runtimeId: "story-events/assess",
      locale: "en-US",
      ...(services ? { services } : {}),
    };
  }

  it("grants item via inventory.change@1, lorebook via proposal, and narrative notes", async () => {
    const call = vi.fn().mockResolvedValue({ results: [] });
    const services = {
      discover: vi
        .fn()
        .mockResolvedValue([{ pluginId: "inventory", name: "change" }]),
      call,
    };
    const settled = await grantRewards(baseCtx(services), {
      grants: [
        {
          eventId: "ev1",
          optionId: "opt1",
          reward: {
            id: "r-item",
            kind: "item",
            item: "Brass Key",
            quantity: 1,
            description: "Opens the locker",
            tags: ["clue"],
          },
        },
        {
          eventId: "ev1",
          optionId: "opt1",
          reward: {
            id: "r-lore",
            kind: "lorebook",
            title: "Secret Date Gap",
            entryId: "secret-date-gap",
            strategy: "selective",
            keys: ["archive"],
            content: "Three days before sealing.",
          },
        },
        {
          eventId: "ev1",
          optionId: "opt1",
          reward: {
            id: "r-note",
            kind: "narrative",
            title: "Quiet Favor",
            text: "Su Yao leaves an unlogged lantern.",
            announce: false,
          },
        },
      ],
      claimedRewards: {},
      operations: [],
      worldIR: null,
      turn: 5,
      turnId: "t-5",
      sourceTurnId: "t-5",
    });

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          changes: [
            {
              op: "add",
              item: "Brass Key",
              quantity: 1,
              description: "Opens the locker",
              tags: ["clue"],
            },
          ],
        },
      }),
      expect.anything(),
    );
    expect(settled.proposals).toHaveLength(1);
    expect(settled.proposals[0].type).toBe("lorebook.upsert");
    expect(settled.proposals[0].payload.entries[0].id).toBe("secret-date-gap");
    expect(settled.narrativeNotes).toEqual([
      "Su Yao leaves an unlogged lantern.",
    ]);
    // announce: false hides r-note from UI announcements while still claiming it.
    expect(settled.announcements.map((a) => a.id)).toEqual([
      "ev1:opt1:r-item",
      "ev1:opt1:r-lore",
    ]);
    expect(settled.claimedWrites).toHaveLength(3);
  });

  it("deduplicates items already added this turn and degrades gracefully without inventory", async () => {
    expect(
      itemAlreadyAddedThisTurn(
        "Brass Key",
        [
          {
            contract: "inventory.change@1",
            request: { changes: [{ op: "add", item: "brass key" }] },
          },
        ],
        null,
      ),
    ).toBe(true);

    // No inventory service: degrades to a narrative note instead of failing.
    const settled = await grantRewards(baseCtx(), {
      grants: [
        {
          eventId: "ev1",
          reward: {
            id: "r-item",
            kind: "item",
            item: "Brass Key",
            quantity: 1,
          },
        },
      ],
      claimedRewards: {},
      operations: [],
      worldIR: null,
      turn: 5,
      turnId: "t-5",
      sourceTurnId: "t-5",
    });
    expect(settled.narrativeNotes[0]).toContain("Brass Key");
    expect(settled.claimedWrites[0].value.degraded).toBe(true);

    // Already claimed reward is skipped on retry.
    const retry = await grantRewards(baseCtx(), {
      grants: [
        {
          eventId: "ev1",
          reward: {
            id: "r-item",
            kind: "item",
            item: "Brass Key",
            quantity: 1,
          },
        },
      ],
      claimedRewards: { "ev1::r-item": { rewardKey: "ev1::r-item" } },
      operations: [],
      worldIR: null,
      turn: 5,
      turnId: "t-5b",
      sourceTurnId: "t-5",
    });
    expect(retry.claimedWrites).toEqual([]);
  });
});
