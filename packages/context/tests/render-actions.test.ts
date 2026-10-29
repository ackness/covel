// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { CharacterRecord, SessionRecord } from "@covel/store";
import type { Seat, TurnAction } from "@covel/shared";
import {
  actionsContent,
  buildSessionContextSnapshot,
  createPromptLoader,
  renderActions,
} from "@covel/context";
import { buildContext } from "../src/context-builder.js";

const loadPrompt = createPromptLoader(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../prompts",
  ),
);
const TS = "2026-01-01T00:00:00.000Z";

const hero = { id: "char-hero", name: "Hero", type: "player" };
const scout = { id: "char-scout", name: "Scout", type: "player" };
const guide = { id: "npc-guide", name: "Guide", type: "npc" };

const MAIN: Seat = {
  id: "main",
  controller: "human",
  role: "player",
  characters: "auto",
};
const HOST: Seat = {
  id: "host",
  controller: "human",
  role: "host",
  characters: [],
};

const say = (text: string, actorId?: string): TurnAction => ({
  seatId: "main",
  kind: "say",
  ...(actorId ? { actorId } : {}),
  text,
  source: "player",
});

function render(
  actions: readonly TurnAction[],
  options: {
    seats?: readonly Seat[];
    characters?: readonly { id: string; name: string; type: string }[];
    locale?: string;
    kindLabels?: ReadonlyMap<string, string | Record<string, string>>;
  } = {},
) {
  return renderActions(actions, {
    seats: options.seats ?? [MAIN],
    characters: options.characters ?? [hero, guide],
    locale: options.locale ?? "en-US",
    ...(options.kindLabels ? { kindLabels: options.kindLabels } : {}),
    loadPrompt,
  });
}

describe("renderActions", () => {
  it("keeps a single player's say as its text, byte for byte", async () => {
    expect(await render([say("I open the gate.", "char-hero")])).toBe(
      "I open the gate.",
    );
    expect(
      await render([say("First.", "char-hero"), say("Second.", "char-hero")]),
    ).toBe("First.\nSecond.");
    // Before any character exists (setup), the text is unchanged too.
    expect(await render([say("Hello")], { characters: [] })).toBe("Hello");
  });

  it("keeps commands and interaction answers as their text in single-player play", async () => {
    const command: TurnAction = {
      seatId: "main",
      kind: "command",
      text: "/roll 1d6",
      source: "player",
    };
    const answer: TurnAction = {
      seatId: "main",
      kind: "act",
      actorId: "char-hero",
      text: "[Player input] name: Aya",
      fields: { name: "Aya" },
      interaction: { turnId: "t1", interactionId: "f1", type: "form" },
      source: "player",
    };
    const quiet: TurnAction = {
      ...answer,
      text: "",
      interaction: { turnId: "t1", interactionId: "f2", type: "form" },
    };
    expect(await render([command])).toBe("/roll 1d6");
    expect(await render([answer, quiet])).toBe("[Player input] name: Aya");
    expect(await render([quiet])).toBe("");
  });

  it("names the second bound character and the kind", async () => {
    const actions = [say("Wait for me.", "char-scout")];
    const characters = [hero, scout, guide];
    expect(await render(actions, { characters })).toBe(
      "[Scout · says] Wait for me.",
    );
    expect(await render(actions, { characters, locale: "zh-CN" })).toBe(
      "【Scout·说】Wait for me.",
    );
  });

  it("labels a host's narration without an actor", async () => {
    const narrate: TurnAction = {
      seatId: "host",
      kind: "narrate",
      text: "Rain falls.",
      source: "player",
    };
    expect(await render([narrate], { seats: [MAIN, HOST] })).toBe(
      "[narration] Rain falls.",
    );
    expect(
      await render([narrate], { seats: [MAIN, HOST], locale: "zh-CN" }),
    ).toBe("【旁白】Rain falls.");
  });

  it("labels a plugin kind with its display label in the content locale", async () => {
    const whisper: TurnAction = {
      seatId: "main",
      kind: "whisper-pack/whisper",
      actorId: "char-hero",
      text: "Over here.",
      fields: { target: "Guide" },
      source: "player",
    };
    const kindLabels = new Map([
      ["whisper-pack/whisper", { en: "whispers", zh: "耳语" }],
    ]);
    expect(await render([whisper], { kindLabels })).toBe(
      '[Hero · whispers] Over here. {"target":"Guide"}',
    );
    expect(await render([whisper], { kindLabels, locale: "zh-CN" })).toBe(
      '【Hero·耳语】Over here. {"target":"Guide"}',
    );
  });

  it("labels a single player's answer declared as a plugin kind", async () => {
    const kindLabels = new Map([
      ["whisper-pack/whisper", { en: "whispers", zh: "耳语" }],
    ]);
    const answer: TurnAction = {
      seatId: "main",
      kind: "whisper-pack/whisper",
      actorId: "char-hero",
      text: "hello",
      fields: { target: "Guide" },
      interaction: { turnId: "t1", interactionId: "w1", type: "form" },
      source: "player",
    };
    // An answer renders its filled narrative, not its fields.
    expect(await render([answer], { kindLabels })).toBe(
      "[Hero · whispers] hello",
    );
    expect(await render([answer], { kindLabels, locale: "zh-CN" })).toBe(
      "【Hero·耳语】hello",
    );
    // One labelled action labels the whole submission.
    expect(
      await render([say("Psst.", "char-hero"), answer], { kindLabels }),
    ).toBe("[Hero · says] Psst.\n[Hero · whispers] hello");
  });

  it("renders a plugin kind without text by its label and fields", async () => {
    const kindLabels = new Map([
      ["turn-pack/pass", { en: "passes", zh: "让过" }],
      ["turn-pack/cast", { en: "casts", zh: "施法" }],
    ]);
    const pass: TurnAction = {
      seatId: "main",
      kind: "turn-pack/pass",
      actorId: "char-hero",
      source: "player",
    };
    const cast: TurnAction = {
      seatId: "main",
      kind: "turn-pack/cast",
      actorId: "char-hero",
      fields: { spell: "light" },
      source: "player",
    };
    expect(await render([pass], { kindLabels })).toBe("[Hero · passes]");
    expect(await render([pass], { kindLabels, locale: "zh-CN" })).toBe(
      "【Hero·让过】",
    );
    expect(await render([cast], { kindLabels })).toBe(
      '[Hero · casts] {"spell":"light"}',
    );
    // The chat row has no raw text for them.
    expect(actionsContent([pass, cast])).toBe("");
  });

  it("renders an advance as nothing", async () => {
    const advance: TurnAction = {
      seatId: "host",
      kind: "advance",
      source: "player",
    };
    expect(await render([advance], { seats: [MAIN, HOST] })).toBe("");
    expect(actionsContent([advance])).toBe("");
  });

  it("never writes a character ID", async () => {
    const text = await render([say("Hi.", "char-scout")], {
      characters: [hero, scout],
    });
    expect(text).not.toContain("char-scout");
  });
});

describe("the single-player prompt with rendered actions", () => {
  function sessionRecord(): SessionRecord {
    return {
      id: "sess-1",
      status: "active",
      phase: "playing",
      completedPlayerTurns: 2,
      setupRuntimes: {},
      seats: [MAIN],
      locale: "en-US",
      activePlugins: [],
      createdAt: TS,
      updatedAt: TS,
    };
  }
  const record = (
    fields: Partial<CharacterRecord> & { id: string; name: string },
  ): CharacterRecord => ({
    sessionId: "sess-1",
    type: "npc",
    version: 1,
    createdAt: TS,
    updatedAt: TS,
    ...fields,
  });

  async function context(playerMessage: string) {
    const store = createMemoryStore();
    await store.createSession(sessionRecord());
    await store.upsertCharacter(
      record({ id: "char-hero", name: "Hero", type: "player" }),
    );
    await store.upsertCharacter(record({ id: "npc-guide", name: "Guide" }));
    const sessionContext = await buildSessionContextSnapshot(store, "sess-1", {
      locale: "en-US",
      turnNumber: 3,
    });
    return buildContext({
      promptTemplate: "You narrate.\n{{ player.character }}",
      manifest: {
        name: "story",
        pluginId: "story",
        description: "story",
        stage: "narrative",
      },
      turnInput: {
        sessionId: "sess-1",
        turnId: "turn-3",
        playerMessage,
        origin: "player",
        locale: "en-US",
      },
      completedResults: new Map(),
      sessionContext,
    });
  }

  it("is identical to the prompt built from the raw message", async () => {
    const rendered = await render([say("I open the gate.", "char-hero")]);
    expect(await context(rendered)).toEqual(await context("I open the gate."));
  });
});
