import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import {
  tool,
  z,
  withPendingProposals,
  type ToolExecutionContext,
} from "@covel/tools";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";

const identity = {
  sessionId: "session",
  turnId: "turn",
  pluginId: "plugin",
  runtimeId: "plugin/main",
};
const call = { toolCallId: "call", name: "probe", arguments: "{}" };

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
        expect(JSON.parse(result.result).code).toBe("CANCELLED");
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
      expect(JSON.parse(result.result).code).toBe("CANCELLED");
      expect(closed).toBe(false);
      release.resolve();
      await closing;
    } finally {
      release.resolve();
      await running;
    }
  });
});
