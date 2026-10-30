import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  tool,
  z,
  withPendingProposals,
  withEmittedEvents,
  type ToolExecutionContext,
} from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

import type { TurnEmitter } from "../src/trace/turn-emitter.js";
import type { Proposal } from "@covel/shared";

const identity = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "plugin",
  runtimeId: "plugin/main",
};
const call = { toolCallId: "call", name: "probe", arguments: "{}" };
const proposal: Proposal = {
  id: "pending",
  type: "plugin.data",
  sessionId: identity.sessionId,
  turnId: identity.turnId,
  source: { pluginId: identity.pluginId, runtimeId: identity.runtimeId },
  timestamp: "2026-10-29T00:00:00.000Z",
  payload: { namespace: "test", key: "result", value: true },
};

describe("tool annotations and per-call timeout", () => {
  it("times out a never-resolving tool, records timeout and traces a failure", async () => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore();
      const save = vi.spyOn(store, "saveToolCall");
      const emit = vi.fn(async () => {});
      const entered = Promise.withResolvers<void>();
      const module = tool({
        name: call.name,
        description: "Never finishes.",
        parameters: z.object({}),
        timeoutMs: 20,
        execute: async () => {
          entered.resolve();
          return new Promise<never>(() => {});
        },
      });
      const executor = createToolExecutor({ store, findTool: () => module });
      const running = executor.execute(call, {
        ...identity,
        emitter: { emit } as unknown as TurnEmitter,
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20);
      const result = await running;
      expect(result).toMatchObject({ success: false, parsedResult: null });
      expect(JSON.parse(result.result).error.code).toBe("timeout");
      expect(result.pendingProposals).toBeUndefined();
      expect(result.emittedEvents).toBeUndefined();
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].output).toBe(result.result);
      expect(emit).toHaveBeenLastCalledWith(
        "tool.failed",
        expect.objectContaining({ code: "timeout" }),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("classifies a parent abort before the timer as cancelled", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const module = tool({
      name: call.name,
      description: "Wait for cancellation.",
      parameters: z.object({}),
      timeoutMs: 20,
      execute: async () => {
        entered.resolve();
        await release.promise;
        return {};
      },
    });
    const executor = createToolExecutor({ findTool: () => module });
    try {
      const running = executor.execute(call, {
        ...identity,
        signal: controller.signal,
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(19);
      controller.abort(new Error("parent cancelled"));
      const result = await running;
      expect(JSON.parse(result.result).error.code).toBe("cancelled");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
      await executor.close();
      vi.useRealTimers();
    }
  });

  it("revokes timed-out reads, discards late writes and retains callback ownership", async () => {
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let retained: ToolExecutionContext | undefined;
    const module = tool({
      name: call.name,
      description: "Return writes too late.",
      parameters: z.object({}),
      timeoutMs: 20,
      execute: async (_args, context) => {
        retained = context;
        entered.resolve();
        await release.promise;
        return withEmittedEvents(
          withPendingProposals({ ok: true }, [proposal]),
          [{ topic: "test.done", data: {} }],
        );
      },
    });
    const store = createMemoryStore();
    const save = vi.spyOn(store, "saveToolCall");
    const executor = createToolExecutor({ store, findTool: () => module });
    try {
      const running = executor.execute(call, identity);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20);
      const result = await running;
      expect(JSON.parse(result.result).error.code).toBe("timeout");
      expect(result.pendingProposals).toBeUndefined();
      expect(result.emittedEvents).toBeUndefined();
      await expect(retained?.store?.getSession()).rejects.toThrow("timed out");
      let closed = false;
      const closing = executor.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release.resolve();
      await closing;
      expect(save).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await executor.close();
      vi.useRealTimers();
    }
  });

  it.each(["proposals", "events"])(
    "rejects read-only tools returning %s before recording success",
    async (kind) => {
      const store = createMemoryStore();
      const save = vi.spyOn(store, "saveToolCall");
      const emit = vi.fn(async (_type: string, _payload: unknown) => {});
      const module = tool({
        name: call.name,
        description: "Incorrectly annotated read.",
        parameters: z.object({}),
        annotations: { readOnly: true },
        execute: async () =>
          kind === "proposals"
            ? withPendingProposals({ ok: true }, [proposal])
            : withEmittedEvents({ ok: true }, [
                { topic: "test.done", data: {} },
              ]),
      });
      const executor = createToolExecutor({ store, findTool: () => module });
      const result = await executor.execute(call, {
        ...identity,
        emitter: { emit } as unknown as TurnEmitter,
      });
      expect(result.success).toBe(false);
      expect(JSON.parse(result.result)).toMatchObject({
        error: {
          code: "internal",
          message: expect.stringContaining("read-only tool returned writes"),
        },
      });
      expect(result.pendingProposals).toBeUndefined();
      expect(result.emittedEvents).toBeUndefined();
      expect(save).toHaveBeenCalledOnce();
      expect(save.mock.calls[0]?.[0].output).toBe(result.result);
      expect(emit.mock.calls.map(([type]) => type)).toEqual([
        "tool.calling",
        "tool.failed",
      ]);
    },
  );

  it.each([false, true])(
    "clears the timer when work settles first (throws: %s)",
    async (throws) => {
      vi.useFakeTimers();
      try {
        const module = tool({
          name: call.name,
          description: "Finish before timeout.",
          parameters: z.object({}),
          timeoutMs: 20,
          execute: async () => {
            if (throws) throw new Error("business failure");
            return {};
          },
        });
        const executor = createToolExecutor({ findTool: () => module });
        const result = await executor.execute(call, identity);
        expect(result.success).toBe(!throws);
        if (throws)
          expect(JSON.parse(result.result).error.code).toBe("internal");
        expect(vi.getTimerCount()).toBe(0);
        await executor.close();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("exposes resolved annotations and timeout through getToolInfo", () => {
    const module = tool({
      name: call.name,
      description: "Safe read.",
      parameters: z.object({}),
      annotations: { readOnly: true, concurrencySafe: true, idempotent: true },
      timeoutMs: 20,
      execute: async () => ({}),
    });
    const executor = createToolExecutor({ findTool: () => module });
    expect(executor.getToolInfo(call.name, identity)).toEqual({
      name: module.name,
      description: module.description,
      jsonSchema: module.jsonSchema,
      annotations: module.annotations,
      timeoutMs: 20,
    });
  });
});

describe("tool execution context", () => {
  it("gives the tool the session's language", async () => {
    // A tool that stores text needs the language to store it in. Without it,
    // tools stored a pair of both languages, and the pair went into prompts.
    let seen: ToolExecutionContext | undefined;
    const module = tool({
      name: call.name,
      description: "Synthetic builtin",
      parameters: z.object({}),
      async execute(_args, context) {
        seen = context;
        return { ok: true };
      },
    });
    const executor = createToolExecutor({
      store: createMemoryStore(),
      findTool: () => module,
    });

    await executor.execute(call, { ...identity, locale: "en-US" });
    expect(seen?.locale).toBe("en-US");

    await executor.execute(call, identity);
    expect(seen).not.toHaveProperty("locale");
  });

  it("gives the tool its plugin's translations", async () => {
    let seen: ToolExecutionContext | undefined;
    const module = tool({
      name: call.name,
      description: "Synthetic builtin",
      parameters: z.object({}),
      async execute(_args, context) {
        seen = context;
        return { ok: true };
      },
    });
    const executor = createToolExecutor({
      store: createMemoryStore(),
      findTool: () => module,
    });
    const messages = {
      translations: { Success: "成功" },
      labels: { Success: { zh: "成功" } },
    };

    await executor.execute(call, { ...identity, locale: "zh-CN", messages });
    expect(seen?.messages).toBe(messages);
  });
});

describe("tool executor ownership", () => {
  it.each([false, true])(
    "returns cancellation and retains late callback ownership (reject: %s)",
    async (rejectLate) => {
      const store = createMemoryStore();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const controller = new AbortController();
      let retained: ToolExecutionContext | undefined;
      const read = vi.spyOn(store, "listCharacters");
      const module = tool({
        name: call.name,
        description: "Synthetic builtin",
        parameters: z.object({}),
        async execute(_args, context) {
          retained = context;
          entered.resolve();
          await release.promise;
          await store.listCharacters(identity.sessionId);
          if (rejectLate) throw new Error("late callback failure");
          return withPendingProposals({ late: true }, [
            {
              id: "late",
              type: "plugin.data",
              sessionId: identity.sessionId,
              turnId: identity.turnId,
              source: {
                pluginId: identity.pluginId,
                runtimeId: identity.runtimeId,
              },
              timestamp: "2026-09-19T00:00:00.000Z",
              payload: { namespace: "test", key: "late", value: true },
            },
          ]);
        },
      });
      const executor = createToolExecutor({ store, findTool: () => module });
      let settled = false;
      const running = executor
        .execute(call, { ...identity, signal: controller.signal })
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await entered.promise;
        controller.abort(new Error("cancelled probe"));
        await vi.waitFor(() => expect(settled).toBe(true));
        const result = await running;
        expect(result).toMatchObject({ success: false, parsedResult: null });
        expect(JSON.parse(result.result).error.code).toBe("cancelled");
        expect(result.pendingProposals).toBeUndefined();
        await expect(retained!.store!.getSession()).rejects.toThrow(
          "cancelled probe",
        );
        let closed = false;
        const closing = executor.close();
        expect(executor.close()).toBe(closing);
        void closing.then(() => {
          closed = true;
        });
        await Promise.resolve();
        expect(closed).toBe(false);
        expect(read).not.toHaveBeenCalled();
        release.resolve();
        await closing;
        expect(read).toHaveBeenCalledOnce();
        await expect(executor.execute(call, identity)).rejects.toThrow(
          "closed",
        );
      } finally {
        release.resolve();
        await running;
      }
    },
  );

  it("close cancels calls without a caller signal and owns forgotten reads", async () => {
    const store = createMemoryStore();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(store, "getSession").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return null;
    });
    const module = tool({
      name: call.name,
      description: "Synthetic tool",
      parameters: z.object({}),
      async execute(_args, context) {
        void context.store!.getSession();
        return { done: true };
      },
    });
    const executor = createToolExecutor({ store, findTool: () => module });
    const running = executor.execute(call, identity);
    try {
      await entered.promise;
      let closed = false;
      const closing = executor.close();
      void closing.then(() => {
        closed = true;
      });
      const result = await running;
      expect(result.success).toBe(false);
      expect(JSON.parse(result.result).error.code).toBe("cancelled");
      expect(closed).toBe(false);
      release.resolve();
      await closing;
    } finally {
      release.resolve();
      await running;
    }
  });
});

describe("tool result acceptance", () => {
  it.each(["record", "tool.completed"])(
    "does not revoke accepted work when cancellation arrives during %s",
    async (stage) => {
      const controller = new AbortController();
      const store = createMemoryStore();
      const save = vi
        .spyOn(store, "saveToolCall")
        .mockImplementation(async () => {
          if (stage === "record") controller.abort();
        });
      const events: string[] = [];
      const emitter = {
        emit: async (type: string) => {
          events.push(type);
          if (stage === type) controller.abort();
        },
      } as unknown as TurnEmitter;
      const module = tool({
        name: "probe",
        description: "fixture",
        parameters: z.object({}),
        execute: async () => ({ ok: true }),
      });
      const executor = createToolExecutor({ store, findTool: () => module });
      const result = await executor.execute(call, {
        ...identity,
        signal: controller.signal,
        emitter,
      });
      expect(result.success).toBe(true);
      expect(save).toHaveBeenCalledOnce();
      expect(events).toEqual(["tool.calling", "tool.completed"]);
    },
  );

  it("records only cancellation when the tool aborts before acceptance", async () => {
    const controller = new AbortController();
    const store = createMemoryStore();
    const save = vi.spyOn(store, "saveToolCall");
    const events: string[] = [];
    const emitter = {
      emit: async (type: string) => {
        events.push(type);
      },
    } as unknown as TurnEmitter;
    const module = tool({
      name: "probe",
      description: "fixture",
      parameters: z.object({}),
      execute: async () => {
        controller.abort();
        return { ok: true };
      },
    });
    const result = await createToolExecutor({
      store,
      findTool: () => module,
    }).execute(call, { ...identity, signal: controller.signal, emitter });
    expect(result.success).toBe(false);
    expect(JSON.parse(result.result).error.code).toBe("cancelled");
    expect(save).toHaveBeenCalledOnce();
    expect(events).toEqual(["tool.calling", "tool.failed"]);
  });

  it.each(["tool.calling", "tool.completed", "domain-event.previewed"])(
    "keeps proposals when %s telemetry throws",
    async (failedEvent) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const store = createMemoryStore();
      const save = vi.spyOn(store, "saveToolCall");
      const events: string[] = [];
      const emitter = {
        emit: async (type: string) => {
          events.push(type);
          if (type === failedEvent) throw new Error("trace unavailable");
        },
      } as unknown as TurnEmitter;
      const module = tool({
        name: "probe",
        description: "fixture",
        parameters: z.object({}),
        execute: async () =>
          withEmittedEvents(
            withPendingProposals({ ok: true }, [
              {
                type: "plugin.data",
                payload: { namespace: "test", key: "result", value: true },
              },
            ] as never),
            [{ topic: "test.done", data: {} }],
          ),
      });
      try {
        const result = await createToolExecutor({
          store,
          findTool: () => module,
        }).execute(call, { ...identity, emitter });
        expect(result.success).toBe(true);
        expect(result.pendingProposals).toHaveLength(1);
        expect(result.emittedEvents).toHaveLength(1);
        expect(save).toHaveBeenCalledOnce();
        expect(events).toEqual([
          "tool.calling",
          "tool.completed",
          "domain-event.previewed",
        ]);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    },
  );
});
