/**
 * V1/V2 prompt-assembler parity test for `char-creator` (S3-T5a).
 *
 * char-creator is a multi-runtime plugin with two PLUGIN.md files:
 *   1. `runtimes/player-init/PLUGIN.md` — character creation agent
 *   2. `runtimes/character-tracker/PLUGIN.md` — NPC + state tracking agent
 *
 * Each runtime opts into `promptVersion: 2` independently. This suite runs
 * the V1/V2 parity assertions against BOTH runtimes to verify the migration
 * is complete and self-consistent.
 *
 * Semantic equivalence is asserted after normalizing the [LANGUAGE]
 * constraint position (V1 tail vs V2 head) and collapsing whitespace.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildContext, type ContextBuildParams } from "@covel/context";
import { parsePluginMd } from "@covel/plugin-loader";
import type { RuntimeResult, TurnInput } from "@covel/shared";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const PLAYER_INIT_PATH = resolve(
  __dirname,
  "..",
  "runtimes",
  "player-init",
  "PLUGIN.md",
);
const CHARACTER_TRACKER_PATH = resolve(
  __dirname,
  "..",
  "runtimes",
  "character-tracker",
  "PLUGIN.md",
);

// ── Fixture loading ──────────────────────────────────────────────

function loadPlayerInit() {
  const content = readFileSync(PLAYER_INIT_PATH, "utf-8");
  return parsePluginMd(content, PLAYER_INIT_PATH);
}

function loadCharacterTracker() {
  const content = readFileSync(CHARACTER_TRACKER_PATH, "utf-8");
  return parsePluginMd(content, CHARACTER_TRACKER_PATH);
}

// ── Fixture builders ─────────────────────────────────────────────

const NARRATOR_OUTPUT_TEXT =
  "You awaken on a wind-worn bluff above the Cloudmere archipelago. A bronze bell tolls once in the valley below. From behind a stone cairn, a hooded traveler — Elina — steps into view and offers a hand.";

// Post 2026-04: player-init (Pre-Game band, priority 50) no longer injects
// narrator (main-loop band, priority 500) because the narrator is not
// scheduled in turn 0. It injects pregame.narrativeOutput instead.
const PREGAME_OUTPUT_TEXT =
  "【Cloudmere】A high-altitude archipelago of sky-islands held aloft by ancient crystals. A bronze bell tolls once in the valley below.";

function makeNarratorResult(turnId: string): RuntimeResult {
  return {
    pluginId: "narrator",
    runtimeId: "narrator",
    runId: "run-1",
    turnId,
    status: "success",
    output: {
      narrativeOutput: NARRATOR_OUTPUT_TEXT,
    },
    toolCalls: [],
    durationMs: 100,
    timestamp: "2026-04-13T00:00:00.000Z",
  };
}

function makePregameResult(turnId: string): RuntimeResult {
  return {
    pluginId: "pregame",
    runtimeId: "pregame",
    runId: "run-0",
    turnId,
    status: "success",
    output: {
      narrativeOutput: PREGAME_OUTPUT_TEXT,
      preGameDone: true,
    },
    toolCalls: [],
    durationMs: 2,
    timestamp: "2026-04-13T00:00:00.000Z",
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-char-parity",
    turnId: "turn-1",
    playerMessage: "I take the offered hand.",
    locale: "zh-CN",
    ...overrides,
  };
}

/** Params for `player-init` — needs world.lore, config.worldSchema, optional player submission. */
function makePlayerInitParams(
  promptTemplate: string,
  manifest: ContextBuildParams["manifest"],
): ContextBuildParams {
  return {
    promptTemplate,
    manifest,
    turnInput: makeTurnInput(),
    completedResults: new Map([["pregame", makePregameResult("turn-0")]]),
    config: {
      worldLore:
        "Cloudmere is a high-altitude archipelago of sky-islands held aloft by ancient crystals.",
      worldSchema: {
        "character-attributes": {
          version: 1,
          attributes: [
            {
              id: "hp",
              name: "生命值",
              type: "number",
              min: 0,
              max: 100,
              defaultValue: 100,
              category: "stats",
            },
            {
              id: "background",
              name: "出身",
              type: "enum",
              options: ["学者", "流浪者", "贵族"],
              category: "bio",
            },
          ],
        },
      },
    },
    messageHistory: [],
    sessionMeta: {
      turnNumber: 1,
      characters: [],
      lastFormValues: undefined,
    },
  };
}

/** Params for `character-tracker` — needs narrator inject + world schema. */
function makeCharacterTrackerParams(
  promptTemplate: string,
  manifest: ContextBuildParams["manifest"],
): ContextBuildParams {
  return {
    promptTemplate,
    manifest,
    turnInput: makeTurnInput({
      turnId: "turn-3",
      playerMessage: "I greet Elina.",
    }),
    completedResults: new Map([["narrator", makeNarratorResult("turn-3")]]),
    config: {
      worldSchema: {
        "character-attributes": {
          version: 1,
          attributes: [
            {
              id: "hp",
              name: "生命值",
              type: "number",
              defaultValue: 100,
              category: "stats",
            },
          ],
        },
      },
    },
    messageHistory: [
      { role: "user", content: "I take the offered hand." },
      { role: "assistant", content: NARRATOR_OUTPUT_TEXT },
    ],
    sessionMeta: {
      turnNumber: 3,
      characters: [
        { name: "柳无痕", type: "player", description: "青萍宗外门弟子" },
      ],
    },
  };
}

// ── Normalize helper ─────────────────────────────────────────────

function normalizeSystemPrompt(prompt: string): string {
  return (
    prompt
      .replace(/\[RUNTIME\][^\n]*\n?/g, "")
      .replace(/\[LANGUAGE\][^\n]*\.?/g, "")
      // Strip the [COMPLETION] runtime-done contract (V2-only, not in V1).
      .replace(/\[COMPLETION\][^\n]*\n?/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
  );
}

// ── Tests ────────────────────────────────────────────────────────

afterEach(() => {
  delete process.env.COVEL_PROMPT_V2;
});

describe("char-creator/player-init V1/V2 prompt parity", () => {
  it("manifest declares promptVersion: 2", () => {
    const parsed = loadPlayerInit();
    expect(parsed.manifest.promptVersion).toBe(2);
  });

  it("V2 path routes through three-tier assembler when env flag is set", () => {
    const parsed = loadPlayerInit();
    const params = makePlayerInitParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    expect(v1.systemPrompt).toMatch(/in 中文\.\s*$/);

    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);
    expect(v2.systemPrompt.startsWith("[RUNTIME]")).toBe(true);
    expect(v2.systemPrompt).toContain("[LANGUAGE]");
  });

  it("V1 and V2 produce semantically equivalent system prompts", () => {
    const parsed = loadPlayerInit();
    const params = makePlayerInitParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    const v1Norm = normalizeSystemPrompt(v1.systemPrompt);
    const v2Norm = normalizeSystemPrompt(v2.systemPrompt);

    expect(v2Norm).toBe(v1Norm);
  });

  it("both paths surface world lore, world schema, and the narrator inject", () => {
    const parsed = loadPlayerInit();
    const params = makePlayerInitParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    // Pregame inject block — Pre-Game band doesn't see the (unscheduled)
    // narrator, so the opening text comes from pregame.narrativeOutput
    // under the <pregame-opening> tag.
    expect(v1.systemPrompt).toContain(PREGAME_OUTPUT_TEXT);
    expect(v2.systemPrompt).toContain(PREGAME_OUTPUT_TEXT);
    expect(v1.systemPrompt).toContain("<pregame-opening>");
    expect(v2.systemPrompt).toContain("<pregame-opening>");

    // World lore interpolation.
    expect(v1.systemPrompt).toContain("Cloudmere is a high-altitude");
    expect(v2.systemPrompt).toContain("Cloudmere is a high-altitude");

    // World schema interpolation.
    expect(v1.systemPrompt).toContain("character-attributes");
    expect(v2.systemPrompt).toContain("character-attributes");

    // The runtime is now single-purpose: emit the opening form. Character
    // creation is handled deterministically by guard.js when the player
    // submits, so the prompt no longer references `<player-submission>` or
    // branches on it.
    expect(v1.systemPrompt).toContain("create-form");
    expect(v2.systemPrompt).toContain("create-form");

    // Language constraint content present on both paths.
    expect(v1.systemPrompt).toContain("中文");
    expect(v2.systemPrompt).toContain("中文");
  });

  it("V2 appends postHistory instructions after the player turn", () => {
    const parsed = loadPlayerInit();
    const params = makePlayerInitParams(parsed.promptTemplate, parsed.manifest);

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    // player-init declares `postHistory`, so V2 appends one extra system
    // instruction after the current user turn.
    expect(v2.messages).toHaveLength(v1.messages.length + 1);
    expect(v2.messages.at(-2)).toEqual(v1.messages.at(-1));
    expect(v2.messages.at(-1)?.role).toBe("system");
    expect(v2.messages.at(-1)?.content).toContain("create-form");
  });

  it("V2 gate requires both env flag AND promptVersion: 2", () => {
    const parsed = loadPlayerInit();
    const v1Manifest = { ...parsed.manifest, promptVersion: 1 as const };
    const params = makePlayerInitParams(parsed.promptTemplate, v1Manifest);

    process.env.COVEL_PROMPT_V2 = "1";
    const result = buildContext(params);

    expect(result.systemPrompt).toMatch(/in 中文\.\s*$/);
    expect(result.systemPrompt.startsWith("[LANGUAGE]")).toBe(false);
  });
});

describe("char-creator/character-tracker V1/V2 prompt parity", () => {
  it("manifest declares promptVersion: 2", () => {
    const parsed = loadCharacterTracker();
    expect(parsed.manifest.promptVersion).toBe(2);
  });

  it("V2 path routes through three-tier assembler when env flag is set", () => {
    const parsed = loadCharacterTracker();
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      parsed.manifest,
    );

    const v1 = buildContext(params);
    expect(v1.systemPrompt).toMatch(/in 中文\.\s*$/);

    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);
    expect(v2.systemPrompt.startsWith("[RUNTIME]")).toBe(true);
    expect(v2.systemPrompt).toContain("[LANGUAGE]");
  });

  it("V1 and V2 produce semantically equivalent system prompts", () => {
    const parsed = loadCharacterTracker();
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      parsed.manifest,
    );

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    const v1Norm = normalizeSystemPrompt(v1.systemPrompt);
    const v2Norm = normalizeSystemPrompt(v2.systemPrompt);

    expect(v2Norm).toBe(v1Norm);
  });

  it("both paths surface the narrator inject and world schema", () => {
    const parsed = loadCharacterTracker();
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      parsed.manifest,
    );

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    expect(v1.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);
    expect(v2.systemPrompt).toContain(NARRATOR_OUTPUT_TEXT);
    expect(v1.systemPrompt).toContain("<narrator-output>");
    expect(v2.systemPrompt).toContain("<narrator-output>");

    // Core instructional language preserved.
    expect(v1.systemPrompt).toContain("list-characters");
    expect(v2.systemPrompt).toContain("list-characters");
    expect(v1.systemPrompt).toContain("character-attributes");
    expect(v2.systemPrompt).toContain("character-attributes");

    // Language constraint on both.
    expect(v1.systemPrompt).toContain("中文");
    expect(v2.systemPrompt).toContain("中文");
  });

  it("V2 appends postHistory instructions after the player turn", () => {
    const parsed = loadCharacterTracker();
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      parsed.manifest,
    );

    const v1 = buildContext(params);
    process.env.COVEL_PROMPT_V2 = "1";
    const v2 = buildContext(params);

    expect(v2.messages).toHaveLength(v1.messages.length + 1);

    const playerTurn = v2.messages[v2.messages.length - 2];
    expect(playerTurn?.role).toBe("user");
    expect(playerTurn?.content).toBe("I greet Elina.");

    const last = v2.messages[v2.messages.length - 1];
    expect(last?.role).toBe("system");
    expect(last?.content).toContain("list-characters");

    const v1Last = v1.messages[v1.messages.length - 1];
    expect(v1Last?.role).toBe("user");
    expect(v1Last?.content).toBe("I greet Elina.");
  });

  it("V1 keeps the player turn as the final message", () => {
    const parsed = loadCharacterTracker();
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      parsed.manifest,
    );

    const v1 = buildContext(params);
    const last = v1.messages[v1.messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toBe("I greet Elina.");
  });

  it("V2 gate requires both env flag AND promptVersion: 2", () => {
    const parsed = loadCharacterTracker();
    const v1Manifest = { ...parsed.manifest, promptVersion: 1 as const };
    const params = makeCharacterTrackerParams(
      parsed.promptTemplate,
      v1Manifest,
    );

    process.env.COVEL_PROMPT_V2 = "1";
    const result = buildContext(params);

    expect(result.systemPrompt).toMatch(/in 中文\.\s*$/);
    expect(result.systemPrompt.startsWith("[LANGUAGE]")).toBe(false);
  });
});
