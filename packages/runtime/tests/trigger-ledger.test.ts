import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import type { RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import {
  collectExecutionJournal,
  collectExecutionTriggers,
} from "../src/execution-journal.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";

const once: RuntimeManifest = {
  pluginId: "tracker",
  name: "tracker/once",
  description: "Structured output, at most once",
  runtimeType: "function",
  stage: "post-turn",
  trigger: { type: "auto", maxTriggerCount: 1 },
  outputKind: "plugin",
};
const cooled: RuntimeManifest = {
  pluginId: "tracker",
  name: "tracker/cooled",
  description: "Narrates every other turn",
  runtimeType: "function",
  stage: "post-turn",
  trigger: { type: "auto", cooldownTurns: 2 },
  outputKind: "plugin",
};

async function playTurn(
  store: DataStore,
  turn: number,
  options: { readonly rollback?: boolean } = {},
): Promise<readonly string[]> {
  const turnId = `turn-${turn}`;
  const result = await executeTurn(
    {
      sessionId: "s",
      turnId,
      logicalTurnId: `logical-${turn}`,
      origin: "player",
      playerMessage: `move ${turn}`,
    },
    [once, cooled],
    {
      store,
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        handler: async () => ({
          outcome: "success" as const,
          value:
            manifest.name === once.name
              ? { snapshot: { turn } }
              : { narrativeOutput: `Turn ${turn} recap.` },
        }),
      }),
    },
  );
  await finalizeExecution({
    store,
    sessionId: "s",
    executionContext: result.executionContext,
    runtimes: [once, cooled],
    results: result.runtimeResults,
    journalMessages: collectExecutionJournal(result),
    runtimeTriggers: collectExecutionTriggers(result),
    turnIds: [],
    sessionClock: { now: new Date().toISOString() },
    ...(options.rollback
      ? {
          extraInTx: async () => {
            throw new Error("Rollback fixture");
          },
        }
      : {}),
  });
  return result.runtimeResults.map((runtime) => runtime.runtimeId);
}

describe("runtime trigger ledger", () => {
  it("runs a never-triggered runtime before a long cooldown starts", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "s",
      worldId: null,
      phase: "playing",
      status: "active",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["tracker"],
      createdAt: now,
      updatedAt: now,
    });
    const manifest = {
      ...cooled,
      trigger: { type: "auto" as const, cooldownTurns: 1000 },
    };
    const run = async (turn: number) =>
      executeTurn(
        {
          sessionId: "s",
          turnId: `long-${turn}`,
          origin: "player",
          playerMessage: "go",
        },
        [manifest],
        {
          store,
          loadRuntime: async () => ({
            manifest,
            promptTemplate: "",
            handler: async () => ({
              outcome: "success" as const,
              value: { ready: true },
            }),
          }),
        },
      );
    const first = await run(1);
    expect(first.runtimeResults.map((result) => result.runtimeId)).toEqual([
      manifest.name,
    ]);
    expect(
      (
        await finalizeExecution({
          store,
          sessionId: "s",
          executionContext: first.executionContext,
          runtimes: [manifest],
          results: first.runtimeResults,
          runtimeTriggers: collectExecutionTriggers(first),
          turnIds: [],
          sessionClock: { now },
        })
      ).status,
    ).toBe("committed");
    expect((await run(2)).runtimeResults).toEqual([]);
  });

  it("gates maxTriggerCount and cooldownTurns on committed runs only", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "s",
      worldId: null,
      phase: "playing",
      status: "active",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: ["tracker"],
      createdAt: now,
      updatedAt: now,
    });

    // A rolled-back turn runs both runtimes but counts neither.
    expect(await playTurn(store, 1, { rollback: true })).toEqual([
      cooled.name,
      once.name,
    ]);
    expect(await playTurn(store, 1)).toEqual([cooled.name, once.name]);
    expect(await playTurn(store, 2)).toEqual([]);
    expect(await playTurn(store, 3)).toEqual([cooled.name]);

    // The structured run left no journal row; the narration did.
    const runtimeRows = (await store.listTurnMessages("s")).filter(
      (message) => message.sourceType === "runtime",
    );
    expect(runtimeRows.map((message) => message.content)).toEqual([
      "Turn 1 recap.",
      "Turn 3 recap.",
    ]);
  });
});
