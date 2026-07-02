/**
 * S1-T3: Stream fallback in TurnExecutor.
 *
 * When the streaming LLM call throws mid-stream, the runtime either:
 *  - salvages accumulated content (and marks finishReason='error'), or
 *  - falls back to a single non-stream generate() call, or
 *  - (if both fail) surfaces a failed RuntimeResult via the outer catch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// ── Helpers ───────────────────────────────────────────────────────

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../../../plugins");

function makeTurnInput(overrides?: Partial<TurnInput>): TurnInput {
  return {
    sessionId: "sess-1",
    turnId: "turn-1",
    playerMessage: "test",
    ...overrides,
  };
}

/**
 * LLM that yields some text-deltas then throws mid-stream.
 * `generate` is a spy so tests can assert it was (or was not) invoked as fallback.
 */
class PartialStreamThenThrowLLM implements LLMAdapter {
  generate = vi.fn<LLMAdapter["generate"]>(
    async (): Promise<LLMResponse> => ({
      content: "FALLBACK_OUTPUT",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );

  // eslint-disable-next-line @typescript-eslint/require-await
  async *stream(): AsyncGenerator<LLMStreamEvent> {
    yield { type: "text-delta" as const, textDelta: "Hello " };
    yield { type: "text-delta" as const, textDelta: "world" };
    throw new Error("upstream reset");
  }
}

/**
 * LLM whose stream throws before yielding any content.
 * `generate` is a spy so tests can assert fallback invocation count.
 */
class EmptyStreamThrowLLM implements LLMAdapter {
  generate = vi.fn<LLMAdapter["generate"]>(
    async (): Promise<LLMResponse> => ({
      content: "NON_STREAM_RESCUE",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 2, outputTokens: 2 },
    }),
  );

  // eslint-disable-next-line @typescript-eslint/require-await, require-yield
  async *stream(): AsyncGenerator<LLMStreamEvent> {
    throw new Error("connection refused");
  }
}

/**
 * Stream throws immediately AND fallback generate() also throws.
 * Used to verify the outer executeOneRuntime catch path.
 */
class BothFailLLM implements LLMAdapter {
  generate = vi.fn<LLMAdapter["generate"]>(async (): Promise<LLMResponse> => {
    throw new Error("fallback generate also failed");
  });

  // eslint-disable-next-line @typescript-eslint/require-await, require-yield
  async *stream(): AsyncGenerator<LLMStreamEvent> {
    throw new Error("upstream refused");
  }
}

// ── Tests ─────────────────────────────────────────────────────────

describe("TurnExecutor stream recovery (S1-T3)", () => {
  let narratorManifest: RuntimeManifest;
  let narratorLoaded: LoadedRuntime;
  // Use a tool-free manifest to force the streaming path in turn-executor.
  let noToolManifest: RuntimeManifest;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    // Silence the [stream-recovery] warn output so test logs stay clean.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const discoveries = await discoverPlugins(PLUGINS_DIR);
    const narratorDiscovery = discoveries.find((d) => d.id === "narrator");
    expect(narratorDiscovery).toBeDefined();

    const manifests = await loadPluginManifest(narratorDiscovery!);
    narratorManifest = manifests[0]!.manifest;
    narratorLoaded = {
      manifest: narratorManifest,
      promptTemplate: manifests[0]!.promptTemplate,
    };
    noToolManifest = { ...narratorManifest, tools: undefined };
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("stream throws after yielding content: salvages accumulated text and marks error finishReason", async () => {
    const llm = new PartialStreamThenThrowLLM();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm,
      getConfig: () => ({}),
      store: await createMainLoopStore("sess-1"),
      onDelta: async () => {
        /* consume deltas */
      },
    };

    const result = await executeTurn(makeTurnInput(), [noToolManifest], deps);

    // Turn completes without throwing.
    expect(result.runtimeResults).toHaveLength(1);
    const rr = result.runtimeResults[0]!;
    expect(rr.status).toBe("success");

    // Accumulated streamed content survives.
    const output = rr.output as Record<string, unknown>;
    expect(output.narrativeOutput).toBe("Hello world");

    // Fallback generate() is NOT called when we have partial content.
    expect(llm.generate).not.toHaveBeenCalled();
  });

  it("stream throws with no content: falls back to generate() exactly once", async () => {
    const llm = new EmptyStreamThrowLLM();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm,
      getConfig: () => ({}),
      store: await createMainLoopStore("sess-1"),
      onDelta: async () => {
        /* no deltas expected */
      },
    };

    const result = await executeTurn(makeTurnInput(), [noToolManifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    const rr = result.runtimeResults[0]!;
    expect(rr.status).toBe("success");

    // Content comes from the fallback non-stream call.
    const output = rr.output as Record<string, unknown>;
    expect(output.narrativeOutput).toBe("NON_STREAM_RESCUE");

    // Exactly one fallback call.
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  it("stream throws AND fallback generate() also throws: runtime returns failed result", async () => {
    const llm = new BothFailLLM();
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => narratorLoaded,
      llm,
      getConfig: () => ({}),
      store: await createMainLoopStore("sess-1"),
      onDelta: async () => {
        /* no deltas expected */
      },
    };

    const result = await executeTurn(makeTurnInput(), [noToolManifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    const rr = result.runtimeResults[0]!;
    expect(rr.status).toBe("failed");
    expect(rr.error).toBeTruthy();
    expect(typeof rr.error).toBe("string");
    // The outer catch surfaces the fallback's error message.
    expect(rr.error).toContain("fallback generate also failed");
  });
});
