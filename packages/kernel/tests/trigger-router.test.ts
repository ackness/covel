import { describe, it, expect } from "vitest";
import { routeTrigger } from "../src/router/trigger-router.js";
import type { KernelInput } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

function makeRuntime(
  overrides: Partial<RegisteredRuntime["spec"]> & { id: string; pluginId?: string }
): RegisteredRuntime {
  return {
    pluginId: overrides.pluginId ?? "test-plugin",
    spec: {
      id: overrides.id,
      pluginId: overrides.pluginId ?? "test-plugin",
      kind: "plugin",
      phase: "post_story",
      trigger: { mode: "always" },
      tools: [],
      hooks: [],
      ...overrides,
    },
  };
}

const baseInput: KernelInput = {
  runId: "run-1",
  branchId: "branch-1",
  actorId: "player-1",
  type: "user.input",
  payload: { text: "hello" },
};

describe("trigger-router", () => {
  it("includes 'always' mode runtimes", () => {
    const runtimes = [makeRuntime({ id: "main", trigger: { mode: "always" } })];
    const { candidates } = routeTrigger(baseInput, runtimes);
    expect(candidates).toHaveLength(1);
  });

  it("includes 'event' mode when event type matches", () => {
    const runtimes = [
      makeRuntime({
        id: "evt",
        trigger: { mode: "event", onEvents: ["user.input"] },
      }),
    ];
    const { candidates } = routeTrigger(baseInput, runtimes);
    expect(candidates).toHaveLength(1);
  });

  it("excludes 'event' mode when type does not match", () => {
    const runtimes = [
      makeRuntime({
        id: "evt",
        trigger: { mode: "event", onEvents: ["system.event"] },
      }),
    ];
    const { candidates } = routeTrigger(baseInput, runtimes);
    expect(candidates).toHaveLength(0);
  });

  it("includes 'manual' mode only for targeted runtimes", () => {
    const runtimes = [makeRuntime({ id: "m", trigger: { mode: "manual" } })];

    // Not triggered by regular input
    const { candidates: c1 } = routeTrigger(baseInput, runtimes);
    expect(c1).toHaveLength(0);

    // Triggered by explicit target
    const manualInput: KernelInput = {
      ...baseInput,
      type: "system.event",
      payload: { targetRuntimeId: "test-plugin:m" },
    };
    const { candidates: c2 } = routeTrigger(manualInput, runtimes);
    expect(c2).toHaveLength(1);
  });

  it("always includes 'interval' mode", () => {
    const runtimes = [
      makeRuntime({
        id: "int",
        trigger: { mode: "interval", intervalTurns: 3 },
      }),
    ];
    const { candidates } = routeTrigger(baseInput, runtimes);
    expect(candidates).toHaveLength(1);
  });

  it("generates a trigger event with correct metadata", () => {
    const runtimes = [makeRuntime({ id: "main" })];
    const { triggerEvent } = routeTrigger(baseInput, runtimes);

    expect(triggerEvent.type).toBe("user.input");
    expect(triggerEvent.source).toBe("player-1");
    expect(triggerEvent.eventId).toBeTruthy();
    expect(triggerEvent.timestamp).toBeTruthy();
  });
});
