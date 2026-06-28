/**
 * Wiring tests for the S1-T5 context-budget plumbing in turn-executor.
 *
 * These tests lock in the gates on budget injection:
 *
 *   1. Injected when: estimator + contextBudget + no declared tools
 *   2. Skipped when: manifest declares `input.tools` (I1 tool-pair guard)
 *   3. Skipped when: manifest declares `tools.builtin` (I1 tool-pair guard)
 *   4. Skipped when: manifest declares `tools.local` (I1 tool-pair guard)
 *
 * Turn-executor's job is to thread the dependency references through. We
 * verify the thread by spying on the estimator — if it gets called at least
 * once during the turn, we know the budget pass ran.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import type { TokenEstimator } from "@covel/context";
import { createMemoryStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

// Prime a store with one prior player message so turnNumber >= 1 and
// main-loop priority runtimes survive the Pre-Game band filter.
async function createMainLoopStore(sessionId: string) {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "prior-player-0",
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

// ── Fixtures ─────────────────────────────────────────────────────

function makeResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 42, outputTokens: 10 },
  };
}

function makeManifest(overrides?: Partial<RuntimeManifest>): RuntimeManifest {
  return {
    name: "test-narrator",
    pluginId: "test-narrator",
    description: "Synthetic narrator for budget-wiring tests.",
    priority: 500,
    runtimeType: "agent",
    outputKind: "story",
    ...overrides,
  };
}

function makeLoaded(manifest: RuntimeManifest): LoadedRuntime {
  return {
    manifest,
    promptTemplate: "You are narrating. Current message: {{ player.message }}.",
    references: [],
  };
}

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-budget-wire",
    turnId: "turn-1",
    playerMessage: "Look around the room",
    ...overrides,
  };
}

async function makeBaseDeps(
  llm: LLMAdapter,
  manifest: RuntimeManifest,
): Promise<TurnExecutorDeps> {
  return {
    loadRuntime: async () => makeLoaded(manifest),
    llm,
    getConfig: () => ({}),
    store: await createMainLoopStore("sess-budget-wire"),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe("turn-executor → context budget wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes the estimator when all conditions are met", async () => {
    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Narrator-like manifest: no tools declared on input.
    const manifest = makeManifest();

    const deps: TurnExecutorDeps = {
      ...(await makeBaseDeps(llm, manifest)),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(estimator).toHaveBeenCalled();
  });

  it("skips the estimator when the manifest declares input.tools (I1 guard)", async () => {
    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare at least one input tool — turn-executor must NOT inject budget.
    const manifest = makeManifest({
      input: {
        tools: [{ plugin: "other-plugin", runtime: "other-runtime" }],
      },
    });

    const deps: TurnExecutorDeps = {
      ...(await makeBaseDeps(llm, manifest)),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });

  it("skips the estimator when the manifest declares tools.builtin (I1 guard)", async () => {
    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare a builtin tool — buildToolDefinitions would register it, so budget
    // injection must be skipped to avoid splitting assistant↔tool pairs.
    const manifest = makeManifest({
      tools: {
        builtin: ["plugin-data-set"],
      },
    });

    const deps: TurnExecutorDeps = {
      ...(await makeBaseDeps(llm, manifest)),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });

  it("skips the estimator when the manifest declares tools.local (I1 guard)", async () => {
    const estimator: TokenEstimator = vi.fn((text: string) => text.length);
    const llm: LLMAdapter = {
      generate: vi.fn(async () => makeResponse('{"narrativeOutput":"ok"}')),
    };

    // Declare a local tool path — buildToolDefinitions would register it, so
    // budget injection must be skipped.
    const manifest = makeManifest({
      tools: {
        local: ["./tools/dummy.ts"],
      },
    });

    const deps: TurnExecutorDeps = {
      ...(await makeBaseDeps(llm, manifest)),
      estimator,
      contextBudget: {
        maxInputTokens: 4000,
        reservedForResponse: 500,
        protectLastUserTurns: 2,
      },
    };

    const result = await executeTurn(makeTurnInput(), [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(estimator).not.toHaveBeenCalled();
  });
});
