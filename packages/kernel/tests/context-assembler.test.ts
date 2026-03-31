import { describe, it, expect } from "vitest";
import { assembleContext } from "../src/context/context-assembler.js";
import type { TurnState } from "../src/types.js";
import type { RuntimeTriggerEvent } from "@covel/shared";
import type { RegisteredRuntime } from "@covel/plugin-runtime";

const dummyEvent: RuntimeTriggerEvent = {
  eventId: "e1",
  type: "user.input",
  source: "player",
  timestamp: "2026-01-01T00:00:00Z",
};

const dummyRuntime: RegisteredRuntime = {
  pluginId: "test-plugin",
  spec: {
    id: "main",
    pluginId: "test-plugin",
    kind: "plugin",
    phase: "post_story",
    trigger: { mode: "always" },
    tools: ["test-plugin:query-tool"],
    hooks: [],
    budget: { maxSteps: 5 },
    providerBinding: "default",
  },
};

function emptyTurnState(): TurnState {
  return {
    state: {},
    events: [],
    records: new Map(),
    narrativeSegments: [],
    renderBlocks: [],
  };
}

describe("context-assembler", () => {
  it("assembles a complete RuntimeContextView", () => {
    const ctx = assembleContext({
      runId: "run-1",
      branchId: "branch-1",
      turnId: "turn-1",
      locale: "en-US",
      runtime: dummyRuntime,
      triggerEvent: dummyEvent,
      turnState: emptyTurnState(),
      worldState: { name: "Fantasy World" },
      characters: [{ name: "Hero" }],
    });

    expect(ctx.run.runId).toBe("run-1");
    expect(ctx.locale).toBe("en-US");
    expect(ctx.world).toEqual({ name: "Fantasy World" });
    expect(ctx.characters).toHaveLength(1);
    expect(ctx.runtime.runtimeId).toBe("main");
    expect(ctx.runtime.pluginId).toBe("test-plugin");
    expect(ctx.runtime.allowedTools).toEqual(["test-plugin:query-tool"]);
    expect(ctx.runtime.budget?.maxSteps).toBe(5);
    expect(ctx.runtime.providerBinding).toBe("default");
  });

  it("includes accumulated narrative from turn state", () => {
    const turnState = emptyTurnState();
    turnState.narrativeSegments.push("The hero entered. ");
    turnState.narrativeSegments.push("A dragon appeared.");

    const ctx = assembleContext({
      runId: "run-1",
      branchId: "branch-1",
      turnId: "turn-1",
      locale: "zh-CN",
      runtime: dummyRuntime,
      triggerEvent: dummyEvent,
      turnState,
    });

    expect(ctx.narrative?.content).toBe("The hero entered. A dragon appeared.");
  });

  it("includes trigger event in events", () => {
    const ctx = assembleContext({
      runId: "run-1",
      branchId: "branch-1",
      turnId: "turn-1",
      locale: "zh-CN",
      runtime: dummyRuntime,
      triggerEvent: dummyEvent,
      turnState: emptyTurnState(),
    });

    expect(ctx.events).toHaveLength(1);
    expect(ctx.events![0].type).toBe("user.input");
  });

  it("includes current state from turn state", () => {
    const turnState = emptyTurnState();
    turnState.state = { hp: 100, location: "cave" };

    const ctx = assembleContext({
      runId: "run-1",
      branchId: "branch-1",
      turnId: "turn-1",
      locale: "zh-CN",
      runtime: dummyRuntime,
      triggerEvent: dummyEvent,
      turnState,
    });

    expect(ctx.state).toEqual({ hp: 100, location: "cave" });
  });
});
