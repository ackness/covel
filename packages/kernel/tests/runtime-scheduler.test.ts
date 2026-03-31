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
  phase: "pre_story" | "story" | "post_story" | "background"
): CandidateRuntime {
  return {
    registered: {
      pluginId,
      spec: {
        id: runtimeId,
        pluginId,
        kind: "plugin",
        phase,
        trigger: { mode: "always" },
        tools: [],
        hooks: [],
      },
    },
    triggerEvent: dummyEvent,
  };
}

describe("runtime-scheduler", () => {
  it("groups runtimes by phase in correct order", () => {
    const candidates = [
      makeCandidate("p1", "bg", "background"),
      makeCandidate("p2", "pre", "pre_story"),
      makeCandidate("p3", "main", "story"),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(3);
    expect(plan.groups[0][0].phase).toBe("pre_story");
    expect(plan.groups[1][0].phase).toBe("story");
    expect(plan.groups[2][0].phase).toBe("background");
  });

  it("puts same-phase runtimes without deps in the same group", () => {
    const candidates = [
      makeCandidate("p1", "r1", "post_story"),
      makeCandidate("p2", "r2", "post_story"),
    ];

    const plan = buildExecutionPlan(candidates, new Map());

    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toHaveLength(2);
  });

  it("separates dependent runtimes into different layers", () => {
    const candidates = [
      makeCandidate("base", "r1", "post_story"),
      makeCandidate("dependent", "r2", "post_story"),
    ];

    const deps = new Map([["dependent", ["base"]]]);

    const plan = buildExecutionPlan(candidates, deps);

    expect(plan.groups.length).toBeGreaterThanOrEqual(2);
    // base should be in earlier group
    const baseGroup = plan.groups.find((g) =>
      g.some((s) => s.registered.pluginId === "base")
    )!;
    const depGroup = plan.groups.find((g) =>
      g.some((s) => s.registered.pluginId === "dependent")
    )!;
    expect(baseGroup[0].topoLayer).toBeLessThan(depGroup[0].topoLayer);
  });

  it("handles empty candidates", () => {
    const plan = buildExecutionPlan([], new Map());
    expect(plan.groups).toHaveLength(0);
  });

  it("handles multiple phases with dependencies", () => {
    const candidates = [
      makeCandidate("p1", "pre", "pre_story"),
      makeCandidate("p2", "main", "story"),
      makeCandidate("p3", "combat", "post_story"),
      makeCandidate("p4", "quest", "post_story"),
    ];

    const deps = new Map([["p4", ["p3"]]]);

    const plan = buildExecutionPlan(candidates, deps);

    // Should have: pre_story group, story group, post_story layer 0 (combat), post_story layer 1 (quest)
    expect(plan.groups.length).toBe(4);
  });
});
