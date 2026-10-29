/**
 * A player's resolved actions reach plugins unchanged: `ctx.playerActions`
 * for function runtimes, `actions` on the TurnStart hook payload and on the
 * turn digest. An execution without player input sees none, and a nested
 * `recursiveCall` never inherits them.
 */
import { describe, expect, it } from "vitest";
import type { RuntimeManifest, TurnAction, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store/memory";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { buildTurnDigest } from "../src/turn-executor/turn-digest.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

const SESSION_ID = "sess-actions";

const ACTIONS: readonly TurnAction[] = [
  {
    seatId: "main",
    kind: "say",
    actorId: "char-scout",
    text: "Wait for me.",
    source: "player",
  },
  {
    seatId: "main",
    kind: "act",
    actorId: "char-hero",
    text: "[Player input] plan: climb",
    fields: { plan: "climb" },
    interaction: { turnId: "t0", interactionId: "f1", type: "form" },
    source: "player",
  },
];

const parent: RuntimeManifest = {
  name: "p/fn",
  pluginId: "p",
  description: "p/fn",
  stage: "narrative",
  runtimeType: "function",
  handler: "./parent.js",
  trigger: { type: "auto" },
  outputKind: "system",
};
const child: RuntimeManifest = {
  name: "p/child",
  pluginId: "p",
  description: "p/child",
  stage: "narrative",
  runtimeType: "function",
  handler: "./child.js",
  trigger: { type: "manual" },
  outputKind: "system",
};

async function store() {
  const memory = createMemoryStore();
  const now = new Date().toISOString();
  await memory.createSession({
    id: SESSION_ID,
    worldId: "w",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    setupRuntimes: {},
    activePlugins: ["p"],
    createdAt: now,
    updatedAt: now,
  });
  return memory;
}

async function run(input: TurnInput) {
  const seen: Record<string, readonly TurnAction[]> = {};
  // One entry per execution: the turn, then each nested `recursiveCall`.
  const turnStarts: (readonly TurnAction[])[] = [];
  const hookPipeline = createHookPipeline();
  hookPipeline.register({
    id: "watcher:TurnStart",
    pluginId: "watcher",
    event: "TurnStart",
    handler: async (_context, payload) => {
      turnStarts.push((payload as { actions: readonly TurnAction[] }).actions);
      return { action: "continue" };
    },
  });
  const deps: TurnExecutorDeps = {
    loadRuntime: async (manifest) => ({
      manifest,
      promptTemplate: "",
      handler: async (ctx) => {
        seen[manifest.name] = ctx.playerActions;
        if (manifest.name === parent.name && !input.manualTrigger)
          await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
        return { outcome: "success", value: { ok: true } };
      },
    }),
    llm: {
      generate: async () => ({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    store: await store(),
    hookPipeline,
    hookScope: { activePluginIds: new Set(["watcher", "p"]), settings: {} },
  };
  await runTurnPipeline(input, [parent, child], deps);
  return { seen, turnStarts };
}

describe("player actions in a turn", () => {
  it("hands the resolved actions to function runtimes and TurnStart", async () => {
    const { seen, turnStarts } = await run({
      origin: "player",
      sessionId: SESSION_ID,
      turnId: "turn-1",
      playerMessage: "[Scout · says] Wait for me.",
      actions: ACTIONS,
      locale: "en-US",
    });
    expect(seen["p/fn"]).toEqual(ACTIONS);
    // A nested execution has no player input of its own.
    expect(seen["p/child"]).toEqual([]);
    expect(turnStarts).toEqual([ACTIONS, []]);
  });

  it("gives an execution without player input no actions", async () => {
    const { seen, turnStarts } = await run({
      origin: "manual",
      sessionId: SESSION_ID,
      turnId: "turn-2",
      playerMessage: "",
      locale: "en-US",
      manualTrigger: { runtimeId: child.name },
    });
    expect(seen["p/child"]).toEqual([]);
    expect(turnStarts).toEqual([[]]);
  });

  it("freezes the actions into the turn digest", () => {
    const digest = buildTurnDigest(
      {
        origin: "player",
        sessionId: SESSION_ID,
        turnId: "turn-1",
        playerMessage: "Wait for me.",
        actions: ACTIONS,
      },
      [],
      [],
    );
    expect(digest.actions).toEqual(ACTIONS);
    expect(
      buildTurnDigest(
        {
          origin: "manual",
          sessionId: SESSION_ID,
          turnId: "turn-2",
          playerMessage: "",
        },
        [],
        [],
      ).actions,
    ).toEqual([]);
  });
});
