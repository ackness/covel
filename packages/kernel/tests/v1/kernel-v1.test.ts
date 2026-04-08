import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createPluginManager } from "@covel/plugin-manager";
import { createApprovalService } from "@covel/services";
import { routeTriggerV1 } from "../../src/v1/trigger-router-v1.js";
import { buildV1ExecutionPlan } from "../../src/v1/scheduler-v1.js";
import { createV1KernelSession } from "../../src/v1/kernel-session-v1.js";
import type { V1SessionState, V1TriggerInput } from "../../src/v1/types.js";
import type { LoadedRuntime, RuntimeManifest, RuntimeTrigger } from "@covel/plugin-manager";

const PLUGIN_DEMO_DIR = resolve(import.meta.dirname, "../../../../docs/plugin-system-v1/plugin-demo");
const IMAGE_DEMO_DIR = resolve(import.meta.dirname, "../../../../docs/plugin-system-v1/image-workflow-demo");

function makeRuntime(
  pluginId: string,
  id: string,
  priority: number,
  triggerType: RuntimeTrigger["type"],
  overrides?: Partial<RuntimeManifest>,
): LoadedRuntime {
  return {
    manifest: {
      id,
      displayName: { "en-US": id },
      priority,
      trigger: { type: triggerType },
      ...overrides,
    },
    dir: "/tmp",
    pluginId,
    toolFiles: [],
    scriptFiles: [],
    referenceFiles: [],
  };
}

function makeSessionState(overrides?: Partial<V1SessionState>): V1SessionState {
  return {
    sessionId: "test-session",
    turnNumber: 0,
    isPreGame: false,
    preGameCompleted: new Set(),
    runCounts: new Map(),
    eventQueue: [],
    records: [],
    ...overrides,
  };
}

describe("V1 TriggerRouter", () => {
  it("should route turn trigger to turn runtimes", () => {
    const runtimes = [
      makeRuntime("p1", "narrator", 500, "turn"),
      makeRuntime("p1", "schema-builder", 30, "pre-game-once"),
    ];
    const input: V1TriggerInput = { type: "turn", sessionId: "s1", turnId: "t1" };
    const candidates = routeTriggerV1(input, runtimes, makeSessionState());
    expect(candidates).toHaveLength(1);
    expect(candidates[0].runtime.manifest.id).toBe("narrator");
  });

  it("should route pre-game trigger to pre-game-once runtimes", () => {
    const runtimes = [
      makeRuntime("p1", "narrator", 500, "turn"),
      makeRuntime("p1", "schema-builder", 30, "pre-game-once"),
    ];
    const input: V1TriggerInput = { type: "pre-game", sessionId: "s1", turnId: "t0" };
    const candidates = routeTriggerV1(input, runtimes, makeSessionState({ isPreGame: true }));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].runtime.manifest.id).toBe("schema-builder");
  });

  it("should not re-run pre-game-once runtimes", () => {
    const runtimes = [makeRuntime("p1", "schema-builder", 30, "pre-game-once")];
    const input: V1TriggerInput = { type: "pre-game", sessionId: "s1", turnId: "t0" };
    const state = makeSessionState({
      isPreGame: true,
      preGameCompleted: new Set(["p1:schema-builder"]),
    });
    const candidates = routeTriggerV1(input, runtimes, state);
    expect(candidates).toHaveLength(0);
  });

  it("should respect maxRunsPerTurn", () => {
    const runtimes = [
      makeRuntime("p1", "rt1", 500, "turn", { limits: { maxRunsPerTurn: 1 } }),
    ];
    const input: V1TriggerInput = { type: "turn", sessionId: "s1", turnId: "t1" };
    const state = makeSessionState();
    state.runCounts.set("p1:rt1", { session: 0, turn: 1 });
    const candidates = routeTriggerV1(input, runtimes, state);
    expect(candidates).toHaveLength(0);
  });

  it("should match event-triggered runtimes", () => {
    const runtimes = [
      makeRuntime("p1", "quest-handler", 500, "event", {
        trigger: { type: "event", events: ["quest.completed"] },
      }),
    ];
    const input: V1TriggerInput = {
      type: "event", sessionId: "s1", turnId: "t1",
      eventType: "quest.completed",
    };
    const candidates = routeTriggerV1(input, runtimes, makeSessionState());
    expect(candidates).toHaveLength(1);
  });

  it("should match manual trigger with action", () => {
    const runtimes = [
      makeRuntime("p1", "img-gen", 710, "manual", {
        trigger: { type: "manual", action: "generate-image" },
      }),
    ];
    const input: V1TriggerInput = {
      type: "manual", sessionId: "s1", turnId: "t1",
      actionId: "generate-image",
    };
    const candidates = routeTriggerV1(input, runtimes, makeSessionState());
    expect(candidates).toHaveLength(1);
  });
});

describe("V1 Scheduler", () => {
  it("should group by priority ascending", () => {
    const candidates = [
      { runtime: makeRuntime("p1", "a", 500, "turn"), triggerInput: {} as V1TriggerInput },
      { runtime: makeRuntime("p1", "b", 300, "turn"), triggerInput: {} as V1TriggerInput },
      { runtime: makeRuntime("p1", "c", 500, "turn"), triggerInput: {} as V1TriggerInput },
      { runtime: makeRuntime("p1", "d", 100, "turn"), triggerInput: {} as V1TriggerInput },
    ];
    const plan = buildV1ExecutionPlan(candidates);
    expect(plan.groups).toHaveLength(3);
    expect(plan.groups[0].priority).toBe(100);
    expect(plan.groups[1].priority).toBe(300);
    expect(plan.groups[2].priority).toBe(500);
    // Same priority = parallel group
    expect(plan.groups[2].runtimes).toHaveLength(2);
  });

  it("should handle empty candidates", () => {
    const plan = buildV1ExecutionPlan([]);
    expect(plan.groups).toHaveLength(0);
  });
});

describe("V1 KernelSession", () => {
  it("should execute pre-game turn", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);

    const session = createV1KernelSession({ pluginManager: mgr }, "test-session");
    // luck-roller has priority 620, trigger: turn — won't fire in pre-game
    // No pre-game-once runtimes in demo-plugin
    const result = await session.executeTurn({
      type: "pre-game",
      sessionId: "test-session",
      turnId: "t0",
    });
    expect(result.records).toHaveLength(0);
  });

  it("should execute a normal turn", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);

    const session = createV1KernelSession({ pluginManager: mgr }, "test-session");
    // Mark pre-game as done
    (session.state as any).isPreGame = false;

    const result = await session.executeTurn({
      type: "turn",
      sessionId: "test-session",
      turnId: "t1",
    });
    // luck-roller should fire (priority 620, trigger: turn)
    expect(result.records).toHaveLength(1);
    expect(result.records[0].runtimeId).toBe("luck-roller");
  });

  it("should execute workflow with serial steps", async () => {
    const mgr = createPluginManager();
    await mgr.load(IMAGE_DEMO_DIR);

    const session = createV1KernelSession({ pluginManager: mgr }, "test-session");
    (session.state as any).isPreGame = false;

    const workflow = await session.executeAction(
      "image-workflow-demo",
      "generate-story-image",
      { prompt: "A dark forest" },
    );

    expect(workflow.status).toBe("completed");
    expect(workflow.steps).toHaveLength(2);
    expect(workflow.steps[0].runtimeId).toBe("prompt-optimizer");
    expect(workflow.steps[0].status).toBe("completed");
    expect(workflow.steps[1].runtimeId).toBe("image-generator");
    expect(workflow.steps[1].status).toBe("completed");
    expect(workflow.progressLabel).toBe("完成");
  });

  it("should fail workflow on step failure", async () => {
    const mgr = createPluginManager();
    await mgr.load(IMAGE_DEMO_DIR);

    // Use a custom executor that fails on image-generator
    const session = createV1KernelSession({
      pluginManager: mgr,
      executeRuntime: async (runtime) => {
        if (runtime.manifest.id === "image-generator") {
          throw new Error("Image generation failed");
        }
        const { successResult, wrapAsPublishedRecord } = await import("@covel/runtime-context");
        const result = successResult({ ok: true });
        return {
          pluginId: runtime.pluginId,
          runtimeId: runtime.manifest.id,
          status: result.status,
          payload: result.payload,
          record: wrapAsPublishedRecord(result, {
            pluginId: runtime.pluginId,
            runtimeId: runtime.manifest.id,
            sessionId: "test-session",
            turnId: "t1",
            runId: "r1",
            traceId: "tr1",
            locale: "zh-CN",
          }),
        };
      },
    }, "test-session");
    (session.state as any).isPreGame = false;

    const workflow = await session.executeAction(
      "image-workflow-demo",
      "generate-story-image",
    );

    expect(workflow.status).toBe("failed");
    expect(workflow.failedAtStep).toBe("image-generator");
    expect(workflow.steps[0].status).toBe("completed");
    expect(workflow.steps[1].status).toBe("failed");
    expect(workflow.progressLabel).toBe("失败");
  });

  it("should pass previous step status to downstream runtimes", async () => {
    const mgr = createPluginManager();
    await mgr.load(IMAGE_DEMO_DIR);

    const seenPayloads: unknown[] = [];
    const session = createV1KernelSession({
      pluginManager: mgr,
      executeRuntime: async (runtime, input) => {
        seenPayloads.push(input.payload);
        const { successResult, wrapAsPublishedRecord } = await import("@covel/runtime-context");
        const result = successResult({ ok: true });
        return {
          pluginId: runtime.pluginId,
          runtimeId: runtime.manifest.id,
          status: result.status,
          payload: result.payload,
          record: wrapAsPublishedRecord(result, {
            pluginId: runtime.pluginId,
            runtimeId: runtime.manifest.id,
            sessionId: "test-session",
            turnId: "t1",
            runId: "r1",
            traceId: "tr1",
            locale: "zh-CN",
          }),
        };
      },
    }, "test-session");
    (session.state as any).isPreGame = false;

    await session.executeAction("image-workflow-demo", "generate-story-image", {
      messageId: "m1",
    });

    expect(seenPayloads[1]).toEqual({
      previousStep: {
        runtimeId: "prompt-optimizer",
        status: "success",
        payload: { ok: true },
      },
    });
  });

  it("should grant approval from encoded interaction ids", async () => {
    const mgr = createPluginManager();
    await mgr.load(PLUGIN_DEMO_DIR);

    const approvals = createApprovalService();
    const session = createV1KernelSession({
      pluginManager: mgr,
      approvalService: approvals,
    }, "test-session");

    await session.handleApprovalCallback(
      "approval:test-session:demo-plugin:kernel.write_table",
      "approved",
    );

    const decision = await approvals.check({
      sessionId: "test-session",
      pluginId: "demo-plugin",
      toolId: "kernel.write_table",
    });
    expect(decision.allowed).toBe(true);
  });
});
