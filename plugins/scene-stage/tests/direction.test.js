import {
  getToolContent,
  getPendingProposals,
} from "@covel/plugin-handlers-utils";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { validateOutput } from "@covel/tools";
import handler from "../runtimes/direction/handler.js";
import register from "../server/index.js";

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
    world: { characters: CHARACTERS },
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
  it("excludes only the primary seat's current character from events and their previews", async () => {
    const ctx = makeCtx([
      { type: "actor.enter", character: "Viewpoint" },
      { type: "actor.enter", character: "Companion" },
    ]);
    ctx.world = {
      characters: [
        { id: "viewpoint", name: "Viewpoint", type: "npc" },
        { id: "companion", name: "Companion", type: "player" },
      ],
      seats: [
        {
          id: "primary",
          controller: "human",
          role: "player",
          characters: ["companion", "viewpoint"],
          currentCharacterId: "viewpoint",
        },
      ],
    };
    const result = await handler(ctx);
    expect(
      committedDirection(result).actors.map(({ characterId }) => characterId),
    ).toEqual(["companion"]);
    const handlers = new Map();
    register({
      provideExtension: (_point, id, { handler }) => handlers.set(id, handler),
    });
    const preview = await handlers.get("direction")(
      { previous: {}, events: [{ ...ctx.triggerEvent, turnId: ctx.turnId }] },
      ctx,
    );
    expect(preview.actors.map(({ characterId }) => characterId)).toEqual([
      "companion",
    ]);
  });

  it("places the character a cue names by an alias, and no one for an alias two characters share", async () => {
    const ctx = makeCtx([
      { type: "actor.enter", character: "班长", position: "left" },
      { type: "actor.enter", character: "学姐", position: "right" },
    ]);
    ctx.world = {
      characters: [
        { ...CHARACTERS[2], aliases: ["澪", "班长"] },
        { ...CHARACTERS[0], aliases: ["学姐"] },
        { ...CHARACTERS[1], aliases: ["学姐"] },
      ],
    };
    const result = await handler(ctx);
    expect(committedDirection(result).actors).toMatchObject([
      { characterId: "sess-npc-kamishiro-mio", displayName: "神代澪" },
    ]);
    expect(getToolContent(result).value.diagnostics).toEqual([
      "unresolved character: 学姐",
    ]);
  });

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
    expect(getToolContent(result).value).toMatchObject({
      skipped: true,
      diagnostics: ["unresolved character: 不存在的人"],
    });
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("updates the cast from cues alone and writes no dialogue attribution", async () => {
    const ctx = makeCtx([
      { type: "actor.enter", character: "神代澪", focus: true },
    ]);
    const result = await handler(ctx);
    const proposals = getPendingProposals(result);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toMatchObject({
      namespace: "direction",
      key: "current",
      value: {
        actors: [
          expect.objectContaining({
            characterId: "sess-npc-kamishiro-mio",
            active: true,
          }),
        ],
      },
    });
    expect(getToolContent(result).value).not.toHaveProperty("dialogue");
  });

  it("skips an event without cues", async () => {
    const result = await handler(makeCtx([]));
    expect(getToolContent(result).value).toMatchObject({ skipped: true });
    expect(getPendingProposals(result)).toHaveLength(0);
  });
});

describe("stage.direction event schema", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../schemas/stage-direction.event.json", import.meta.url),
      "utf8",
    ),
  );

  it("accepts actor cues and rejects empty events and dialogue maps", () => {
    expect(
      validateOutput({ cues: [{ type: "stage.clear" }] }, schema).valid,
    ).toBe(true);
    expect(validateOutput({ cues: [] }, schema).valid).toBe(false);
    expect(
      validateOutput(
        {
          cues: [{ type: "stage.clear" }],
          dialogue: { speakers: ["npc-1", null] },
        },
        schema,
      ).valid,
    ).toBe(false);
  });
});
