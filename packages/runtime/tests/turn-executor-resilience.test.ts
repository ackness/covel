import { manifest, submitted } from "./_helpers/agent-loop-fixture.js";
/** Runtime lifecycle observer failures cannot discard accepted output. */

import { describe, it, expect, beforeEach } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import type { LoadedRuntime } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import type { DataStore } from "@covel/store";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse, LLMStreamEvent } from "@covel/shared";

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
  response: LLMResponse = submitted("Narrative output text.");

  async generate(): Promise<LLMResponse> {
    return this.response;
  }
}

class StreamingMockLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return submitted("fallback");
  }

  async *stream(): AsyncGenerator<LLMStreamEvent> {
    yield { type: "text-delta" as const, textDelta: "Hello " };
    yield { type: "text-delta" as const, textDelta: "world" };
    yield {
      type: "tool-call" as const,
      ...submitted("Hello world").toolCalls[0]!,
    };
    yield { type: "done" as const, finishReason: "tool_calls" };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    origin: "player",
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

    narratorManifest = manifest({
      name: "narrator",
      pluginId: "narrator",
      outputKind: "story",
      tools: {},
    });
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: "Submit a story.",
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

      const result = await runTurnPipeline(
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

      const result = await runTurnPipeline(
        makeTurnInput(),
        [narratorManifest],
        deps,
      );

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
    });
  });

  describe("completion observer resilience", () => {
    it("keeps accepted streamed output when the completion observer throws", async () => {
      const streamingLLM = new StreamingMockLLM();
      let completeCallCount = 0;

      const deps: TurnExecutorDeps = {
        loadRuntime: async () => narratorLoaded,
        llm: streamingLLM,
        onRuntimeComplete: async () => {
          completeCallCount++;
          throw new Error("Client disconnected");
        },
        store: await createMainLoopStore("sess-1"),
      };

      // Use a manifest without tools to trigger streaming path
      const noToolManifest: RuntimeManifest = {
        ...narratorManifest,
        tools: undefined,
      };

      const result = await runTurnPipeline(
        makeTurnInput(),
        [noToolManifest],
        deps,
      );

      expect(result.runtimeResults).toHaveLength(1);
      expect(result.runtimeResults[0]!.status).toBe("success");
      expect(completeCallCount).toBeGreaterThan(0);
      // Content should still be accumulated
      const output = result.runtimeResults[0]!.output as Record<
        string,
        unknown
      >;
      expect(output.narrativeOutput).toBe("Hello world");
    });
  });
});
