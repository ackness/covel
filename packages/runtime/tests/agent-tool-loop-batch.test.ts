import { describe, expect, it, vi } from "vitest";
import type { LLMMessage, LLMResponse } from "@covel/shared";
import {
  tool,
  withPendingProposals,
  withEmittedEvents,
  type ToolAnnotations,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import { settleAgentLoop } from "../src/agent-loop/settle-agent-loop.js";
import { stopOf } from "../src/agent-loop/stop-reason.js";
import { TurnAbortedError } from "../src/turn-executor/turn-control.js";
import { collectExecutionSuspensions } from "../src/suspension-artifact.js";
import { createTurnEmitter } from "../src/trace/turn-emitter.js";
import { MAX_PARALLEL_TOOL_CALLS } from "../src/agent-loop/tool-batch.js";
import type { ToolCallContext } from "../src/agent-loop/tool-executor.js";
import {
  expectMatchedToolCalls,
  input,
  latch,
  makeExecutor,
  manifest,
  prose,
  queuedLLM,
  runLoop,
  runRuntime,
  toolCall,
} from "./_helpers/agent-loop-fixture.js";
import { makeEmitterSpy } from "./_helpers/emitter-spy.js";

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const readAnnotations = { readOnly: true, concurrencySafe: true };
function module(
  name: string,
  execute: () => Promise<Record<string, unknown>> = async () => ({ name }),
  annotations: Partial<ToolAnnotations> = readAnnotations,
  timeoutMs?: number,
): ToolModule {
  return tool({
    name,
    description: name,
    parameters: z.object({}),
    annotations,
    timeoutMs,
    execute,
  });
}
function batch(names: string[], content: string | null = null): LLMResponse {
  return {
    ...toolCall(names[0]!, {}, "unused", content),
    toolCalls: names.flatMap(
      (name, index) => toolCall(name, {}, `call-${index}`).toolCalls,
    ),
  };
}
const transcript = (): LLMMessage[] => [
  { role: "system", content: "sys" },
  { role: "user", content: "go" },
];
const toolsIn = (messages: readonly LLMMessage[]) =>
  messages.filter((message) => message.role === "tool");
const runtimeFor = (names: string[]) => manifest({ tools: { plugin: names } });

describe("tool batches", () => {
  it.each([true, false])(
    "closes calls after a terminating barrier (repair: %s)",
    async (repair) => {
      const save = vi.fn(async () => ({ saved: true }));
      const runtime = runtimeFor(["mark", "save"]);
      const loaded = {
        manifest: runtime,
        promptTemplate: "Write JSON.",
        ...(repair
          ? {
              outputSchema: {
                type: "object",
                required: ["answer"],
                properties: { answer: { type: "string" } },
              },
            }
          : {}),
      };
      const hooks = createHookPipeline();
      hooks.register({
        id: "finish",
        event: "PostToolUse",
        handler: async () => ({
          action: "continue",
          replace: { terminate: true },
        }),
      });
      const messages = transcript();
      const emitter = makeEmitterSpy();
      const llm = queuedLLM([
        batch(["mark", "save"], "unfinished draft"),
        prose('{"answer":"fixed"}'),
      ]);
      const loop = await runLoop({
        llm,
        manifest: runtime,
        loaded,
        hookPipeline: hooks,
        messages,
        deps: {
          emitter,
          toolExecutor: makeExecutor([
            module("mark", undefined, {}),
            module("save", save, {}),
          ]),
        },
      });
      expect(save).not.toHaveBeenCalled();
      expectMatchedToolCalls(messages);
      expect(loop.stop).toEqual({
        reason: "tool-finished",
        ...(repair ? { repaired: true } : {}),
      });
      expect(llm.requests).toHaveLength(repair ? 2 : 1);
      if (repair) {
        expectMatchedToolCalls(llm.requests[1]!.messages);
        const settled = settleAgentLoop({
          manifest: runtime,
          input,
          runId: "run-loop",
          startTime: Date.now(),
          toolLoop: loop,
          outputSchema: loaded.outputSchema,
        });
        expect(settled.result.output).toEqual({ answer: "fixed" });
      }
      expect(JSON.parse(toolsIn(messages)[1]!.content as string)).toEqual({
        error: {
          code: "cancelled",
          message: "Not run: an earlier tool result ended the run.",
        },
      });
      expect(loop.executedToolCalls.map((call) => call.name)).toEqual(["mark"]);
      expect(loop.collectedToolCalls.map((call) => call.toolName)).toEqual([
        "mark",
      ]);
      expect(loop.failedToolCalls).toEqual([]);
      expect(
        emitter.events.filter((event) => event.payload.toolCallId === "call-1"),
      ).toMatchObject([
        {
          type: "tool.calling",
          payload: {
            code: "cancelled",
            skipped: true,
            skipReason: "terminated",
            durationMs: 0,
            approvalStatus: "auto-allowed",
          },
        },
        {
          type: "tool.failed",
          payload: {
            code: "cancelled",
            skipped: true,
            skipReason: "terminated",
            success: false,
          },
        },
      ]);
      expect(
        emitter.events.find((event) => event.type === "step.completed")?.payload
          .toolCalls,
      ).toEqual([{ name: "mark", success: true }]);
    },
  );

  it("runs reads together and records them in model order after reverse completion", async () => {
    const arrive = latch(3);
    const finished: string[] = [];
    const hooksSeen: string[] = [];
    const names = ["a", "b", "c"];
    const modules = names.map((name, index) =>
      module(name, async () => {
        hooksSeen.push(`start:${name}`);
        await arrive();
        await wait((2 - index) * 20);
        finished.push(name);
        return { name };
      }),
    );
    const hooks = createHookPipeline();
    for (const event of ["PreToolUse", "PostToolUse"] as const)
      hooks.register<{ toolCall: { name: string } }>({
        id: event,
        event,
        handler: async (_context, payload) => {
          hooksSeen.push(`${event}:${payload.toolCall.name}`);
          if (event === "PostToolUse") expect(finished).toHaveLength(3);
          return { action: "continue" };
        },
      });
    const messages = transcript();
    const emitter = makeEmitterSpy();
    const loop = await runLoop({
      llm: queuedLLM([batch(names), prose("done")]),
      manifest: runtimeFor(names),
      messages,
      hookPipeline: hooks,
      timeoutMs: 400,
      deps: { emitter, toolExecutor: makeExecutor(modules) },
    });
    expect(finished).toEqual(["c", "b", "a"]);
    expect(toolsIn(messages).map((message) => message.toolCallId)).toEqual([
      "call-0",
      "call-1",
      "call-2",
    ]);
    expect(loop.executedToolCalls.map((call) => call.name)).toEqual(names);
    expect(loop.collectedToolCalls.map((call) => call.toolName)).toEqual(names);
    expect(loop.collectedToolCalls[0]!.durationMs).toBeGreaterThan(
      loop.collectedToolCalls[2]!.durationMs,
    );
    expect(
      emitter.events.find((event) => event.type === "step.completed")?.payload
        .toolCalls,
    ).toEqual(names.map((name) => ({ name, success: true })));
    expect(hooksSeen).toEqual([
      ...names.map((name) => `PreToolUse:${name}`),
      ...names.map((name) => `start:${name}`),
      ...names.map((name) => `PostToolUse:${name}`),
    ]);
  });

  it("waits on both sides of a write barrier", async () => {
    const log: string[] = [];
    const arrive = latch(2);
    const names = ["r1", "write", "r2", "r3"];
    const modules = names.map((name) =>
      module(
        name,
        async () => {
          log.push(`start:${name}`);
          if (name === "r2" || name === "r3") await arrive();
          await wait(5);
          log.push(`end:${name}`);
          return { name };
        },
        name === "write" ? {} : readAnnotations,
      ),
    );
    await runLoop({
      llm: queuedLLM([batch(names), prose("done")]),
      manifest: runtimeFor(names),
      timeoutMs: 400,
      deps: { toolExecutor: makeExecutor(modules) },
    });
    expect(log.indexOf("start:write")).toBeGreaterThan(log.indexOf("end:r1"));
    expect(log.indexOf("start:r2")).toBeGreaterThan(log.indexOf("end:write"));
    expect(log.indexOf("start:r3")).toBeGreaterThan(log.indexOf("end:write"));
    expect(log.indexOf("start:r3")).toBeLessThan(log.indexOf("end:r2"));
  });

  it("merges barrier effects in order and shares one context snapshot within each pool", async () => {
    const names = [
      "read-a",
      "read-b",
      "write-a",
      "read-c",
      "write-b",
      "read-d",
      "read-e",
    ];
    const executor = makeExecutor(
      names.map((name) =>
        name.startsWith("write")
          ? tool({
              name,
              description: name,
              parameters: z.object({}),
              execute: async (_args, context) =>
                withEmittedEvents(
                  withPendingProposals({ name }, [
                    {
                      id: name,
                      type: "plugin.data",
                      source: {
                        pluginId: context.pluginId,
                        runtimeId: context.runtimeId,
                      },
                      sessionId: context.sessionId,
                      turnId: context.turnId,
                      timestamp: "2026-10-30T00:00:00.000Z",
                      payload: { namespace: "batch", key: name, value: name },
                    },
                  ]),
                  [{ topic: name, data: { name } }],
                ),
            })
          : module(name),
      ),
    );
    const executed: Array<{ name: string; context: ToolCallContext }> = [];
    const classified: Array<{ name: string; context: ToolCallContext }> = [];
    const loop = await runLoop({
      llm: queuedLLM([batch(names), prose("done")]),
      manifest: runtimeFor(names),
      deps: {
        toolExecutor: {
          getToolInfo: (name: string, context: ToolCallContext) => {
            classified.push({ name, context });
            return executor.getToolInfo(name, context);
          },
          execute: (
            call: Parameters<typeof executor.execute>[0],
            context: ToolCallContext,
          ) => {
            executed.push({ name: call.name, context });
            return executor.execute(call, context);
          },
        },
      },
    });
    expect(loop.pendingProposals.map((proposal) => proposal.payload)).toEqual([
      { namespace: "batch", key: "write-a", value: "write-a" },
      { namespace: "batch", key: "write-b", value: "write-b" },
    ]);
    expect(loop.emittedEvents.map((event) => event.topic)).toEqual([
      "write-a",
      "write-b",
    ]);
    expect(executed.map(({ context }) => context.emittedEventTopics)).toEqual([
      [],
      [],
      [],
      ["write-a"],
      ["write-a"],
      ["write-a", "write-b"],
      ["write-a", "write-b"],
    ]);
    expect(executed[0]!.context).toBe(executed[1]!.context);
    expect(executed[5]!.context).toBe(executed[6]!.context);
    for (const entry of executed) {
      expect(
        classified.some(
          (candidate) =>
            candidate.name === entry.name &&
            candidate.context === entry.context,
        ),
      ).toBe(true);
      expect(entry.context.pendingProposals).toBe(loop.pendingProposals);
    }
  });

  it("treats serial reads, unknown names, undeclared names and tool search as barriers", async () => {
    let active = 0;
    const order: string[] = [];
    const names = [
      "r1",
      "serial",
      "r2",
      "missing",
      "r3",
      "hidden",
      "r4",
      "search-tools",
      "r5",
    ];
    const reads = ["r1", "r2", "r3", "r4", "r5"].map((name) =>
      module(name, async () => {
        order.push(`start:${name}`);
        active++;
        await wait(5);
        active--;
        order.push(`end:${name}`);
        return { name };
      }),
    );
    const hooks = createHookPipeline();
    const barriers: string[] = [];
    hooks.register<{ toolCall: { name: string } }>({
      id: "barriers",
      event: "PreToolUse",
      handler: async (_context, { toolCall: call }) => {
        order.push(`pre:${call.name}`);
        if (
          ["serial", "missing", "hidden", "search-tools"].includes(call.name)
        ) {
          expect(active).toBe(0);
          barriers.push(call.name);
        }
        return { action: "continue" };
      },
    });
    hooks.register<{ toolCall: { name: string } }>({
      id: "barrier-results",
      event: "PostToolUse",
      handler: async (_context, { toolCall: call }) => {
        await Promise.resolve();
        order.push(`post:${call.name}`);
        return { action: "continue" };
      },
    });
    const hidden = vi.fn(async () => ({ secret: true }));
    const messages = transcript();
    const loop = await runLoop({
      llm: queuedLLM([batch(names), prose("done")]),
      manifest: manifest({
        tools: {
          plugin: [
            ...names.filter(
              (name) =>
                name !== "hidden" &&
                name !== "search-tools" &&
                name !== "missing",
            ),
            "deferred",
          ],
          defer: ["deferred"],
          builtin: ["missing"],
        },
      }),
      hookPipeline: hooks,
      messages,
      deps: {
        toolExecutor: makeExecutor([
          ...reads,
          module(
            "serial",
            async () => {
              expect(active).toBe(0);
              return {};
            },
            { readOnly: true },
          ),
          module("hidden", hidden),
          module("deferred"),
        ]),
      },
    });
    expect(barriers).toEqual(["serial", "missing", "hidden", "search-tools"]);
    expect(hidden).not.toHaveBeenCalled();
    expect(
      order.filter((entry) =>
        ["end:r3", "pre:hidden", "post:hidden", "start:r4"].includes(entry),
      ),
    ).toEqual(["end:r3", "pre:hidden", "post:hidden", "start:r4"]);
    expect(JSON.parse(toolsIn(messages)[3]!.content as string).error.code).toBe(
      "not-found",
    );
    expect(JSON.parse(toolsIn(messages)[5]!.content as string).error.code).toBe(
      "unavailable",
    );
    expect(loop.executedToolCalls.map((call) => call.name)).toEqual(names);
  });

  it("keeps at most eight calls in flight", async () => {
    let active = 0;
    let maximum = 0;
    const names = Array.from({ length: 10 }, (_, index) => `read-${index}`);
    const modules = names.map((name) =>
      module(name, async () => {
        maximum = Math.max(maximum, ++active);
        await wait(10);
        active--;
        return { name };
      }),
    );
    const loop = await runLoop({
      llm: queuedLLM([batch(names), prose("done")]),
      manifest: runtimeFor(names),
      deps: { toolExecutor: makeExecutor(modules) },
    });
    expect(maximum).toBe(MAX_PARALLEL_TOOL_CALLS);
    expect(loop.collectedToolCalls.map((call) => call.toolName)).toEqual(names);
  });

  it("continues after a pooled timeout without losing its sibling result", async () => {
    const executor = makeExecutor([
      module(
        "slow",
        async () => {
          await wait(200);
          return { late: true };
        },
        readAnnotations,
        20,
      ),
      module("fast"),
    ]);
    const messages = transcript();
    const llm = queuedLLM([batch(["slow", "fast"]), prose("done")]);
    try {
      const loop = await runLoop({
        llm,
        manifest: runtimeFor(["slow", "fast"]),
        messages,
        deps: { toolExecutor: executor },
      });
      expect(
        JSON.parse(toolsIn(messages)[0]!.content as string).error.code,
      ).toBe("timeout");
      expect(JSON.parse(toolsIn(messages)[1]!.content as string).data).toEqual({
        name: "fast",
      });
      expect(loop.executedToolCalls).toMatchObject([
        { name: "slow", success: false },
        { name: "fast", success: true },
      ]);
      expect(loop.executedToolCalls[0]).not.toHaveProperty("refused");
      expect(loop.failedToolCalls).toEqual([
        { toolName: "slow", message: expect.any(String) },
      ]);
      expect(llm.requests).toHaveLength(2);
    } finally {
      await executor.close();
    }
  });

  it.each([false, true])(
    "finishes a terminating pool and skips later barriers (barrier: %s)",
    async (barrier) => {
      const names = ["r1", "r2", ...(barrier ? ["write"] : ["r3"])];
      const ran: string[] = [];
      const posts: string[] = [];
      const modules = names.map((name) =>
        module(
          name,
          async () => {
            ran.push(name);
            return { name };
          },
          name === "write" ? {} : readAnnotations,
        ),
      );
      const hooks = createHookPipeline();
      hooks.register<{ toolCall: { name: string } }>({
        id: "finish",
        event: "PostToolUse",
        handler: async (_context, { toolCall: call }) => {
          posts.push(call.name);
          return {
            action: "continue",
            replace: { terminate: call.name === "r1" },
          };
        },
      });
      const emitter = makeEmitterSpy();
      const loop = await runLoop({
        llm: queuedLLM([batch(names, "finished")]),
        manifest: runtimeFor(names),
        hookPipeline: hooks,
        deps: { emitter, toolExecutor: makeExecutor(modules) },
      });
      const completed = barrier ? names.slice(0, 2) : names;
      expect(ran).toEqual(completed);
      expect(posts).toEqual(completed);
      expect(loop.executedToolCalls.map((call) => call.name)).toEqual(
        completed,
      );
      expect(loop.collectedToolCalls.map((call) => call.toolName)).toEqual(
        completed,
      );
      expect(loop.stop).toEqual({ reason: "tool-finished" });
      if (barrier)
        expect(
          emitter.events.filter((event) => event.payload.toolName === "write"),
        ).toMatchObject([
          { payload: { skipped: true, skipReason: "terminated" } },
          { payload: { skipped: true, skipReason: "terminated" } },
        ]);
    },
  );

  it("records a hook refusal in position without counting it as executed work", async () => {
    const hooks = createHookPipeline();
    hooks.register<{ toolCall: { name: string } }>({
      id: "refuse",
      event: "PreToolUse",
      handler: async (_context, { toolCall: call }) =>
        call.name === "b"
          ? { action: "abort", reason: "blocked" }
          : { action: "continue" },
    });
    const refused = vi.fn(async () => ({}));
    const messages = transcript();
    const emitter = makeEmitterSpy();
    const loop = await runLoop({
      llm: queuedLLM([batch(["a", "b", "c"]), prose("done")]),
      manifest: runtimeFor(["a", "b", "c"]),
      hookPipeline: hooks,
      messages,
      deps: {
        emitter,
        toolExecutor: makeExecutor([
          module("a"),
          module("b", refused),
          module("c"),
        ]),
      },
    });
    expect(refused).not.toHaveBeenCalled();
    expect(toolsIn(messages).map((message) => message.toolCallId)).toEqual([
      "call-0",
      "call-1",
      "call-2",
    ]);
    expect(JSON.parse(toolsIn(messages)[1]!.content as string).error.code).toBe(
      "refused",
    );
    expect(loop.executedToolCalls.map((call) => call.name)).toEqual(["a", "c"]);
    expect(loop.collectedToolCalls.map((call) => call.toolName)).toEqual([
      "a",
      "c",
    ]);
    expect(loop.failedToolCalls).toEqual([]);
    expect(
      emitter.events.filter((event) => event.payload.toolCallId === "call-1"),
    ).toMatchObject([
      {
        type: "tool.calling",
        payload: { skipReason: "hook-aborted", skipped: true },
      },
      {
        type: "tool.failed",
        payload: { code: "refused", skipReason: "hook-aborted", skipped: true },
      },
    ]);
    expect(
      emitter.events.find((event) => event.type === "step.completed")?.payload
        .toolCalls,
    ).toEqual([
      { name: "a", success: true },
      { name: "c", success: true },
    ]);
  });

  it("memoizes a look-ahead rewrite and waits for the pool before its barrier", async () => {
    const log: string[] = [];
    const hooks = createHookPipeline();
    hooks.register<{ toolCall: { name: string } }>({
      id: "rewrite",
      event: "PreToolUse",
      handler: async (_context, { toolCall: call }) => {
        log.push(`pre:${call.name}`);
        return {
          action: "continue",
          ...(call.name === "r2"
            ? { replace: { toolCall: { name: "write" } } }
            : {}),
        };
      },
    });
    const arrive = latch(2);
    const modules = ["r1", "r3", "r2", "write", "r4"].map((name) =>
      module(
        name,
        async () => {
          log.push(`start:${name}`);
          if (name === "r1" || name === "r3") await arrive();
          log.push(`end:${name}`);
          return { name };
        },
        name === "write" ? {} : readAnnotations,
      ),
    );
    const messages = transcript();
    await runLoop({
      llm: queuedLLM([batch(["r1", "r3", "r2", "r4"]), prose("done")]),
      manifest: runtimeFor(modules.map((entry) => entry.name)),
      hookPipeline: hooks,
      timeoutMs: 400,
      messages,
      deps: { toolExecutor: makeExecutor(modules) },
    });
    expect(log.filter((entry) => entry.startsWith("pre:"))).toEqual([
      "pre:r1",
      "pre:r3",
      "pre:r2",
      "pre:r4",
    ]);
    expect(log.indexOf("start:write")).toBeGreaterThan(log.indexOf("end:r1"));
    expect(log.indexOf("start:write")).toBeGreaterThan(log.indexOf("end:r3"));
    expect(log.indexOf("pre:r2")).toBeLessThan(log.indexOf("start:r1"));
    expect(log.indexOf("pre:r4")).toBeGreaterThan(log.indexOf("end:write"));
    expect(
      messages.find((message) => message.toolCalls)?.toolCalls?.[2]?.name,
    ).toBe("write");
  });

  it("drains admitted calls and closes the transcript before propagating player cancellation", async () => {
    const controller = new AbortController();
    const arrive = latch(2);
    const entered: string[] = [];
    let settled = 0;
    const executor = makeExecutor(
      ["a", "b", "write"].map((name) =>
        module(
          name,
          async () => {
            entered.push(name);
            await arrive();
            controller.abort();
            return { name };
          },
          name === "write" ? {} : readAnnotations,
        ),
      ),
    );
    const messages = transcript();
    const emitter = makeEmitterSpy();
    try {
      let thrown: unknown;
      try {
        await runLoop({
          llm: queuedLLM([batch(["a", "b", "write"])]),
          manifest: runtimeFor(["a", "b", "write"]),
          messages,
          deps: {
            emitter,
            turnControl: { signal: controller.signal },
            toolExecutor: {
              getToolInfo: executor.getToolInfo,
              execute: async (...args: Parameters<typeof executor.execute>) => {
                try {
                  return await executor.execute(...args);
                } finally {
                  settled++;
                }
              },
            },
          },
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(TurnAbortedError);
      expect(stopOf(thrown, "run-loop")).toEqual({
        reason: "cancelled",
        cancelledBy: "player",
      });
      expect(settled).toBe(2);
      expect(entered).toEqual(["a", "b"]);
      expectMatchedToolCalls(messages);
      expect(
        emitter.events.filter((event) => event.payload.toolName === "write"),
      ).toMatchObject([
        {
          type: "tool.calling",
          payload: { skipped: true, skipReason: "aborted" },
        },
        {
          type: "tool.failed",
          payload: { skipped: true, skipReason: "aborted" },
        },
      ]);
      for (const name of ["a", "b"])
        expect(
          emitter.events.filter(
            (event) =>
              event.payload.toolName === name &&
              ["tool.completed", "tool.failed"].includes(event.type),
          ),
        ).toHaveLength(1);
    } finally {
      await executor.close();
    }
  });

  it("captures a matched suspension transcript and cancels calls after the suspender", async () => {
    const after = vi.fn(async () => ({}));
    const emitter = makeEmitterSpy();
    const result = await runRuntime({
      llm: queuedLLM([batch(["r1", "suspend", "r2"])]),
      manifest: manifest({
        tools: { plugin: ["r1", "r2"], builtin: ["suspend"] },
      }),
      deps: {
        emitter,
        toolExecutor: makeExecutor([
          module("r1"),
          module(
            "suspend",
            async () => ({
              _covelSuspend: true,
              reason: "answer",
              resumeSchema: {},
            }),
            {},
          ),
          module("r2", after),
        ]),
      },
    });
    const [saved] = collectExecutionSuspensions({ runtimeResults: [result] });
    expect(result.status).toBe("suspended");
    const messages = saved!.pendingContinuation.messages as LLMMessage[];
    expectMatchedToolCalls(messages);
    expect(JSON.parse(toolsIn(messages)[1]!.content as string)).toEqual({
      summary: "Suspended: waiting for the player's answer.",
    });
    expect(JSON.parse(toolsIn(messages)[2]!.content as string).error.code).toBe(
      "cancelled",
    );
    expect(after).not.toHaveBeenCalled();
    expect(
      emitter.events.find((event) => event.payload.toolCallId === "call-2")
        ?.payload,
    ).toMatchObject({ skipped: true, skipReason: "suspended" });
  });

  it("answers a nested suspension with an unavailable envelope and continues", async () => {
    const messages = transcript();
    const llm = queuedLLM([toolCall("suspend", {}), prose("continue")]);
    await runLoop({
      llm,
      manifest: manifest({ tools: { builtin: ["suspend"] } }),
      allowSuspend: false,
      messages,
      deps: {
        toolExecutor: makeExecutor([
          module(
            "suspend",
            async () => ({
              _covelSuspend: true,
              reason: "answer",
              resumeSchema: {},
            }),
            {},
          ),
        ]),
      },
    });
    expect(JSON.parse(toolsIn(messages)[0]!.content as string)).toMatchObject({
      error: {
        code: "unavailable",
        message: expect.stringContaining("sub-agent"),
      },
    });
    expect(llm.requests).toHaveLength(2);
  });

  it("strips skipped-call content from persisted concealed trace events", async () => {
    const persisted: Array<{ type: string; payload: unknown }> = [];
    const runtime = runtimeFor(["a"]);
    const emitter = createTurnEmitter({
      sessionId: input.sessionId,
      turnId: input.turnId,
      concealedRuntimeIds: new Set([runtime.name]),
      store: {
        addTraceEvent: async (event) => {
          persisted.push(event);
        },
      },
    });
    const hooks = createHookPipeline();
    hooks.register({
      id: "refuse",
      event: "PreToolUse",
      handler: async () => ({ action: "abort", reason: "private reason" }),
    });
    await runLoop({
      llm: queuedLLM([batch(["a"]), prose("done")]),
      manifest: runtime,
      hookPipeline: hooks,
      deps: { emitter, toolExecutor: makeExecutor([module("a")]) },
    });
    const events = persisted.filter((event) => event.type.startsWith("tool."));
    expect(events.map((event) => event.type)).toEqual([
      "tool.calling",
      "tool.failed",
    ]);
    for (const event of events)
      for (const key of ["code", "error", "skipped", "skipReason"])
        expect(event.payload).not.toHaveProperty(key);
  });
});
