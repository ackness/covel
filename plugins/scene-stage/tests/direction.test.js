import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { getPendingProposals, validateOutput } from "@covel/tools";
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

  it("persists paragraph speakers and narration independently of actor focus", async () => {
    const ctx = makeCtx([
      { type: "actor.enter", character: "神代澪", focus: true },
    ]);
    ctx.triggerEvent.data.dialogue = {
      paragraphSpeakers: [
        "sess-npc-kamishiro-mio",
        "sess-npc-asakura-rin",
        null,
      ],
    };
    const result = await handler(ctx);
    const dialogue = getPendingProposals(result).find(
      (proposal) => proposal.payload.namespace === "dialogue",
    );
    expect(dialogue.payload).toEqual({
      namespace: "dialogue",
      key: "turn-1",
      value: {
        schemaVersion: 1,
        turnId: "turn-1",
        paragraphSpeakers: [
          { characterId: "sess-npc-kamishiro-mio", displayName: "神代澪" },
          { characterId: "sess-npc-asakura-rin", displayName: "朝仓凛" },
          null,
        ],
      },
    });
  });

  it("accepts dialogue-only events without clearing the stage or guessing names", async () => {
    const ctx = makeCtx([]);
    ctx.triggerEvent.data.dialogue = {
      paragraphSpeakers: ["凛", "missing", null],
    };
    const result = await handler(ctx);
    expect(getPendingProposals(result)).toHaveLength(1);
    expect(getPendingProposals(result)[0].payload).toMatchObject({
      namespace: "dialogue",
      value: { paragraphSpeakers: [null, null, null] },
    });
    expect(result.value.diagnostics).toHaveLength(2);
  });

  it("keeps attribution keyed by turn and supports the player as a speaker", async () => {
    const ctx = makeCtx([]);
    ctx.turnId = "turn-2";
    ctx.store.listCharacters = vi.fn(async () => [
      ...CHARACTERS,
      { id: "player-1", name: "Alex", type: "player" },
    ]);
    ctx.triggerEvent.data.dialogue = { paragraphSpeakers: ["player-1"] };
    const result = await handler(ctx);
    expect(getPendingProposals(result)[0].payload).toMatchObject({
      key: "turn-2",
      value: {
        turnId: "turn-2",
        paragraphSpeakers: [{ characterId: "player-1", displayName: "Alex" }],
      },
    });
  });
});

describe("stage.direction event schema", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../schemas/stage-direction.event.json", import.meta.url),
      "utf8",
    ),
  );

  it("allows legacy actor events and dialogue-only events but rejects empty events", () => {
    expect(
      validateOutput({ cues: [{ type: "stage.clear" }] }, schema).valid,
    ).toBe(true);
    expect(
      validateOutput(
        { cues: [], dialogue: { paragraphSpeakers: ["npc-1", null] } },
        schema,
      ).valid,
    ).toBe(true);
    expect(validateOutput({ cues: [] }, schema).valid).toBe(false);
    expect(
      validateOutput({ cues: [], dialogue: { paragraphSpeakers: [] } }, schema)
        .valid,
    ).toBe(false);
    expect(
      validateOutput(
        { cues: [], dialogue: { paragraphSpeakers: [123] } },
        schema,
      ).valid,
    ).toBe(false);
  });
});
