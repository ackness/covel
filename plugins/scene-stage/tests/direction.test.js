import { describe, expect, it, vi } from "vitest";
import { getPendingProposals } from "@covel/tools";
import handler from "../runtimes/direction/handler.js";

const CHARACTERS = [
  { id: "sess-npc-asakura-rin", name: "朝仓凛", type: "npc" },
  { id: "sess-npc-shiina-kaho", name: "椎名夏帆", type: "npc" },
  { id: "sess-npc-kamishiro-mio", name: "神代澪", type: "npc" },
];

function makeCtx(cues, previous = null) {
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/direction",
    sessionId: "sess",
    turnId: "turn-1",
    triggerEvent: { topic: "stage.direction", data: { cues } },
    store: { listCharacters: vi.fn(async () => CHARACTERS) },
    pluginData: {
      get: vi.fn(async () => previous),
      set: vi.fn(),
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
  };
}

function committedDirection(result) {
  return getPendingProposals(result)[0]?.payload?.value;
}

describe("scene-stage direction handler", () => {
  it("enters actors, resolves a unique short name, and applies focus", async () => {
    const result = await handler(
      makeCtx([
        {
          type: "actor.enter",
          character: "凛",
          position: "left",
          outfit: "uniform",
          expression: "smile",
          focus: true,
          transition: "fade",
        },
        {
          type: "actor.enter",
          character: "椎名夏帆",
          position: "right",
          expression: "neutral",
        },
      ]),
    );

    expect(committedDirection(result)).toMatchObject({
      schemaVersion: 1,
      actors: [
        {
          characterId: "sess-npc-asakura-rin",
          displayName: "朝仓凛",
          active: true,
          position: "left",
          visual: { outfit: "uniform", expression: "smile" },
          transition: "fade",
        },
        {
          characterId: "sess-npc-shiina-kaho",
          displayName: "椎名夏帆",
          active: false,
          position: "right",
          visual: { expression: "neutral" },
        },
      ],
      turnId: "turn-1",
    });
  });

  it("updates visual state, moves focus, and removes actors", async () => {
    const previous = {
      actors: [
        {
          characterId: "sess-npc-asakura-rin",
          displayName: "朝仓凛",
          active: true,
          position: "left",
          visual: {
            variantId: "uniform-neutral",
            outfit: "uniform",
            expression: "neutral",
          },
        },
        {
          characterId: "sess-npc-shiina-kaho",
          displayName: "椎名夏帆",
          active: false,
          position: "right",
        },
      ],
    };
    const result = await handler(
      makeCtx(
        [
          {
            type: "actor.update",
            character: "朝仓凛",
            expression: "surprised",
          },
          { type: "actor.focus", character: "椎名夏帆" },
          { type: "actor.leave", character: "朝仓凛" },
        ],
        previous,
      ),
    );

    expect(committedDirection(result).actors).toEqual([
      {
        characterId: "sess-npc-shiina-kaho",
        displayName: "椎名夏帆",
        active: true,
        position: "right",
      },
    ]);
  });

  it("clears the complete stage", async () => {
    const result = await handler(
      makeCtx([{ type: "stage.clear" }], {
        actors: [
          {
            characterId: "sess-npc-asakura-rin",
            displayName: "朝仓凛",
            active: true,
          },
        ],
      }),
    );
    expect(committedDirection(result).actors).toEqual([]);
  });

  it("persists an opening stage.clear as authoritative empty state", async () => {
    const result = await handler(makeCtx([{ type: "stage.clear" }]));
    expect(committedDirection(result).actors).toEqual([]);
  });

  it("does not write state for unresolved cues", async () => {
    const result = await handler(
      makeCtx([{ type: "actor.enter", character: "不存在的人" }]),
    );
    expect(result.value).toMatchObject({
      skipped: true,
      diagnostics: ["unresolved character: 不存在的人"],
    });
    expect(getPendingProposals(result)).toHaveLength(0);
  });
});
