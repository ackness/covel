/**
 * Tests for TurnExecutor resilience — verifies that callback failures
 * (onRuntimeStart, onDelta, eventBus.emit) don't crash the runtime.
 *
 * Covers:
 * - H2: onRuntimeStart failure should not kill the runtime
 * - M1: onDelta error during streaming should not kill the runtime
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type {
  LLMAdapter,
  LLMResponse,
  LLMStreamEvent,
} from "../src/llm/llm-adapter.js";

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
    content: "Narrative output text.",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5 },
  };

  async generate(): Promise<LLMResponse> {
    return this.response;
  }
}

class StreamingMockLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "fallback",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async *stream(): AsyncGenerator<LLMStreamEvent> {
    yield { type: "text-delta" as const, textDelta: "Hello " };
    yield { type: "text-delta" as const, textDelta: "world" };
    yield { type: "done" as const, finishReason: "stop" };
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

describe("TurnExecutor Resilience", () => {
  let mockLLM: MockLLM;
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;

  beforeEach(async () => {
    mockLLM = new MockLLM();

    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const narratorDiscovery = discoveries.find((d) => d.id === "narrator");
    expect(narratorDiscovery).toBeDefined();

    const manifests = await loadPluginManifest(narratorDiscovery!);
    narratorManifest = manifests[0]!.manifest;
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: manifests[0]!.promptTemplate,
    };
  });

  describe("H2: onRuntimeStart failure should not crash the runtime", () => {
    it("should complete the turn even when onRuntimeStart throws", async () => {
      const deps: TurnExecutorDeps = {
        loadRuntime: async () => narratorLoaded,
        llm: mockLLM,
        onRuntimeStart: async () => {
          throw new Error("SSE write failed");
        },
        store: await createMainLoopStore("sess-1"),
      };

      const result = await executeTurn(
        makeTurnInput(),
        [narratorManifest],
        deps,
      );

      // Turn should still succeed despite onRuntimeStart failure
      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
    });

    it("should complete the turn even when onRuntimeStart rejects", async () => {
      const deps: TurnExecutorDeps = {
        loadRuntime: async () => narratorLoaded,
        llm: mockLLM,
        onRuntimeStart: () => Promise.reject(new Error("Connection closed")),
        store: await createMainLoopStore("sess-1"),
      };

      const result = await executeTurn(
        makeTurnInput(),
        [narratorManifest],
        deps,
      );

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
    });
  });

  describe("M1: onDelta error during streaming should not kill the runtime", () => {
    it("should complete streaming even when onDelta throws", async () => {
      const streamingLLM = new StreamingMockLLM();
      let deltaCallCount = 0;

      const deps: TurnExecutorDeps = {
        loadRuntime: async () => narratorLoaded,
        llm: streamingLLM,
        onDelta: async () => {
          deltaCallCount++;
          throw new Error("Client disconnected");
        },
        store: await createMainLoopStore("sess-1"),
      };

      // Use a manifest without tools to trigger streaming path
      const noToolManifest: RuntimeManifest = {
        ...narratorManifest,
        tools: undefined,
      };

      const result = await executeTurn(makeTurnInput(), [noToolManifest], deps);

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
      // onDelta should have been called (even though it threw)
      expect(deltaCallCount).toBeGreaterThan(0);
      // Content should still be accumulated
      const output = result.runtimeResults[0]!.output as Record<
        string,
        unknown
      >;
      expect(output.narrativeOutput).toBe("Hello world");
    });
  });
});
