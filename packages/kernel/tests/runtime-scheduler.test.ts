import { describe, it, expect } from "vitest";
import { buildExecutionPlan } from "../src/scheduler/runtime-scheduler.js";
import type { CandidateRuntime } from "../src/types.js";
import type { RegisteredRuntime } from "@covel/plugin-runtime";
import type { RuntimeTriggerEvent } from "@covel/shared";

const dummyEvent: RuntimeTriggerEvent = {
  eventId: "e1",
  type: "user.input",
  source: "player",
  timestamp: "2026-01-01T00:00:00Z",
};

function makeCandidate(
  pluginId: string,
  runtimeId: string,
  priority?: number
): CandidateRuntime {
  return {
    registered: {
      pluginId,
      spec: {
        id: runtimeId,
        pluginId,
        kind: "plugin",
        trigger: { mode: "always" },
        tools: [],
        hooks: [],
        priority,
      },
    },
    triggerEvent: dummyEvent,
  };
}

describe("runtime-scheduler", () => {
  it("sorts runtimes by priority ascending (lower priority number runs first)", () => {
    const candidates = [
      makeCandidate("p1", "low", 900),
      makeCandidate("p2", "high", 100),
      makeCandidate("p3", "mid", 500),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(3);
    expect(plan.groups[0][0].priority).toBe(100);
    expect(plan.groups[1][0].priority).toBe(500);
    expect(plan.groups[2][0].priority).toBe(900);
  });

  it("groups same-priority runtimes into the same parallel group", () => {
    const candidates = [
      makeCandidate("p1", "r1", 300),
      makeCandidate("p2", "r2", 300),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toHaveLength(2);
    expect(plan.groups[0][0].priority).toBe(300);
    expect(plan.groups[0][1].priority).toBe(300);
  });

  it("creates separate groups for different priorities", () => {
    const candidates = [
      makeCandidate("p1", "r1", 100),
      makeCandidate("p2", "r2", 200),
      makeCandidate("p3", "r3", 300),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(3);
    expect(plan.groups[0]).toHaveLength(1);
    expect(plan.groups[1]).toHaveLength(1);
    expect(plan.groups[2]).toHaveLength(1);
  });

  it("defaults to priority 500 when not specified", () => {
    const candidates = [
      makeCandidate("p1", "r1"), // no priority => 500
      makeCandidate("p2", "r2", 100),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(2);
    expect(plan.groups[0][0].priority).toBe(100);
    expect(plan.groups[1][0].priority).toBe(500);
  });

  it("splits same-priority dependent runtimes into sub-groups", () => {
    const candidates = [
      makeCandidate("base", "r1", 500),
      makeCandidate("dependent", "r2", 500),
    ];

    const deps = new Map([["dependent", ["base"]]]);

    const plan = buildExecutionPlan(candidates, deps);

    expect(plan.groups.length).toBeGreaterThanOrEqual(2);
    // base should be in earlier group
    const baseGroupIdx = plan.groups.findIndex((g) =>
      g.some((s) => s.registered.pluginId === "base")
    );
    const depGroupIdx = plan.groups.findIndex((g) =>
      g.some((s) => s.registered.pluginId === "dependent")
    );
    expect(baseGroupIdx).toBeLessThan(depGroupIdx);
  });

  it("handles empty candidates", () => {
    const plan = buildExecutionPlan([], new Map());
    expect(plan.groups).toHaveLength(0);
  });

  it("handles mixed priorities with dependencies", () => {
    const candidates = [
      makeCandidate("p1", "pre", 100),
      makeCandidate("p2", "main", 200),
      makeCandidate("p3", "combat", 500),
      makeCandidate("p4", "quest", 500),
    ];

    const deps = new Map([["p4", ["p3"]]]);

    const plan = buildExecutionPlan(candidates, deps);

    // Should have: priority 100, priority 200, priority 500 layer 0 (combat), priority 500 layer 1 (quest)
    expect(plan.groups.length).toBe(4);
  });
});
