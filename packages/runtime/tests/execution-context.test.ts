import { describe, expect, it } from "vitest";
import type {
  ExecutionOrigin,
  RuntimeManifest,
  TurnInput,
} from "@covel/shared";
import { createMemoryStore, type DataStore } from "@covel/store";
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

async function freshActiveStore(
  sessionId: string,
  phase: "setup" | "playing",
): Promise<DataStore> {
  const store = createMemoryStore();
  await store.createSession({
    id: sessionId,
    worldId: "w",
    status: "active",
    activePlugins: [],
    phase,
    completedPlayerTurns: 0,
    setupRuntimes: {},
    locale: "zh-CN",
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

async function runWithOrigin(
  origin: ExecutionOrigin,
  phase: "setup" | "playing" = "playing",
): Promise<{
  store: DataStore;
  result: Awaited<ReturnType<typeof executeTurn>>;
}> {
  const store = await freshActiveStore("s", phase);
  const input: TurnInput = {
    sessionId: "s",
    turnId: "t",
    playerMessage: "",
    origin,
    ...(origin === "player" ? { logicalTurnId: "logical-1" } : {}),
  };
  const result = await executeTurn(input, [], depsFor(store));
  return { store, result };
}

describe("canonical execution origin", () => {
  for (const origin of [
    "player",
    "continuation",
    "manual",
    "background",
    "recursive",
    "resume",
  ] as const) {
    it(`persists ${origin} unchanged`, async () => {
      const { store, result } = await runWithOrigin(origin);
      expect(result.executionContext.origin).toBe(origin);
      expect((await store.listTurnResults("s"))[0]!.origin).toBe(origin);
    });
  }
});

describe("countPolicy derivation", () => {
  it("counts a player execution that starts in playing phase", async () => {
    const { result } = await runWithOrigin("player", "playing");
    expect(result.executionContext.countPolicy).toBe("complete-player-turn");
  });

  it("does not count a player execution that starts in setup phase", async () => {
    const { result } = await runWithOrigin("player", "setup");
    expect(result.executionContext.countPolicy).toBe("none");
  });

  for (const origin of [
    "continuation",
    "manual",
    "background",
    "recursive",
    "resume",
  ] as const) {
    it(`does not count ${origin}`, async () => {
      const { result } = await runWithOrigin(origin, "playing");
      expect(result.executionContext.countPolicy).toBe("none");
    });
  }
});

describe("executionId", () => {
  it("is unique per execution", async () => {
    const store = await freshActiveStore("s", "playing");
    const deps = depsFor(store);
    const base = {
      sessionId: "s",
      playerMessage: "",
      origin: "manual",
    } as const;
    const r1 = await executeTurn({ ...base, turnId: "t1" }, [], deps);
    const r2 = await executeTurn({ ...base, turnId: "t2" }, [], deps);
    expect(r1.executionContext.executionId).toBeTruthy();
    expect(r1.executionContext.executionId).not.toBe(
      r2.executionContext.executionId,
    );
  });
});
