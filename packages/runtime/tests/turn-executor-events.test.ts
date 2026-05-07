/**
 * Tests for TurnExecutor EventBus bridge — verifies that turn/runtime lifecycle
 * events are emitted to the EventBus when one is provided.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import type {
  RuntimeManifest,
  TurnInput,
  SubscriptionEvent,
} from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm-adapter.js";
import { createEventBus, type EventBus } from "@covel/events";

// Prime a store with one prior player message so turnNumber >= 1 and
// main-loop priority runtimes survive the Pre-Game band filter.
async function createMainLoopStore(sessionId: string): Promise<DataStore> {
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

// ── Mock LLM ─────────────────────────────────────────────────────

class MockLLM implements LLMAdapter {
  response: LLMResponse = {
    content: "Test narrative output.",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  async generate(): Promise<LLMResponse> {
    return this.response;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "test message",
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe("TurnExecutor EventBus Bridge", () => {
  let mockLLM: MockLLM;
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;
  let eventBus: EventBus;

  beforeEach(async () => {
    mockLLM = new MockLLM();
    eventBus = createEventBus();

    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const narratorDiscovery = discoveries.find((d) => d.id === "narrator");
    expect(narratorDiscovery).toBeDefined();

    const manifests = await loadPluginManifest(narratorDiscovery!);
    narratorManifest = manifests[0]!.manifest;
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: manifests[0]!.promptTemplate,
      references: [],
    };
  });

  it("should emit turn.started and turn.completed events when eventBus is provided", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      eventBus,
      store: await createMainLoopStore("sess-1"),
    };

    await executeTurn(makeTurnInput(), [narratorManifest], deps);

    const turnStarted = events.find((e) => e.type === "turn.started");
    const turnCompleted = events.find((e) => e.type === "turn.completed");

    expect(turnStarted).toBeDefined();
    expect(turnStarted!.topic).toBe("game");
    expect(turnStarted!.sessionId).toBe("sess-1");
    expect((turnStarted!.payload as Record<string, unknown>).turnId).toBe(
      "turn-1",
    );

    expect(turnCompleted).toBeDefined();
    expect(turnCompleted!.topic).toBe("game");
    expect(
      (turnCompleted!.payload as Record<string, unknown>).durationMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("should emit runtime.started and runtime.completed events", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      eventBus,
      store: await createMainLoopStore("sess-1"),
    };

    await executeTurn(makeTurnInput(), [narratorManifest], deps);

    const runtimeStarted = events.find((e) => e.type === "runtime.started");
    const runtimeCompleted = events.find((e) => e.type === "runtime.completed");

    expect(runtimeStarted).toBeDefined();
    expect(runtimeStarted!.topic).toBe("runtime");
    expect((runtimeStarted!.payload as Record<string, unknown>).runtimeId).toBe(
      "narrator",
    );

    expect(runtimeCompleted).toBeDefined();
    expect(runtimeCompleted!.topic).toBe("runtime");
    expect(
      (runtimeCompleted!.payload as Record<string, unknown>).runtimeId,
    ).toBe("narrator");
    expect((runtimeCompleted!.payload as Record<string, unknown>).status).toBe(
      "success",
    );
  });

  it("should emit runtime.failed when runtime fails", async () => {
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    const failingLLM = new MockLLM();
    failingLLM.generate = async () => {
      throw new Error("LLM exploded");
    };

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: failingLLM,
      getConfig: () => ({}),
      eventBus,
      store: await createMainLoopStore("sess-1"),
    };

    await executeTurn(makeTurnInput(), [narratorManifest], deps);

    const runtimeFailed = events.find((e) => e.type === "runtime.failed");
    expect(runtimeFailed).toBeDefined();
    expect(runtimeFailed!.topic).toBe("runtime");
    expect((runtimeFailed!.payload as Record<string, unknown>).error).toContain(
      "LLM exploded",
    );
  });

  it("should still work when eventBus is not provided (backward compat)", async () => {
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm: mockLLM,
      getConfig: () => ({}),
      // No eventBus
      store: await createMainLoopStore("sess-1"),
    };

    const result = await executeTurn(makeTurnInput(), [narratorManifest], deps);
    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.status).toBe("success");
  });
});
