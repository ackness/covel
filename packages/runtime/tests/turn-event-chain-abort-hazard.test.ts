/**
 * Regression tests for `runEventChain` mid-chain abort propagation and
 * same-layer effects hazard policy (`COVEL_EFFECTS_POLICY`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import type {
  JsonValue,
  LLMAdapter,
  LLMResponse,
  RuntimeManifest,
  RuntimeResult,
  SchedulingDiagnostic,
  SubscriptionEvent,
} from "@covel/shared";
import { runEventChain } from "../src/trigger/turn-event-chain.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { PLAYER_ABORT_REASON } from "../src/turn-executor/turn-control.js";

const originalEffectsPolicy = process.env.COVEL_EFFECTS_POLICY;

afterEach(() => {
  if (originalEffectsPolicy === undefined) {
    delete process.env.COVEL_EFFECTS_POLICY;
  } else {
    process.env.COVEL_EFFECTS_POLICY = originalEffectsPolicy;
  }
  vi.restoreAllMocks();
});

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

function resultEmitting(
  runtimeId: string,
  topic: string,
  data: Record<string, JsonValue> = {},
): RuntimeResult {
  return {
    pluginId: runtimeId.split("/")[0]!,
    runtimeId,
    runId: `run-${runtimeId}`,
    turnId: "turn-1",
    status: "success",
    output: {},
    effects: { events: [{ topic, data }] },
    toolCalls: [],
    durationMs: 0,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function eventRuntime(
  name: string,
  topic: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    runtimeType: "function",
    handler: "./handler.js",
    trigger: { type: "event", topic },
    ...overrides,
  };
}

async function playingStore(sessionId: string) {
  const store = createMemoryStore();
  const now = "2026-01-01T00:00:00.000Z";
  await store.createSession({
    id: sessionId,
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: [],
    completedPlayerTurns: 1,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

describe("runEventChain mid-chain abort", () => {
  it("halts depth-2 sync and background followers when aborted during depth 1", async () => {
    let aborted = false;
    const depth1 = eventRuntime("d1/relay", "topic-a");
    const depth2Sync = eventRuntime("d2/sync", "topic-b");
    const depth2Bg = eventRuntime("d2/bg", "topic-b", {
      execution: "background",
    });

    const ran: string[] = [];
    const completedResults = new Map<string, RuntimeResult>([
      ["seed/emitter", resultEmitting("seed/emitter", "topic-a")],
    ]);

    const deferred = await runEventChain({
      activeRuntimes: [depth1, depth2Sync, depth2Bg],
      completedResults,
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        if (manifest.name === depth1.name) {
          aborted = true;
          return resultEmitting(manifest.name, "topic-b");
        }
        return resultEmitting(manifest.name, "noop");
      },
      sessionId: "sess-1",
      turnId: "turn-1",
      turnNumber: 1,
      logicalTurn: 1,
      setupRuntimes: {},
      isAborted: () => aborted,
    });

    expect(ran).toEqual(["d1/relay"]);
    expect(deferred).toEqual([]);
    expect(completedResults.has("d2/sync")).toBe(false);
  });

  it("halts later DAG groups within the same fan-out depth when aborted mid-depth", async () => {
    let aborted = false;
    const first = eventRuntime("d1/first", "topic-a");
    const second = eventRuntime("d1/second", "topic-a", {
      needs: [first.name],
    });

    const ran: string[] = [];
    const completedResults = new Map<string, RuntimeResult>([
      ["seed/emitter", resultEmitting("seed/emitter", "topic-a")],
    ]);

    await runEventChain({
      activeRuntimes: [first, second],
      completedResults,
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        if (manifest.name === first.name) aborted = true;
        return resultEmitting(manifest.name, "noop");
      },
      sessionId: "sess-1",
      turnId: "turn-1",
      turnNumber: 1,
      logicalTurn: 1,
      setupRuntimes: {},
      isAborted: () => aborted,
    });

    expect(ran).toEqual(["d1/first"]);
    expect(completedResults.has("d1/second")).toBe(false);
  });

  it("wires executionAborted through runTurnPipeline so player abort mid-chain stops depth-2 followers", async () => {
    const controller = new AbortController();
    const emitterRuntime: RuntimeManifest = {
      name: "seed/emitter",
      pluginId: "seed",
      description: "emitter",
      stage: "post-turn",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto" },
    };
    // Two parallel depth-1 followers: one succeeds and emits topic-b, while
    // its sibling aborts the execution before depth 2 can start.
    const depth1Emitter = eventRuntime("d1/emitter", "topic-a");
    const depth1Aborter = eventRuntime("d1/aborter", "topic-a");
    const depth2 = eventRuntime("d2/sink", "topic-b");

    const ran: string[] = [];
    let releaseAbort!: () => void;
    const emitterDone = new Promise<void>((resolve) => {
      releaseAbort = resolve;
    });
    const store = await playingStore("sess-abort-chain");

    const result = await runTurnPipeline(
      {
        origin: "player",
        sessionId: "sess-abort-chain",
        turnId: "turn-1",
        playerMessage: "go",
      },
      [emitterRuntime, depth1Emitter, depth1Aborter, depth2],
      {
        store,
        llm: new NoopLLM(),
        turnControl: { signal: controller.signal },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => {
            ran.push(manifest.name);
            if (manifest.name === emitterRuntime.name) {
              return {
                outcome: "success",
                value: {},
                effects: { events: [{ topic: "topic-a", data: {} }] },
              };
            }
            if (manifest.name === depth1Emitter.name) {
              // Yield so releaseAbort runs after our success result settles.
              setImmediate(releaseAbort);
              return {
                outcome: "success",
                value: {},
                effects: { events: [{ topic: "topic-b", data: {} }] },
              };
            }
            if (manifest.name === depth1Aborter.name) {
              await emitterDone;
              controller.abort();
              return { outcome: "success", value: {} };
            }
            return { outcome: "success", value: {} };
          },
        }),
      },
    );

    expect(
      result.runtimeResults.find((r) => r.runtimeId === "d1/emitter")?.status,
    ).toBe("success");
    expect(ran).not.toContain("d2/sink");
    expect(result.abortReason).toBe(PLAYER_ABORT_REASON);
    expect(result.runtimeResults.map((r) => r.runtimeId)).not.toContain(
      "d2/sink",
    );
  });
});

describe("runEventChain effects hazard policy", () => {
  it("serializes conflicting same-layer event followers under COVEL_EFFECTS_POLICY=strict", async () => {
    process.env.COVEL_EFFECTS_POLICY = "strict";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const followerA = eventRuntime("a/follower", "topic-x", {
      effects: { writes: ["media:*"] },
    });
    const followerB = eventRuntime("b/follower", "topic-x", {
      effects: { writes: ["media:*"] },
    });

    const timeline: string[] = [];
    const diagnostics: SchedulingDiagnostic[] = [];
    const completedResults = new Map<string, RuntimeResult>([
      ["seed/emitter", resultEmitting("seed/emitter", "topic-x")],
    ]);

    await runEventChain({
      activeRuntimes: [followerB, followerA],
      completedResults,
      executeRuntime: async (manifest) => {
        timeline.push(`start:${manifest.name}`);
        await new Promise((resolve) => setImmediate(resolve));
        timeline.push(`end:${manifest.name}`);
        return resultEmitting(manifest.name, "noop");
      },
      sessionId: "sess-1",
      turnId: "turn-1",
      turnNumber: 1,
      logicalTurn: 1,
      setupRuntimes: {},
      onHazardDiagnostics: (items) => diagnostics.push(...items),
    });

    // Strict mode splits conflicting same-layer followers into serial sub-levels.
    expect(timeline).toEqual([
      "start:a/follower",
      "end:a/follower",
      "start:b/follower",
      "end:b/follower",
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "effects-hazard",
        data: { a: "a/follower", b: "b/follower", policy: "strict" },
      }),
    ]);
  });

  it("emits scheduling.hazard through runTurnPipeline and serializes conflicting followers under strict policy", async () => {
    process.env.COVEL_EFFECTS_POLICY = "strict";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const emitterRuntime: RuntimeManifest = {
      name: "seed/emitter",
      pluginId: "seed",
      description: "emitter",
      stage: "post-turn",
      runtimeType: "function",
      handler: "./handler.js",
      trigger: { type: "auto" },
    };
    const followerA = eventRuntime("a/follower", "topic-x", {
      effects: { writes: ["media:*"] },
    });
    const followerB = eventRuntime("b/follower", "topic-x", {
      effects: { writes: ["media:*"] },
    });

    const timeline: string[] = [];
    const eventBus = createEventBus();
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((event) => events.push(event));
    const store = await playingStore("sess-strict-chain");

    const result = await runTurnPipeline(
      {
        origin: "player",
        sessionId: "sess-strict-chain",
        turnId: "turn-1",
        playerMessage: "go",
      },
      [emitterRuntime, followerB, followerA],
      {
        store,
        llm: new NoopLLM(),
        eventBus,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => {
            if (manifest.name === emitterRuntime.name) {
              return {
                outcome: "success",
                value: {},
                effects: { events: [{ topic: "topic-x", data: {} }] },
              };
            }
            timeline.push(`start:${manifest.name}`);
            await new Promise((resolve) => setImmediate(resolve));
            timeline.push(`end:${manifest.name}`);
            return { outcome: "success", value: {} };
          },
        }),
      },
    );

    expect(timeline).toEqual([
      "start:a/follower",
      "end:a/follower",
      "start:b/follower",
      "end:b/follower",
    ]);
    expect(result.runtimeResults.map((r) => r.runtimeId).sort()).toEqual([
      "a/follower",
      "b/follower",
      "seed/emitter",
    ]);
    const hazards = events
      .filter((event) => event.type === "scheduling.hazard")
      .map((event) => event.payload);
    expect(hazards).toContainEqual(
      expect.objectContaining({
        code: "effects-hazard",
        data: { a: "a/follower", b: "b/follower", policy: "strict" },
      }),
    );
  });
});
