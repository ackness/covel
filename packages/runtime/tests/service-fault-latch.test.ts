import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ToolError, type RuntimeManifest } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { executeTurn } from "../src/execution.js";
import { commitExecution } from "../src/commit/commit-execution.js";
import { createPluginFaultLatch } from "../src/faults/plugin-fault-latch.js";
import { classifyExecutionFaults } from "../src/faults/classify.js";
import {
  PluginServiceRegistry,
  type ServiceCallOutcome,
} from "../src/plugin-services.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { SERVICE_IMPORT_TIMEOUT_MS } from "../src/agent-loop/service-import-tools.js";
import { answer, fixture, input, runtime } from "./operation-fixture.js";

afterEach(() => vi.useRealTimers());
const request = {
  pluginId: "provider",
  name: "probe",
  contract: "probe@1",
  input: {},
};

async function harness() {
  const { store } = await fixture();
  const latch = createPluginFaultLatch();
  const services = new PluginServiceRegistry({
    list: async () =>
      ["caller", "provider", "nested"].filter(
        (id) => !latch.isLatched(input.sessionId, id),
      ),
    paused: async () =>
      latch.latched(input.sessionId).map((state) => state.pluginId),
    ensure: async (_session, pluginId) => {
      if (latch.isLatched(input.sessionId, pluginId))
        throw new ToolError("unavailable", "The provider is paused.");
    },
  });
  let index = 0;
  async function run(
    handler: FunctionHandler,
    extra: Partial<RuntimeManifest> = {},
    abort = false,
  ) {
    const caller = runtime("caller/run", { outputKind: "story", ...extra });
    const turnId = `turn-${++index}`;
    const execution = await executeTurn({ ...input, turnId }, [caller], {
      store,
      services,
      pluginFaults: latch,
      llm: { generate: async () => answer() },
      loadRuntime: async (manifest) => ({
        manifest,
        promptTemplate: "",
        handler,
      }),
    });
    const outcome = await commitExecution({
      store,
      execution: abort
        ? {
            ...execution,
            commit: {
              ...execution.commit,
              abortReason: "The player cancelled.",
            },
          }
        : execution,
      completion: { kind: "turn", turnId, durationMs: 0 },
    });
    const setupRuntimeIds = new Set(
      extra.stage === "setup" ? [caller.name] : [],
    );
    const transitions = latch.recordExecution({
      sessionId: input.sessionId,
      logicalKey: turnId,
      results: execution.commit.results,
      outcome,
      exempt: new Set(["caller"]),
      setupRuntimeIds,
      serviceCalls: execution.commit.serviceCalls,
    });
    return { execution, outcome, transitions, setupRuntimeIds };
  }
  const call: FunctionHandler = async (ctx) => {
    try {
      await ctx.services!.call(request);
    } catch {
      /* A story continues when an optional service fails. */
    }
    return {
      outcome: "success",
      value: { narrativeOutput: "The story continues." },
    };
  };
  return { store, services, latch, run, call };
}

describe("service provider fault latch", () => {
  it("pauses a crashing provider across three committed turns, removes its import and refuses direct calls", async () => {
    const h = await harness();
    h.services.register("provider", {
      name: "probe",
      contract: "probe@1",
      modelFacing: true,
      description: "Probe",
      input: z.object({}),
      output: z.unknown(),
      handler: () => {
        throw new Error("Provider crashed");
      },
    });
    try {
      for (let i = 0; i < 3; i++) {
        const { execution, outcome } = await h.run(h.call);
        expect(outcome.status).toBe("committed");
        expect(execution.commit.serviceCalls).toEqual([
          {
            providerPluginId: "provider",
            callerRuntimeId: "caller/run",
            verdict: "fault",
          },
        ]);
      }
      expect(h.latch.latched(input.sessionId)).toEqual([
        expect.objectContaining({ pluginId: "provider", reason: "service" }),
      ]);
      expect(
        await h.services.resolveImport(
          { sessionId: input.sessionId, pluginId: "caller" },
          "probe@1",
        ),
      ).toEqual({ status: "paused", pluginId: "provider" });
      await h.run(async (ctx) => {
        await expect(ctx.services!.call(request)).rejects.toMatchObject({
          code: "unavailable",
        });
        return {
          outcome: "success",
          value: { narrativeOutput: "The story continues." },
        };
      });
    } finally {
      await h.store.close();
    }
  });

  it.each([
    "invalid-input",
    "not-found",
    "ambiguous",
    "refused",
    "conflict",
    "unavailable",
    "cancelled",
  ] as const)("treats a deliberate %s answer as neutral", async (code) => {
    const h = await harness();
    h.services.register("provider", {
      name: "probe",
      contract: "probe@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: () => {
        throw new ToolError(code, "The request cannot be fulfilled.");
      },
    });
    try {
      for (let i = 0; i < 3; i++)
        expect(
          (await h.run(h.call)).execution.commit.serviceCalls?.[0]?.verdict,
        ).toBe("neutral");
      expect(h.latch.latched(input.sessionId)).toEqual([]);
    } finally {
      await h.store.close();
    }
  });

  it("attributes a nested crash only to the failing hop and clears its streak on a committed clean call", async () => {
    const h = await harness();
    let crash = true;
    h.services.register("nested", {
      name: "probe",
      contract: "probe@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: () => {
        if (crash) throw new ToolError("internal", "Provider crashed");
        return {};
      },
    });
    h.services.register("provider", {
      name: "probe",
      contract: "probe@1",
      input: z.unknown(),
      output: z.unknown(),
      handler: (_value, ctx) =>
        ctx.services.call({ ...request, pluginId: "nested" }),
    });
    try {
      const failed = await h.run(h.call);
      expect(failed.execution.commit.serviceCalls).toEqual([
        {
          providerPluginId: "nested",
          callerRuntimeId: "caller/run",
          verdict: "fault",
        },
        {
          providerPluginId: "provider",
          callerRuntimeId: "caller/run",
          verdict: "neutral",
        },
      ]);
      crash = false;
      const rolledBack = await h.run(h.call, {}, true);
      expect(rolledBack.transitions).toEqual([]);
      const clean = await h.run(h.call);
      expect(clean.transitions).toContainEqual({
        type: "plugin.fault.cleared",
        payload: {
          sessionId: input.sessionId,
          pluginId: "nested",
          by: "clean-run",
        },
      });
      expect(
        classifyExecutionFaults(
          [],
          failed.outcome,
          new Set(["caller/run"]),
          [],
          failed.execution.commit.serviceCalls,
        ).size,
      ).toBe(0);
      expect(
        classifyExecutionFaults(
          [],
          clean.outcome,
          new Set(["caller/run"]),
          [],
          clean.execution.commit.serviceCalls,
        ).size,
      ).toBe(0);
    } finally {
      await h.store.close();
    }
  });

  it("counts invalid provider output, but not invalid input or calls outside an execution", async () => {
    const h = await harness();
    const outcomes: ServiceCallOutcome[] = [];
    h.services.register<unknown, unknown>("provider", {
      name: "probe",
      contract: "probe@1",
      input: z.object({ required: z.boolean() }),
      output: z.string(),
      handler: () => 42,
    });
    try {
      expect(
        (await h.run(h.call)).execution.commit.serviceCalls?.[0]?.verdict,
      ).toBe("neutral");
      const result = await h.run(async (ctx) => {
        await ctx
          .services!.call({ ...request, input: { required: true } })
          .catch(() => {});
        return {
          outcome: "success",
          value: { narrativeOutput: "The story continues." },
        };
      });
      expect(result.execution.commit.serviceCalls?.[0]?.verdict).toBe("fault");
      await h.services.withExecutionObserver(
        (event) => outcomes.push(event),
        () =>
          h.services
            .createClient({
              sessionId: input.sessionId,
              pluginId: "caller",
              signal: new AbortController().signal,
            })
            .call({ ...request, input: { required: true } })
            .catch(() => {}),
      );
      expect(outcomes).toEqual([]);
    } finally {
      await h.store.close();
    }
  });

  it.each([false, true])(
    "distinguishes a kernel import deadline from the same caller-chosen duration (import: %s)",
    async (imported) => {
      const h = await harness();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      h.services.register("provider", {
        name: "probe",
        contract: "probe@1",
        modelFacing: true,
        description: "Probe",
        input: z.object({}),
        output: z.unknown(),
        handler: async () => {
          entered();
          return new Promise(() => {});
        },
      });
      vi.useFakeTimers();
      try {
        let calls = 0;
        const caller = runtime("caller/run", {
          runtimeType: imported ? "agent" : "function",
          outputKind: "story",
          tools: imported
            ? { services: [{ contract: "probe@1", name: "probe" }] }
            : undefined,
        });
        const work = executeTurn(input, [caller], {
          store: h.store,
          services: h.services,
          toolExecutor: createToolExecutor({
            store: h.store,
            findTool: () => undefined,
          }),
          llm: {
            generate: async () =>
              calls++ === 0
                ? {
                    ...answer(),
                    content: null,
                    toolCalls: [{ id: "call", name: "probe", arguments: "{}" }],
                    finishReason: "tool_calls",
                  }
                : answer(),
          },
          loadRuntime: async (manifest) => ({
            manifest,
            promptTemplate: "Tell the story.",
            handler: async (ctx) => {
              await ctx
                .services!.call(request, {
                  timeoutMs: SERVICE_IMPORT_TIMEOUT_MS,
                })
                .catch(() => {});
              return {
                outcome: "success",
                value: { narrativeOutput: "The story continues." },
              };
            },
          }),
        });
        await started;
        await vi.advanceTimersByTimeAsync(SERVICE_IMPORT_TIMEOUT_MS);
        const execution = await work;
        expect(execution.commit.serviceCalls).toEqual([
          {
            providerPluginId: "provider",
            callerRuntimeId: "caller/run",
            verdict: imported ? "fault" : "neutral",
          },
        ]);
        expect(execution.commit.results[0]?.status).toBe("success");
      } finally {
        await h.store.close();
      }
    },
  );
});
