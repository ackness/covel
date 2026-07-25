/**
 * Unit test for `runEventChain`'s deferred-follower dedup: a background runtime
 * runs off the turn's critical path and never enters `completedResults`, so the
 * chain-local "already ran" dedup can't catch it. If the same topic is re-emitted
 * across fan-out depths, the same background runtime must still be deferred only
 * once (see packages/runtime/src/trigger/turn-event-chain.ts).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { runEventChain } from "../src/trigger/turn-event-chain.js";

afterEach(() => vi.restoreAllMocks());

function resultEmitting(
  runtimeId: string,
  topic: string,
  data: Record<string, unknown>,
): RuntimeResult {
  return {
    pluginId: runtimeId.split("/")[0]!,
    runtimeId,
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    output: { events: [{ topic, data }] },
    toolCalls: [],
    durationMs: 0,
    timestamp: "2024-01-01T00:00:00Z",
  };
}

const backgroundFollower = {
  name: "gen/background",
  pluginId: "gen",
  description: "background follower of topic-x",
  execution: "background",
  runtimeType: "function",
  trigger: { type: "event", topic: "topic-x" },
} as RuntimeManifest;

// A sync follower that re-emits topic-x with a fresh payload, forcing a second
// fan-out depth that re-surfaces topic-x to the background follower.
const relay = {
  name: "relay/main",
  pluginId: "relay",
  description: "re-emits topic-x once",
  stage: "pre-turn",
  runtimeType: "function",
  trigger: { type: "event", topic: "topic-x" },
} as RuntimeManifest;

describe("runEventChain deferred-follower dedup", () => {
  it("defers a background runtime at most once when its topic re-emits across depths", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const completedResults = new Map<string, RuntimeResult>();
    // Depth-0 seed: something emitted topic-x before the chain ran.
    completedResults.set(
      "seed/emitter",
      resultEmitting("seed/emitter", "topic-x", { n: 0 }),
    );

    const deferred = await runEventChain({
      activeRuntimes: [backgroundFollower, relay],
      completedResults,
      executeRuntime: async (manifest) =>
        manifest.name === "relay/main"
          ? resultEmitting("relay/main", "topic-x", { n: 1 })
          : resultEmitting(manifest.name, "noop", {}),
      sessionId: "sess-1",
      turnNumber: 1,
    });

    // Without the dedup guard the background follower is deferred at both
    // depth 1 and depth 2 — with it, exactly one job survives.
    expect(deferred).toHaveLength(1);
    expect(deferred[0]?.runtimeId).toBe("gen/background");

    // The duplicate defer is logged, not silently swallowed.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("gen/background");
  });
});

describe("runEventChain honours event-runtime throttling", () => {
  // Fan-out is the ONLY place an `event` runtime can trigger — the main
  // scheduler evaluates it with an empty topic list, so its topic match always
  // fails there. Feeding hardcoded "never triggered" history into fan-out
  // therefore made maxTriggerCount / cooldownTurns dead for event runtimes
  // everywhere: a once-only follower re-fired on every matching emission.
  const onceOnly = {
    name: "once/follower",
    pluginId: "once",
    description: "fires at most once per session",
    runtimeType: "function",
    trigger: { type: "event", topic: "topic-x", maxTriggerCount: 1 },
  } as RuntimeManifest;

  const cooling = {
    name: "cool/follower",
    pluginId: "cool",
    description: "cools down for 5 turns",
    runtimeType: "function",
    trigger: { type: "event", topic: "topic-x", cooldownTurns: 5 },
  } as RuntimeManifest;

  function seed(): Map<string, RuntimeResult> {
    const completedResults = new Map<string, RuntimeResult>();
    completedResults.set(
      "seed/emitter",
      resultEmitting("seed/emitter", "topic-x", { n: 0 }),
    );
    return completedResults;
  }

  it("skips a follower that already hit maxTriggerCount", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [onceOnly],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 3,
      runtimeTriggerCounts: new Map([["once/follower", 1]]),
    });
    expect(ran).toEqual([]);
  });

  it("runs that follower when it has never triggered", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [onceOnly],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 3,
      runtimeTriggerCounts: new Map([["once/follower", 0]]),
    });
    expect(ran).toEqual(["once/follower"]);
  });

  it("skips a follower still inside its cooldown window", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [cooling],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 3,
      runtimeTurnsSinceLastTrigger: new Map([["cool/follower", 2]]),
    });
    expect(ran).toEqual([]);
  });

  it("runs it again once the cooldown has elapsed", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [cooling],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 9,
      runtimeTurnsSinceLastTrigger: new Map([["cool/follower", 6]]),
    });
    expect(ran).toEqual(["cool/follower"]);
  });

  // Fan-out is intentionally cross-band (a reaction, not a scheduled slot), so
  // `preGameCompleted` is the only thing keeping a finished setup runtime from
  // being resurrected by a later emission of its topic. Passing a hardcoded
  // empty set here made that gate dead.
  const preGameFollower = {
    name: "setup/follower",
    pluginId: "setup",
    description: "Pre-Game follower that reports done once",
    stage: "setup",
    runtimeType: "function",
    trigger: { type: "event", topic: "topic-x" },
  } as RuntimeManifest;

  it("skips a Pre-Game follower the session already marked done", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [preGameFollower],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 4,
      preGameCompleted: ["setup/follower"],
    });
    expect(ran).toEqual([]);
  });

  it("still runs it while Pre-Game has not reported it done", async () => {
    const ran: string[] = [];
    await runEventChain({
      activeRuntimes: [preGameFollower],
      completedResults: seed(),
      executeRuntime: async (manifest) => {
        ran.push(manifest.name);
        return resultEmitting(manifest.name, "noop", {});
      },
      sessionId: "sess-1",
      turnNumber: 0,
      preGameCompleted: [],
    });
    expect(ran).toEqual(["setup/follower"]);
  });
});
