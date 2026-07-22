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
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore, type DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

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
  priority: 40, // setup band
  runtimeType: "agent",
  guard: "./guard.js",
  trigger: { type: "auto" },
  outputKind: "plugin",
  capabilities: [],
} as RuntimeManifest;

const siblingRuntime = {
  name: "p/writer",
  pluginId: "p",
  outputKind: "plugin",
  capabilities: [],
} as unknown as RuntimeManifest;

async function seedSetupSession(): Promise<DataStore> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION_ID,
    worldId: "w",
    status: "active",
    turnCount: 0,
    preGameCompleted: [],
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes: {},
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
async function runGuardTurn(): Promise<{
  store: DataStore;
  guardResult: Awaited<
    ReturnType<typeof executeTurn>
  >["runtimeResults"][number];
}> {
  const store = await seedSetupSession();
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "",
      guard: async (ctx: { store: DataStore }) => {
        const now = new Date().toISOString();
        // Buffered domain write — collected as a character.upsert proposal.
        await ctx.store.upsertCharacter({
          id: "player-x",
          sessionId: SESSION_ID,
          name: "Rin",
          type: "player",
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
        return { skip: true, preGameDone: true, playerName: "Rin" };
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
    preGamePending: true,
  };
  const result = await executeTurn(input, [guardRuntime], deps);
  const guardResult = result.runtimeResults[0]!;
  // The write buffered: nothing is in the store until finalize commits.
  expect(await store.listCharacters(SESSION_ID)).toHaveLength(0);
  expect(guardResult.status).toBe("skipped");
  return { store, guardResult };
}

/** A sibling result whose state.patch is missing `table` → rejected on commit. */
function failingSiblingResult(): Parameters<
  typeof finalizeExecution
>[0]["results"][number] {
  return {
    pluginId: "p",
    runtimeId: "p/writer",
    runId: crypto.randomUUID(),
    turnId: "t1",
    status: "success",
    output: { statePatches: [{ field: "hp", value: 1 }] },
    toolCalls: [],
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

describe("agent guard write buffer — whole-execution atomicity", () => {
  it("rolls the guard's player back when a same-execution proposal fails", async () => {
    const { store, guardResult } = await runGuardTurn();

    const outcome = await finalizeExecution({
      store,
      sessionId: SESSION_ID,
      runtimes: [guardRuntime, siblingRuntime],
      // Guard's buffered player upsert commits, then the sibling's malformed
      // state.patch is rejected — the whole execution rolls back.
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
