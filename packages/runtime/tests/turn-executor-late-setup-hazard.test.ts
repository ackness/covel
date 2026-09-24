/**
 * Late-setup channel regression tests (audit A2):
 *
 *  - the playing-band late-setup pass must apply the same-layer effects hazard
 *    policy (diagnostics under `warn`, serial sub-levels under `strict`) just
 *    like the main groups;
 *  - a setup runtime declaring `turnCompletion: detached` is NOT silently run
 *    in the foreground: the channel has no deferred-job path, so it emits a
 *    `detached-setup-runtime-foreground` diagnostic while still running it.
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, SubscriptionEvent } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import { createEventBus, type EventBus } from "@covel/events";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/ll-adapter.js";

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

async function playingStore(sessionId: string) {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    worldId: "w",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    // Empty mirror → the setup runtimes below are pending (late-setup band).
    setupRuntimes: {},
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
  return store;
}

function setupRuntime(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    stage: "setup",
    runtimeType: "function",
    handler: "./handler.js",
    outputKind: "plugin",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

function makeDeps(
  handlers: Map<string, (ctx: unknown) => Promise<Record<string, unknown>>>,
  eventBus: EventBus,
  store: ReturnType<typeof createMemoryStore>,
): TurnExecutorDeps {
  return {
    store,
    llm: new NoopLLM(),
    eventBus,
    loadRuntime: async (manifest) => ({
      manifest,
      promptTemplate: "",
      handler: handlers.get(manifest.name),
    }),
  };
}

function hazardEvents(events: readonly SubscriptionEvent[]): unknown[] {
  return events
    .filter((e) => e.type === "scheduling.hazard")
    .map((e) => e.payload);
}

describe("late-setup hazard policy and detachment diagnostics", () => {
  it("runs a same-layer effects conflict through the hazard policy", async () => {
    const store = await playingStore("s");
    const eventBus = createEventBus();
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    // Two pending setup runtimes writing the same resource with no declared
    // edge → same DAG layer → effects hazard under the default `warn` policy.
    const a = setupRuntime("p/setup-a", {
      effects: { writes: ["media:*"] },
    });
    const b = setupRuntime("p/setup-b", {
      effects: { writes: ["media:*"] },
    });
    const invoked: string[] = [];
    const handlers = new Map(
      [a, b].map((m) => [
        m.name,
        async () => {
          invoked.push(m.name);
          return { outcome: "success", value: {} };
        },
      ]),
    );
    const result = await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      [a, b],
      makeDeps(handlers, eventBus, store),
    );

    // `warn` keeps the group parallel and only diagnoses.
    expect(invoked.sort()).toEqual(["p/setup-a", "p/setup-b"]);
    const hazards = hazardEvents(events).filter(
      (payload) => (payload as { code?: string }).code === "effects-hazard",
    );
    expect(hazards).toHaveLength(1);
    expect(hazards[0]).toMatchObject({
      code: "effects-hazard",
      data: { a: "p/setup-a", b: "p/setup-b", policy: "warn" },
    });
    expect(result.runtimeResults.map((r) => r.runtimeId).sort()).toEqual([
      "p/setup-a",
      "p/setup-b",
    ]);
  });

  it("diagnoses a detachment-eligible setup runtime instead of silently running it in the foreground", async () => {
    const store = await playingStore("s");
    const eventBus = createEventBus();
    const events: SubscriptionEvent[] = [];
    eventBus.onEmit((e) => events.push(e));

    // planTurnDetachment is stage-agnostic: this setup runtime satisfies the
    // detached contract (function runtime, explicit safe effects, no events /
    // recordAs / plugin-data inject, no foreground consumer) and would be
    // marked eligible. The late-setup channel has no deferred-job path, so it
    // must run in the foreground WITH a diagnostic.
    const detachedSetup = setupRuntime("p/setup-detached", {
      effects: { writes: ["media:*"] },
      turnCompletion: { mode: "detached", maxQueueMs: 30_000 },
    });
    const handler = vi.fn(async () => ({ outcome: "success", value: {} }));
    const handlers = new Map([[detachedSetup.name, handler]]);

    const result = await executeTurn(
      { sessionId: "s", turnId: "t", playerMessage: "go" },
      [detachedSetup],
      makeDeps(handlers, eventBus, store),
    );

    expect(handler).toHaveBeenCalledTimes(1);
    // No deferred job is enqueued for the late-setup channel.
    expect(result.deferredRuntimeJobs ?? []).toHaveLength(0);
    const diagnostics = hazardEvents(events).filter(
      (payload) =>
        (payload as { code?: string }).code ===
        "detached-setup-runtime-foreground",
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      code: "detached-setup-runtime-foreground",
      data: { runtimeId: "p/setup-detached" },
    });
  });
});
