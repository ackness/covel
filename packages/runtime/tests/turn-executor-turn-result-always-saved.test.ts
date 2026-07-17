/**
 * Invariant: `executeTurn` always calls `store.saveTurnResult` before it
 * returns — even when zero runtimes ran, when the session is paused, or when
 * all runtimes failed. `actions.ts` derives `session.turnCount` from
 * `listTurnResults().length`, so skipping this write silently desyncs the
 * UI turn counter from the actual number of runs.
 *
 * Exception: when `session.status !== 'active'` (paused/ended) executeTurn
 * returns early *before* saving — that's intentional because no runtimes
 * ran and creating a turn_result row would be misleading. That path is
 * covered explicitly below.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

async function freshActiveStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    worldId: "w",
    turnCount: 0,
    status: "active",
    activePlugins: [],
    preGameCompleted: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return store;
}

function fnManifest(name: string, priority: number): RuntimeManifest {
  return {
    name,
    pluginId: name,
    description: name,
    priority,
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

describe("executeTurn: saveTurnResult invariant", () => {
  it("persists a turn_result for the happy path (handler succeeds)", async () => {
    const store = await freshActiveStore("sess-happy");
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => ({ preGameDone: true }),
      }),
      llm: new NoopLLM(),
      store,
    };
    await executeTurn(
      { sessionId: "sess-happy", turnId: "t-1", playerMessage: "" },
      [fnManifest("pregame", 10)],
      deps,
    );
    expect(await store.listTurnResults("sess-happy")).toHaveLength(1);
  });

  it("persists a turn_result even when every runtime handler throws", async () => {
    const store = await freshActiveStore("sess-fail");
    const deps: TurnExecutorDeps = {
      loadRuntime: async (m) => ({
        manifest: m,
        promptTemplate: "",
        handler: async () => {
          throw new Error("blew up");
        },
      }),
      llm: new NoopLLM(),
      store,
    };
    await executeTurn(
      { sessionId: "sess-fail", turnId: "t-1", playerMessage: "" },
      [fnManifest("pregame", 10)],
      deps,
    );

    const results = await store.listTurnResults("sess-fail");
    expect(results).toHaveLength(1);
    // The turn_result records the failure so downstream tools can show it.
    const runtimes = results[0]!.runtimeResults as Array<{ status: string }>;
    expect(runtimes[0]!.status).toBe("failed");
  });

  it("persists a turn_result when zero runtimes are scheduled", async () => {
    // No runtimes in the active list → scheduleByPriority returns empty;
    // but executeTurn still must record the turn so turnCount increments.
    const store = await freshActiveStore("sess-empty");
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => ({
        manifest: {} as RuntimeManifest,
        promptTemplate: "",
      }),
      llm: new NoopLLM(),
      store,
    };
    await executeTurn(
      { sessionId: "sess-empty", turnId: "t-1", playerMessage: "" },
      [],
      deps,
    );
    expect(await store.listTurnResults("sess-empty")).toHaveLength(1);
  });

  it("does NOT persist a turn_result when the session is paused", async () => {
    // A paused session intentionally short-circuits executeTurn with no
    // runtime activity — don't create a phantom turn_result.
    const store = await freshActiveStore("sess-paused");
    await store.updateSession("sess-paused", { status: "paused" });
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => ({
        manifest: {} as RuntimeManifest,
        promptTemplate: "",
      }),
      llm: new NoopLLM(),
      store,
    };
    await executeTurn(
      { sessionId: "sess-paused", turnId: "t-1", playerMessage: "" },
      [fnManifest("pregame", 10)],
      deps,
    );
    expect(await store.listTurnResults("sess-paused")).toHaveLength(0);
  });
});
