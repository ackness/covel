/**
 * Agent-guard write buffering & whole-execution atomicity.
 *
 * Scheduling redesign (Step 2): a trusted agent guard's domain writes (player
 * upsert, schema import) no longer hit the store directly — they route through
 * an execution write buffer, flush onto the guard's skipped result as
 * proposals, and commit through the same `finalizeExecution` transaction as
 * everything else. So a guard's write now rolls back atomically with the rest
 * of the execution: if a sibling proposal in the same execution fails to
 * commit, the guard's player is never persisted.
 */

import { describe, it, expect } from "vitest";
import {
  makeProposal,
  withPendingProposals,
} from "@covel/plugin-handlers-utils";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import type { LLMAdapter, LLMResponse } from "@covel/shared";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

const SESSION_ID = "sess-guard-buffer";

const guardRuntime = {
  name: "p/setup",
  pluginId: "p",
  description: "p/setup",
  stage: "setup", // setup band
  runtimeType: "agent",
  guard: "./guard.js",
  trigger: { type: "auto" },
  outputKind: "system",
  outputContract: undefined,
} as RuntimeManifest;

const siblingRuntime = {
  name: "p/writer",
  pluginId: "p",
  outputKind: "system",
  outputContract: undefined,
} as unknown as RuntimeManifest;

async function seedSetupSession(): Promise<DataStore> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    locale: "en-US",
    id: SESSION_ID,
    worldId: "w",
    status: "active",
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["p"],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

/**
 * Run the setup turn: an agent guard that buffers a player upsert and returns
 * `{ skip: true }`. Returns the guard's skipped result (carrying the buffered
 * character.upsert proposal) plus the store.
 */
async function runGuardTurn(removedStateWrite = false): Promise<{
  store: DataStore;
  guardResult: Awaited<
    ReturnType<typeof runTurnPipeline>
  >["runtimeResults"][number];
}> {
  const store = await seedSetupSession();
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "",
      guard: async (ctx) => {
        // A domain write any guard can make: a character.upsert proposal on
        // the skipped result.
        return withPendingProposals(
          { skip: true, preGameDone: true, playerName: "Rin" },
          [
            ...(removedStateWrite
              ? [
                  {
                    id: "removed-state-write",
                    type: "state.patch",
                    sessionId: ctx.sessionId,
                    source: {
                      pluginId: ctx.pluginId,
                      runtimeId: ctx.runtimeId,
                    },
                    turnId: "t1",
                    timestamp: new Date().toISOString(),
                    payload: { table: "stats", field: "hp", value: 1 },
                  } as unknown as import("@covel/plugin-handlers-utils").PluginProposal,
                ]
              : []),
            makeProposal(ctx, new Date().toISOString(), "character.upsert", {
              id: "player-x",
              name: "Rin",
              type: "player",
              version: 1,
              createdAt: new Date().toISOString(),
            }),
          ],
        );
      },
    }),
    llm: new NoopLLM(),
    store,
    getPluginSource: () => "builtin",
  };

  const input: TurnInput = {
    sessionId: SESSION_ID,
    turnId: "t1",
    playerMessage: "go",
    origin: "player",
  };
  const result = await runTurnPipeline(input, [guardRuntime], deps);
  const guardResult = result.runtimeResults[0]!;
  // The write buffered: nothing is in the store until finalize commits.
  expect(await store.listCharacters(SESSION_ID)).toHaveLength(0);
  expect(guardResult.status).toBe("skipped");
  return { store, guardResult };
}

/** A sibling result whose notification has a non-object entry → rejected on commit. */
function failingSiblingResult(): Parameters<
  typeof finalizeExecution
>[0]["results"][number] {
  return {
    pluginId: "p",
    runtimeId: "p/writer",
    runId: crypto.randomUUID(),
    turnId: "t1",
    status: "success",
    output: {},
    effects: { notifications: [null] },
    toolCalls: [],
  };
}

describe("agent guard write buffer — whole-execution atomicity", () => {
  it("rejects a removed state.patch proposal buffered by a skipped guard", async () => {
    const { store, guardResult } = await runGuardTurn(true);
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: "removed-guard-write",
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [guardRuntime],
      results: [guardResult],
      turnIds: ["t1"],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedProposals).toEqual([
      expect.objectContaining({
        proposal: expect.objectContaining({ type: "state.patch" }),
        code: "proposal-invalid",
        error: "unknown proposal type: state.patch",
      }),
    ]);
    expect(await store.listCharacters(SESSION_ID)).toEqual([]);
    expect(await store.getStateEntry(SESSION_ID, "stats", "hp")).toBeNull();
  });

  it("rejects removed effects on a skipped guard that would commit buffered writes", async () => {
    const { store, guardResult } = await runGuardTurn();
    const outcome = await finalizeExecution({
      executionContext: {
        executionId: "removed-guard-effects",
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [guardRuntime],
      results: [
        {
          ...guardResult,
          effects: {
            statePatches: [],
          } as unknown as import("@covel/shared").RuntimeEffects,
        },
      ],
      turnIds: ["t1"],
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.failedProposals).toEqual([
      expect.objectContaining({
        proposal: expect.objectContaining({ type: "effects.invalid" }),
        error:
          "effects.statePatches is no longer supported; use plugin data (effects.pluginData) instead",
      }),
    ]);
    expect(await store.listCharacters(SESSION_ID)).toEqual([]);
  });
  it("rolls the guard's player back when a same-execution proposal fails", async () => {
    const { store, guardResult } = await runGuardTurn();

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [guardRuntime, siblingRuntime],
      // Guard's buffered player upsert commits, then the sibling's malformed
      // notification is rejected — the whole execution rolls back.
      results: [guardResult, failingSiblingResult()],
      turnIds: ["t1"],
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.failedProposals).toHaveLength(1);
    // The guard's player never landed — zero characters after the rollback.
    expect(await store.listCharacters(SESSION_ID)).toHaveLength(0);
  });

  it("commits the guard's player when the execution succeeds", async () => {
    const { store, guardResult } = await runGuardTurn();

    const outcome = await finalizeExecution({
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "manual",
        countPolicy: "none",
      },
      store,
      sessionId: SESSION_ID,
      runtimes: [guardRuntime],
      results: [guardResult],
      turnIds: ["t1"],
    });

    expect(outcome.status).toBe("committed");
    const characters = await store.listCharacters(SESSION_ID);
    expect(characters).toHaveLength(1);
    expect(characters[0]).toMatchObject({ name: "Rin", type: "player" });
  });
});
