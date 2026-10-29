import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import { AiProviderError } from "@covel/ai-provider";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { z } from "zod";
import { tool } from "@covel/tools";
import type { ToolCallContext } from "../src/agent-loop/tool-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import { classifyExecutionFaults } from "../src/faults/classify.js";
import { executeTurn } from "../src/execution.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { createPluginFaultLatch } from "../src/faults/plugin-fault-latch.js";
import { saveAutoSnapshot } from "../src/snapshot/auto-snapshot.js";
import { PluginServiceRegistry } from "../src/plugin-services.js";
import { LLMRetryError } from "../src/retry/retry-common.js";

const p: RuntimeManifest = {
  pluginId: "p",
  name: "p/run",
  description: "P",
  stage: "pre-turn",
  runtimeType: "function",
  trigger: { type: "auto" },
  tools: { plugin: ["p-tool"] },
};
const q: RuntimeManifest = {
  pluginId: "q",
  name: "q/run",
  description: "Q",
  stage: "narrative",
  trigger: { type: "auto" },
  tools: { plugin: ["q-tool"] },
  inputs: {
    upstream: { from: { capability: "p.context@1" }, required: false },
  },
};
async function fixture() {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: ["p", "q"],
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  return store;
}
describe("fault latch execution admission", () => {
  it("omits a latched runtime and hooks while another agent keeps its own tools", async () => {
    const store = await fixture();
    const latch = createPluginFaultLatch({ threshold: 1 });
    latch.recordHookFault("s", "p", "previous", "hook");
    const hookPipeline = createHookPipeline({
      isPluginLatched: latch.isLatched,
    });
    const pHook = vi.fn(async () => ({ action: "continue" as const }));
    hookPipeline.register({
      id: "p-hook",
      pluginId: "p",
      event: "TurnStart",
      handler: pHook,
    });
    const requests: string[][] = [];
    const findTool = vi.fn((name: string, context: ToolCallContext) =>
      name === `${context.pluginId}-tool`
        ? tool({
            name,
            description: name,
            parameters: z.object({}),
            execute: async () => ({}),
          })
        : undefined,
    );
    const loadRuntime = vi.fn(async (manifest: RuntimeManifest) => ({
      manifest,
      promptTemplate: "Return {}.",
      handler: async () => ({ outcome: "success" as const, value: {} }),
    }));
    const execution = await executeTurn(
      { sessionId: "s", turnId: "turn", playerMessage: "go", origin: "player" },
      [p, q],
      {
        store,
        pluginFaults: latch,
        hookPipeline,
        hookScope: { activePluginIds: new Set(["p", "q"]) },
        loadRuntime,
        toolExecutor: createToolExecutor({ store, findTool }),
        llm: {
          generate: async (request) => {
            requests.push((request.tools ?? []).map((tool) => tool.name));
            return {
              content: "{}",
              toolCalls: [],
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      },
    );
    expect(
      execution.result.runtimeResults.map((result) => result.runtimeId),
    ).toEqual([q.name]);
    expect(
      loadRuntime.mock.calls.map(([manifest]) => manifest.pluginId),
    ).not.toContain("p");
    expect(pHook).not.toHaveBeenCalled();
    expect(execution.commit.activePluginIds?.has("p")).toBe(false);
    expect(requests[0]).toContain("q-tool");
    expect(requests.flat()).not.toContain("p-tool");
    const snapshot = await saveAutoSnapshot({
      store,
      sessionId: "s",
      turnId: "turn",
      force: true,
    });
    expect(snapshot).not.toBeNull();
    const saved = await store.getSnapshot(snapshot!.id);
    expect(saved?.payload.session.activePlugins).toEqual(["p", "q"]);
    expect(JSON.stringify(saved?.payload)).not.toMatch(
      /"(?:paused|latched|consecutiveFaults)"/,
    );
    expect(latch.isLatched("s", "p")).toBe(true);
  });
  it("keeps current runtime and hook admission frozen when a hook latches mid-execution", async () => {
    const store = await fixture();
    const latch = createPluginFaultLatch({ threshold: 1 });
    const hookPipeline = createHookPipeline({
      isPluginLatched: latch.isLatched,
    });
    const post = vi.fn(async () => ({ action: "continue" as const }));
    hookPipeline.register({
      id: "latch",
      pluginId: "p",
      event: "TurnStart",
      handler: async () => {
        latch.recordHookFault("s", "p", "turn", "hook");
        return { action: "continue" };
      },
    });
    hookPipeline.register({
      id: "post",
      pluginId: "p",
      event: "PostRuntime",
      handler: post,
    });
    const execution = await executeTurn(
      { sessionId: "s", turnId: "turn", playerMessage: "go", origin: "player" },
      [p],
      {
        store,
        pluginFaults: latch,
        hookPipeline,
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => ({ outcome: "success", value: {} }),
        }),
        llm: {
          generate: async () => {
            throw new Error("no model");
          },
        },
      },
    );
    expect(execution.result.runtimeResults).toHaveLength(1);
    expect(post).toHaveBeenCalledOnce();
    expect(latch.isLatched("s", "p")).toBe(true);
  });
});

it.each([
  "throw",
  "primitive",
  "admission",
  "latched",
  "timeout",
  "invalid-options",
  "caller-timeout",
] as const)(
  "attributes service %s failures across logical inputs",
  async (mode) => {
    const store = await fixture();
    const latch = createPluginFaultLatch();
    if (mode === "latched")
      for (const key of ["one", "two", "three"])
        latch.recordHookFault("s", "q", key, "hook");
    const services = new PluginServiceRegistry({
      list: async () => ["p", "q"],
      ensure: async (sessionId, pluginId) => {
        if (latch.isLatched(sessionId, pluginId))
          throw new Error(`Plugin is unavailable: ${pluginId}`);
        if (mode === "admission" && pluginId === "q")
          throw new Error("Plugin not authorized");
      },
    });
    const provider = vi.fn(() => {
      if (mode === "timeout" || mode === "caller-timeout")
        return new Promise<never>(() => {});
      if (mode === "primitive") throw "provider primitive failure";
      throw new Error("provider failure");
    });
    services.register("q", {
      name: "probe",
      contract: "probe@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: provider,
    });
    const caller = vi.fn<FunctionHandler>(async (ctx) => {
      await ctx.services!.call(
        { pluginId: "q", name: "probe", contract: "probe@1", input: {} },
        mode === "timeout"
          ? { timeoutMs: 1 }
          : mode === "invalid-options"
            ? { timeoutMs: 0 }
            : undefined,
      );
      return { outcome: "success", value: {} };
    });
    for (const turnId of ["first", "second", "third"]) {
      const execution = await executeTurn(
        { sessionId: "s", turnId, playerMessage: "go", origin: "player" },
        [{ ...p, ...(mode === "caller-timeout" ? { timeoutMs: 5 } : {}) }],
        {
          store,
          pluginFaults: latch,
          services,
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "",
            handler: caller,
          }),
          llm: {
            generate: async () => {
              throw new Error("no model");
            },
          },
        },
      );
      expect(execution.result.runtimeResults).toMatchObject([
        { pluginId: "p", status: "failed" },
      ]);
      expect(execution.result.runtimeResults[0]?.error).toContain(
        {
          throw: "provider failure",
          primitive: "provider primitive failure",
          admission: "Plugin not authorized",
          latched: "Plugin is unavailable: q",
          timeout: "Plugin service call timed out",
          "invalid-options": "timeoutMs",
          "caller-timeout": "timed out after 5ms",
        }[mode],
      );
      const expectedFault =
        mode === "caller-timeout"
          ? "timeout"
          : mode === "invalid-options"
            ? "runtime"
            : undefined;
      expect(execution.result.runtimeResults[0]?.fault).toBe(expectedFault);
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId, durationMs: 0 },
      });
      const transitions = latch.recordExecution({
        sessionId: "s",
        logicalKey: turnId,
        results: execution.commit.results,
        outcome,
        exempt: new Set(),
      });
      if (expectedFault)
        expect(transitions[0]?.type).toBe("plugin.fault.counted");
      else expect(transitions).toEqual([]);
    }
    expect(caller.mock.calls).toHaveLength(3);
    expect(latch.isLatched("s", "p")).toBe(
      mode === "invalid-options" || mode === "caller-timeout",
    );
    expect(provider).toHaveBeenCalledTimes(
      mode === "latched" || mode === "admission" || mode === "invalid-options"
        ? 0
        : 3,
    );
    expect(latch.isLatched("s", "q")).toBe(mode === "latched");
  },
);

it.each(["throw", "timeout", "veto"] as const)(
  "attributes a PreStateCommit %s without blaming an innocent proposal owner",
  async (mode) => {
    const store = await fixture();
    const outcomes: string[] = [];
    const latch = createPluginFaultLatch();
    const hookPipeline = createHookPipeline({
      onHandlerOutcome: (event) => {
        if (event.outcome !== "ok") {
          expect(event.logicalKey).toBe("turn");
          outcomes.push(event.pluginId);
          latch.recordHookFault(
            event.sessionId,
            event.pluginId,
            event.logicalKey ?? "",
            event.outcome === "timeout" ? "timeout" : "hook",
          );
        }
      },
    });
    hookPipeline.register({
      id: "policy",
      pluginId: "p",
      event: "PreStateCommit",
      timeoutMs: 1,
      handler: async () => {
        if (mode === "throw") throw new Error("broken");
        if (mode === "timeout") return new Promise(() => {});
        return { action: "abort", reason: "policy veto" };
      },
    });
    const execution = await executeTurn(
      { sessionId: "s", turnId: "turn", playerMessage: "go", origin: "player" },
      [{ ...q, runtimeType: "function", tools: undefined }],
      {
        store,
        hookPipeline,
        hookScope: { activePluginIds: new Set(["p", "q"]) },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async () => ({
            outcome: "success",
            value: {},
            effects: {
              pluginData: [{ namespace: "data", key: "key", value: 1 }],
            },
          }),
        }),
        llm: {
          generate: async () => {
            throw new Error("no model");
          },
        },
      },
    );
    const outcome = await commitExecution({
      store,
      execution,
      hookPipeline,
      completion: { kind: "turn", turnId: "turn", durationMs: 0 },
    });
    expect(outcome.status).toBe("failed");
    if (mode === "veto") {
      expect(outcomes).toEqual([]);
      expect(
        classifyExecutionFaults(execution.commit.results, outcome).get("q"),
      ).toEqual({ kind: "fault", reason: "proposal-rejected" });
    } else {
      expect(outcomes).toEqual(["p"]);
      expect(outcome.failedProposals[0]?.code).toBe("hook-failed");
      expect(
        classifyExecutionFaults(execution.commit.results, outcome).get("q")
          ?.kind,
      ).toBe("neutral");
    }
  },
);

it("counts a function runtime's own deadline that cancelled a pending child agent", async () => {
  const store = await fixture();
  const latch = createPluginFaultLatch();
  const parent: RuntimeManifest = {
    pluginId: "p",
    name: "p/parent",
    description: "parent",
    stage: "narrative",
    runtimeType: "function",
    trigger: { type: "auto" },
    timeoutMs: 20,
  };
  const child: RuntimeManifest = {
    pluginId: "p",
    name: "p/child",
    description: "child",
    stage: "narrative",
    trigger: { type: "manual" },
  };
  const stops: Array<string | undefined> = [];
  for (const turnId of ["first", "second", "third"]) {
    expect(latch.isLatched("s", "p")).toBe(false);
    const execution = await executeTurn(
      { sessionId: "s", turnId, playerMessage: "go", origin: "player" },
      [parent, child],
      {
        store,
        pluginFaults: latch,
        onRuntimeComplete: async (info) => {
          if (info.runtimeId === child.name) stops.push(info.stopReason);
        },
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "Return {}.",
          handler: async (ctx) => {
            // The model never answers: the parent's deadline cancels the child.
            await ctx.recursiveCall({
              manualTrigger: { runtimeId: child.name },
            });
            return { outcome: "success" as const, value: {} };
          },
        }),
        llm: { generate: () => new Promise<never>(() => {}) },
      },
    );
    expect(execution.commit.results).toMatchObject([
      { runtimeId: parent.name, status: "failed", fault: "timeout" },
    ]);
    const outcome = await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId, durationMs: 0 },
    });
    latch.recordExecution({
      sessionId: "s",
      logicalKey: turnId,
      results: execution.commit.results,
      outcome,
      exempt: new Set(),
    });
  }
  expect(stops).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(latch.isLatched("s", "p")).toBe(true);
});

it.each(["direct", "wrapped", "plain"] as const)(
  "does not latch on a %s provider exception after a hook rewrites the error text",
  async (mode) => {
    const store = await fixture();
    const latch = createPluginFaultLatch();
    const hookPipeline = createHookPipeline();
    hookPipeline.register({
      id: "translate-error",
      event: "PostRuntime",
      handler: async (_context: unknown, payload: unknown) => {
        const { result } = payload as { result: RuntimeResult };
        return {
          action: "continue" as const,
          replace: { result: { ...result, error: "service unavailable" } },
        };
      },
    });
    const providerError = () =>
      new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "remote",
        model: "m",
        message: "upstream 503",
        retriable: true,
      });
    const thrown = () =>
      mode === "direct"
        ? providerError()
        : mode === "wrapped"
          ? new LLMRetryError({
              reason: "transient-error",
              attempts: 2,
              cause: providerError(),
            })
          : new Error("plugin bug");
    for (const turnId of ["first", "second", "third"]) {
      const execution = await executeTurn(
        { sessionId: "s", turnId, playerMessage: "go", origin: "player" },
        [{ ...p, tools: undefined }],
        {
          store,
          pluginFaults: latch,
          hookPipeline,
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "",
            handler: async () => {
              throw thrown();
            },
          }),
          llm: {
            generate: async () => {
              throw new Error("no model");
            },
          },
        },
      );
      expect(execution.commit.results).toMatchObject([
        { status: "failed", error: "service unavailable" },
      ]);
      expect(execution.result.runtimeResults[0]?.fault).toBe(
        mode === "plain" ? "runtime" : undefined,
      );
      const outcome = await commitExecution({
        store,
        execution,
        completion: { kind: "turn", turnId, durationMs: 0 },
      });
      latch.recordExecution({
        sessionId: "s",
        logicalKey: turnId,
        results: execution.commit.results,
        outcome,
        exempt: new Set(),
      });
    }
    expect(latch.isLatched("s", "p")).toBe(mode === "plain");
  },
);
