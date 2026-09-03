import { describe, expect, it, vi } from "vitest";
import type { InputSlot, RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { LoadedRuntime } from "@covel/plugin-loader";
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

function runtime(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "post-turn",
    runtimeType: "function",
    handler: "./handler.js",
    outputKind: "plugin",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

async function testDeps(
  manifests: readonly RuntimeManifest[],
  handlers: ReadonlyMap<
    string,
    (ctx: unknown) => Promise<Record<string, unknown>>
  >,
): Promise<TurnExecutorDeps> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "session",
    worldId: "world",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: [...new Set(manifests.map((manifest) => manifest.pluginId))],
    createdAt: now,
    updatedAt: now,
  });
  return {
    store,
    llm: new NoopLLM(),
    loadRuntime: async (manifest): Promise<LoadedRuntime> => ({
      manifest,
      promptTemplate: "",
      handler: handlers.get(manifest.name),
    }),
  };
}

describe("scheduler-driven detached turn completion", () => {
  it("queues an eligible leaf without awaiting or invoking it", async () => {
    const narrative = runtime("story", {
      stage: "narrative",
      capabilities: ["narrative-engine"],
    });
    const detached = runtime("media/tts", {
      needs: [{ capability: "narrative-engine" }],
      inputs: {
        narrative: {
          from: { capability: "narrative-engine" },
          select: "/narrativeOutput",
        },
      },
      effects: { writes: ["media:*", "plugin-data:self:tracks"] },
      turnCompletion: { mode: "detached", maxQueueMs: 30_000 },
      version: "1.2.3",
    });
    const detachedHandler = vi.fn(async () => ({
      outcome: "success",
      value: { shouldNotRun: true },
    }));
    const deps = await testDeps(
      [narrative, detached],
      new Map([
        [
          narrative.name,
          async () => ({
            outcome: "success",
            value: { narrativeOutput: "hello" },
          }),
        ],
        [detached.name, detachedHandler],
      ]),
    );

    const result = await executeTurn(
      {
        sessionId: "session",
        turnId: "source-turn",
        logicalTurnId: "logical-turn",
        playerMessage: "go",
        origin: "player",
      },
      [narrative, detached],
      deps,
    );

    expect(detachedHandler).not.toHaveBeenCalled();
    expect(result.runtimeResults.map((entry) => entry.runtimeId)).toEqual([
      "story",
    ]);
    expect(result.deferredRuntimeJobs).toHaveLength(1);
    expect(result.deferredRuntimeJobs?.[0]).toMatchObject({
      runtimeId: "media/tts",
      pluginId: "media",
      sourceTurnId: "source-turn",
      sourceLogicalTurnId: "logical-turn",
      pluginVersion: "1.2.3",
    });
    expect(result.deferredRuntimeJobs?.[0]?.upstreamResults).toHaveLength(1);
  });

  it("rehydrates frozen upstream results when the detached worker runs", async () => {
    const narrative = runtime("story", {
      stage: "narrative",
      capabilities: ["narrative-engine"],
    });
    const detached = runtime("media/tts", {
      needs: [{ capability: "narrative-engine" }],
      inputs: {
        narrative: {
          from: { capability: "narrative-engine" },
          select: "/narrativeOutput",
        },
      },
      effects: { writes: ["media:*", "plugin-data:self:tracks"] },
      turnCompletion: { mode: "detached" },
    });
    const seen = vi.fn();
    const deps = await testDeps(
      [narrative, detached],
      new Map([
        [
          detached.name,
          async (rawCtx) => {
            const ctx = rawCtx as {
              inputs?: Readonly<Record<string, InputSlot>>;
              activation?: { source?: string; detached?: boolean };
            };
            seen(
              ctx.inputs?.narrative && "value" in ctx.inputs.narrative
                ? ctx.inputs.narrative.value
                : undefined,
              ctx.activation,
            );
            return { outcome: "success", value: { ok: true } };
          },
        ],
      ]),
    );
    const sourceResult = {
      pluginId: "story",
      runtimeId: "story",
      runId: "source-result",
      turnId: "source-turn",
      status: "success" as const,
      output: { narrativeOutput: "frozen text" },
      toolCalls: [],
      durationMs: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const input: TurnInput = {
      sessionId: "session",
      turnId: "background-turn",
      playerMessage: "",
      origin: "background",
      detachedStage: {
        jobId: "runtime-job-1",
        runtimeId: detached.name,
        sourceTurnId: "source-turn",
        sourceExecutionId: "source-execution",
        sourceExecutionStartedAt: "2026-01-01T00:00:00.000Z",
        sourceLogicalTurnId: "logical-turn",
        upstreamResults: [sourceResult],
      },
    };

    const result = await executeTurn(input, [narrative, detached], deps);

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]).toMatchObject({
      runtimeId: detached.name,
      status: "success",
    });
    expect(result.deferredRuntimeJobs).toBeUndefined();
    expect(seen).toHaveBeenCalledWith("frozen text", {
      source: "stage",
      detached: true,
      payload: null,
    });
  });

  it("keeps a declared detached runtime foreground when another runtime consumes it", async () => {
    const producer = runtime("extractor", {
      capabilities: ["facts"],
      effects: { writes: ["plugin-data:self:facts"] },
      turnCompletion: { mode: "detached" },
    });
    const consumer = runtime("consumer", {
      needs: [{ capability: "facts" }],
    });
    const producerHandler = vi.fn(async () => ({
      outcome: "success",
      value: { facts: [] },
    }));
    const consumerHandler = vi.fn(async () => ({
      outcome: "success",
      value: { consumed: true },
    }));
    const deps = await testDeps(
      [producer, consumer],
      new Map([
        [producer.name, producerHandler],
        [consumer.name, consumerHandler],
      ]),
    );

    const result = await executeTurn(
      {
        sessionId: "session",
        turnId: "turn",
        playerMessage: "go",
        origin: "player",
      },
      [producer, consumer],
      deps,
    );

    expect(producerHandler).toHaveBeenCalledOnce();
    expect(consumerHandler).toHaveBeenCalledOnce();
    expect(result.deferredRuntimeJobs).toBeUndefined();
  });

  it("keeps runtimes with stateful effects in the foreground", async () => {
    const unsafe = runtime("stateful", {
      effects: { writes: ["state:*"] },
      turnCompletion: { mode: "detached" },
    });
    const handler = vi.fn(async () => ({
      outcome: "success",
      value: { ok: true },
    }));
    const deps = await testDeps([unsafe], new Map([[unsafe.name, handler]]));

    const result = await executeTurn(
      {
        sessionId: "session",
        turnId: "turn",
        playerMessage: "go",
        origin: "player",
      },
      [unsafe],
      deps,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.deferredRuntimeJobs).toBeUndefined();
  });

  it("keeps mutable plugin-data readers in the foreground", async () => {
    const unsafe = runtime("mutable-reader", {
      effects: {
        reads: ["plugin-data:self:tracks"],
        writes: ["plugin-data:self:tracks"],
      },
      turnCompletion: { mode: "detached" },
    });
    const handler = vi.fn(async () => ({
      outcome: "success",
      value: { ok: true },
    }));
    const deps = await testDeps([unsafe], new Map([[unsafe.name, handler]]));

    const result = await executeTurn(
      {
        sessionId: "session",
        turnId: "turn",
        playerMessage: "go",
        origin: "player",
      },
      [unsafe],
      deps,
    );

    expect(handler).toHaveBeenCalledOnce();
    expect(result.deferredRuntimeJobs).toBeUndefined();
  });
});
