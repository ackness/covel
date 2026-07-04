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
  priority: 100,
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
