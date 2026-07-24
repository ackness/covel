/**
 * Step 1B: `executeTurn` creates one immutable ExecutionContext per run.
 *
 * Behavior must stay byte-identical: the run's `origin` is normalized
 * (legacy `follower` → `background`) for kernel reads, but the persisted
 * `turn_results.origin` column is projected back so it matches the pre-change
 * value exactly. `countPolicy` is derived at creation (recorded, not yet
 * consumed), and every execution gets a unique `executionId`.
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

function depsFor(store: DataStore): TurnExecutorDeps {
  return {
    loadRuntime: async () => ({
      manifest: {} as RuntimeManifest,
      promptTemplate: "",
    }),
    llm: new NoopLLM(),
    store,
  };
}

// No runtimes: origin handling is independent of what actually runs, so an
// empty active set exercises the ExecutionContext path with zero LLM noise.
async function runWithOrigin(
  sessionId: string,
  origin: TurnInput["origin"],
  extra?: Partial<TurnInput>,
): Promise<{
  store: DataStore;
  result: Awaited<ReturnType<typeof executeTurn>>;
}> {
  const store = await freshActiveStore(sessionId);
  const result = await executeTurn(
    {
      sessionId,
      turnId: "t",
      playerMessage: "",
      ...(origin ? { origin } : {}),
      ...extra,
    },
    [],
    depsFor(store),
  );
  return { store, result };
}

const originCases: ReadonlyArray<{
  readonly input: TurnInput["origin"];
  readonly context: string;
  readonly persisted: string;
}> = [
  { input: undefined, context: "player", persisted: "player" },
  { input: "player", context: "player", persisted: "player" },
  { input: "manual", context: "manual", persisted: "manual" },
  // Legacy `follower` is the only value that remaps; it must round-trip back.
  { input: "follower", context: "background", persisted: "follower" },
  { input: "recursive", context: "recursive", persisted: "recursive" },
];

describe("execution origin: normalize on read, legacy-project on persist", () => {
  for (const c of originCases) {
    it(`origin ${String(c.input)} → context ${c.context}, persists ${c.persisted}`, async () => {
      const { store, result } = await runWithOrigin("s", c.input);

      expect(result.executionContext?.origin).toBe(c.context);

      const rows = await store.listTurnResults("s");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.origin).toBe(c.persisted);
    });
  }
});

const countPolicyCases: ReadonlyArray<{
  readonly name: string;
  readonly origin: TurnInput["origin"];
  readonly preGamePending: boolean | undefined;
  readonly expected: "none" | "complete-player-turn";
}> = [
  {
    name: "player + not pre-game",
    origin: undefined,
    preGamePending: false,
    expected: "complete-player-turn",
  },
  {
    name: "player + pre-game pending",
    origin: "player",
    preGamePending: true,
    expected: "none",
  },
  {
    name: "manual",
    origin: "manual",
    preGamePending: false,
    expected: "none",
  },
  {
    name: "follower (background)",
    origin: "follower",
    preGamePending: false,
    expected: "none",
  },
  {
    name: "recursive",
    origin: "recursive",
    preGamePending: false,
    expected: "none",
  },
];

describe("countPolicy derivation", () => {
  for (const c of countPolicyCases) {
    it(`${c.name} → ${c.expected}`, async () => {
      const { result } = await runWithOrigin("s", c.origin, {
        preGamePending: c.preGamePending,
      });
      expect(result.executionContext?.countPolicy).toBe(c.expected);
    });
  }
});

describe("executionId", () => {
  it("is unique per execution", async () => {
    const store = await freshActiveStore("s");
    const deps = depsFor(store);
    const r1 = await executeTurn(
      { sessionId: "s", turnId: "t1", playerMessage: "" },
      [],
      deps,
    );
    const r2 = await executeTurn(
      { sessionId: "s", turnId: "t2", playerMessage: "" },
      [],
      deps,
    );
    expect(r1.executionContext?.executionId).toBeTruthy();
    expect(r1.executionContext?.executionId).not.toBe(
      r2.executionContext?.executionId,
    );
  });
});
