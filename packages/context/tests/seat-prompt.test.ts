// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { CharacterRecord, SessionRecord } from "@covel/store";
import { buildSessionContextSnapshot } from "@covel/context";
import { buildContext } from "../src/context-builder.js";

const TS = "2026-01-01T00:00:00.000Z";

const TEMPLATE = [
  "You narrate.",
  "<player-character>",
  "{{ player.character }}",
  "</player-character>",
  "<character-profiles>",
  "{{ characters.npcs }}",
  "</character-profiles>",
].join("\n");

function session(seats: SessionRecord["seats"]): SessionRecord {
  return {
    id: "sess-1",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 2,
    setupRuntimes: {},
    seats,
    locale: "en-US",
    activePlugins: [],
    createdAt: TS,
    updatedAt: TS,
  };
}

function character(
  overrides: Partial<CharacterRecord> & { id: string; name: string },
): CharacterRecord {
  return {
    sessionId: "sess-1",
    type: "npc",
    version: 1,
    createdAt: TS,
    updatedAt: TS,
    ...overrides,
  };
}

async function renderPrompt(
  seats: SessionRecord["seats"],
  characters: readonly CharacterRecord[],
): Promise<string> {
  const store = createMemoryStore();
  await store.createSession(session(seats));
  for (const record of characters) await store.upsertCharacter(record);
  const sessionContext = await buildSessionContextSnapshot(store, "sess-1", {
    locale: "en-US",
    turnNumber: 3,
  });
  const context = await buildContext({
    promptTemplate: TEMPLATE,
    manifest: {
      name: "story",
      pluginId: "story",
      description: "story",
      stage: "narrative",
    },
    turnInput: {
      sessionId: "sess-1",
      turnId: "turn-3",
      playerMessage: "I open the gate.",
      origin: "player",
      locale: "en-US",
    },
    completedResults: new Map(),
    sessionContext,
  });
  return context.systemPrompt;
}

const DEFAULT_SEATS: SessionRecord["seats"] = [
  { id: "main", controller: "human", role: "player", characters: "auto" },
];

/**
 * The system prompt this fixture rendered before seats existed, when the
 * player character was the first `type: player` character. Captured from that
 * code; a single-player session must keep rendering it byte for byte.
 */
const SINGLE_PLAYER_GOLDEN = [
  "[RUNTIME] You are executing an in-game runtime for an interactive narrative engine.",
  "[RUNTIME] Follow the runtime instructions and world data below as the complete task context.",
  "[RUNTIME] Produce only in-world narrative, structured runtime output, and required tool calls.",
  "[LANGUAGE] You MUST write all natural-language content in English: narrative, descriptions, summaries, and any free-text tool argument.",
  "[LANGUAGE] Do NOT translate machine values. Enum members, ids, keys, event topics, schema field names, and tool names must be copied EXACTLY as the schema spells them, in their original language.",
  "[COMPLETION] When you have finished all tool work for this runtime, call the `runtime-done` tool IMMEDIATELY. Do not emit terminator text — calling `runtime-done` is the end signal.",
  "[COMPLETION] If no tool call is needed this turn, just call `runtime-done` to finish (preferred), or return an empty string. Do not repeatedly call the same business tool.COVEL_CACHE_BREAK",
  "",
  "You narrate.",
  "<player-character>",
  '{"id":"char-hero","name":"Hero","type":"player","description":"A wandering knight.","fields":{"hp":9,"oath":"silence"}}',
  "</player-character>",
  "<character-profiles>",
  '- Guide (aka Old Sel) [npc] | Knows the pass. | {"trust":2}',
  "- Rival [companion]",
  "</character-profiles>COVEL_CACHE_BREAK",
].join("\n");

const hero = character({
  id: "char-hero",
  name: "Hero",
  type: "player",
  description: "A wandering knight.",
  fields: { hp: 9, oath: "silence" },
});
const guide = character({
  id: "npc-guide",
  name: "Guide",
  aliases: ["Old Sel"],
  description: "Knows the pass.",
  fields: { trust: 2 },
});
const rival = character({ id: "npc-rival", name: "Rival", type: "companion" });

describe("the prompt follows the primary seat's current character", () => {
  it("renders a single-player prompt exactly as before seats", async () => {
    expect(await renderPrompt(DEFAULT_SEATS, [hero, guide, rival])).toBe(
      SINGLE_PLAYER_GOLDEN,
    );
  });

  it("shows the second player character when it is current and lists the first with its tag", async () => {
    const scout = character({
      id: "char-scout",
      name: "Scout",
      type: "player",
      description: "Quick and quiet.",
    });
    const prompt = await renderPrompt(
      [{ ...DEFAULT_SEATS[0]!, currentCharacterId: "char-scout" }],
      [hero, scout, guide],
    );
    const sheet = prompt.slice(
      prompt.indexOf("<player-character>"),
      prompt.indexOf("</player-character>"),
    );
    expect(sheet).toContain('"name":"Scout"');
    expect(sheet).not.toContain("Hero");
    expect(prompt).toContain(
      '- Hero [player] | A wandering knight. | {"hp":9,"oath":"silence"}',
    );
    expect(prompt).not.toContain("- Scout [player]");
  });

  it("shows no player sheet when no seat binds a character", async () => {
    const prompt = await renderPrompt(
      [{ id: "host", controller: "human", role: "host", characters: [] }],
      [hero, guide],
    );
    expect(prompt).toContain("<player-character>\n\n</player-character>");
    expect(prompt).toContain("- Hero [player]");
  });
});
