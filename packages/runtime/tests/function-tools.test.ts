import { describe, expect, it, vi } from "vitest";
import type { FunctionStoreView } from "@covel/shared/plugin-runtime";
import type { FunctionHandler } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store/memory";
import {
  createCharacterTools,
  getPendingProposals,
  tool,
  type ToolModule,
} from "@covel/tools";
import { z } from "zod";
import type { Proposal, RuntimeManifest, Seat, TurnInput } from "@covel/shared";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import { createToolExecutor } from "../src/agent-loop/tool-executor.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
import { createRuntimeTools } from "../src/function-runtime/runtime-tools.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

const manifest: RuntimeManifest = {
  name: "community/create",
  pluginId: "community",
  description: "Fixture",
  runtimeType: "function",
  stage: "setup",
  trigger: { type: "auto" },
  tools: { builtin: ["create-character", "list-characters"] },
};
const input = {
  sessionId: "session",
  turnId: "turn",
  origin: "player" as const,
  playerMessage: "Begin",
};

async function fixture(
  handler: FunctionHandler,
  options: {
    runtime?: RuntimeManifest;
    phase?: "setup" | "playing";
    completedPlayerTurns?: number;
    origin?: TurnInput["origin"];
    extraTools?: ToolModule[];
    seats?: Seat[];
  } = {},
) {
  const runtime = options.runtime ?? manifest;
  const store = createMemoryStore();
  await store.createSession({
    locale: "en-US",
    updatedAt: "2026-01-01T00:00:00.000Z",
    id: input.sessionId,
    status: "active",
    phase: options.phase ?? "setup",
    completedPlayerTurns: options.completedPlayerTurns ?? 0,
    setupRuntimes: {},
    seats: options.seats ?? [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["community"],
    createdAt: new Date().toISOString(),
  });
  const tools = [...createCharacterTools(store), ...(options.extraTools ?? [])];
  const deps = {
    store,
    loadRuntime: async () => ({
      manifest: runtime,
      promptTemplate: "",
      handler,
    }),
    llm: {
      generate: vi.fn(async () => {
        throw new Error("No LLM expected");
      }),
    },
    getPluginSource: () => "community" as const,
    toolExecutor: createToolExecutor({
      findTool: (name) => tools.find((tool) => tool.name === name),
      getToolSource: () => "builtin",
    }),
  };
  const result = await runTurnPipeline(
    { ...input, origin: options.origin ?? input.origin },
    [runtime],
    deps,
  );
  expect(deps.llm.generate).not.toHaveBeenCalled();
  expect(await store.listCharacters(input.sessionId)).toHaveLength(0);
  return { store, result, runtime };
}

async function commit(
  f: Awaited<ReturnType<typeof fixture>>,
  failCommit = false,
) {
  return finalizeExecution({
    turnIds: [input.turnId],
    store: f.store,
    sessionId: input.sessionId,
    runtimes: [f.runtime],
    results: f.result.runtimeResults,
    executionContext: {
      executionId: "execution",
      origin: "player",
      countPolicy: "none",
    },
    ...(failCommit
      ? {
          extraInTx: async () => {
            throw new Error("Commit interrupted");
          },
        }
      : {}),
  });
}

describe("governed function tools", () => {
  it("deduplicates a sync batch through the real executor with a world snapshot", async () => {
    let output: unknown;
    const f = await fixture(
      async (ctx) => {
        expect(ctx.world).toBeDefined();
        output = await ctx.tools!.call("sync-characters", {
          creates: [
            { name: "New NPC", type: "npc" },
            { name: "New NPC", type: "npc" },
          ],
        });
        return { outcome: "success", value: {} };
      },
      { runtime: { ...manifest, tools: { builtin: ["sync-characters"] } } },
    );
    expect(f.result.runtimeResults[0]?.status).toBe("success");
    expect(output).toMatchObject({
      created: [{ name: "New NPC" }],
      unchanged: [{ name: "New NPC" }],
    });
    expect(f.result.runtimeResults[0]?.pendingProposals).toHaveLength(1);
    await commit(f);
    expect(await f.store.listCharacters(input.sessionId)).toHaveLength(1);
  });

  it("rejects invalid governed calls with a coded error and a plain message", async () => {
    let caught: unknown;
    await fixture(async (ctx) => {
      await ctx.tools!.call("create-character", {}).catch((error: unknown) => {
        caught = error;
      });
      return { outcome: "success", value: {} };
    });
    expect(caught).toMatchObject({ name: "ToolError", code: "invalid-input" });
    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error)
      expect(caught.message.startsWith("{")).toBe(false);
  });

  it("fails and commits no buffered effects when a missing-character update is caught", async () => {
    let caught: unknown;
    const f = await fixture(
      async (ctx) => {
        await ctx.pluginData!.set("audit", "created", true);
        await ctx.tools!.call("create-character", {
          name: "Ada",
          type: "player",
        });
        await ctx
          .tools!.call("update-character", { id: "missing", fields: { hp: 1 } })
          .catch((error: unknown) => {
            caught = error;
          });
        return { outcome: "success", value: {} };
      },
      {
        runtime: {
          ...manifest,
          tools: { builtin: ["create-character", "update-character"] },
        },
      },
    );
    expect(f.result.runtimeResults[0]?.status).toBe("failed");
    expect(caught).toBeInstanceOf(Error);
    expect(f.result.runtimeResults[0]?.error).toContain("not found");
    expect(f.result.runtimeResults[0]?.pendingProposals ?? []).toEqual([]);
    await commit(f);
    expect(await f.store.listCharacters(input.sessionId)).toEqual([]);
    expect(
      await f.store.getPluginData(
        input.sessionId,
        "community",
        "audit",
        "created",
      ),
    ).toBeNull();
  });

  it.each([
    {
      name: "normal",
      phase: "playing" as const,
      stage: "narrative" as const,
      completedPlayerTurns: 7,
      origin: "player" as const,
      expected: 8,
    },
    {
      name: "setup",
      phase: "setup" as const,
      stage: "setup" as const,
      completedPlayerTurns: 0,
      origin: "player" as const,
      expected: 1,
    },
    {
      name: "opening",
      phase: "playing" as const,
      stage: "narrative" as const,
      completedPlayerTurns: 0,
      origin: "continuation" as const,
      expected: 1,
    },
  ])(
    "forwards the frozen logicalTurn to function tools ($name)",
    async ({ phase, stage, completedPlayerTurns, origin, expected }) => {
      let handlerTurn: number | undefined;
      let toolTurn: number | undefined;
      const probe = tool({
        name: "turn-probe",
        description: "Inspect frozen turn",
        parameters: z.object({}),
        async execute(_args, context) {
          toolTurn = context.logicalTurn;
          return {};
        },
      });
      const f = await fixture(
        async (ctx) => {
          handlerTurn = ctx.logicalTurn;
          await ctx.tools!.call("turn-probe", {});
          return { outcome: "success", value: {} };
        },
        {
          phase,
          completedPlayerTurns,
          origin,
          runtime: { ...manifest, stage, tools: { builtin: ["turn-probe"] } },
          extraTools: [probe],
        },
      );
      expect(f.result.runtimeResults[0]?.status).toBe("success");
      expect(handlerTurn).toBe(expected);
      expect(toolTurn).toBe(handlerTurn);
    },
  );

  it("shows the stored seats to the handler's ctx.world and a tool's context.world", async () => {
    const seats: Seat[] = [
      {
        id: "main",
        controller: "human",
        role: "player",
        characters: "auto",
        currentCharacterId: "char-lin",
      },
      { id: "guest", controller: "empty", role: "spectator", characters: [] },
    ];
    let handlerSeats: unknown;
    let toolSeats: unknown;
    const probe = tool({
      name: "seat-probe",
      description: "Inspect seats",
      parameters: z.object({}),
      async execute(_args, context) {
        toolSeats = context.world?.seats;
        return {};
      },
    });
    const f = await fixture(
      async (ctx) => {
        handlerSeats = ctx.world?.seats;
        await ctx.tools!.call("seat-probe", {});
        return { outcome: "success", value: {} };
      },
      {
        seats,
        runtime: { ...manifest, tools: { builtin: ["seat-probe"] } },
        extraTools: [probe],
      },
    );
    expect(f.result.runtimeResults[0]?.status).toBe("success");
    expect(handlerSeats).toEqual(seats);
    expect(toolSeats).toEqual(seats);
    expect(Object.isFrozen(handlerSeats)).toBe(true);
    expect((await f.store.getSession(input.sessionId))?.seats).toEqual(seats);
  });

  it.each(["blocked", "unavailable"] as const)(
    "rejects %s calls with a coded error and keeps the failure latched",
    async (mode) => {
      const hooks = createHookPipeline();
      hooks.register({
        id: "block",
        event: "PreToolUse",
        handler: async () => ({
          action: "abort",
          reason: "Player input is required",
        }),
      });
      const execute = vi.fn(async () => ({}));
      const command = tool({
        name: "list-characters",
        description: "Probe",
        parameters: z.object({}),
        execute,
      });
      const executor = createToolExecutor({ findTool: () => command });
      const bound = createRuntimeTools({
        manifest,
        context: {
          ...input,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
        },
        buffer: [],
        signal: new AbortController().signal,
        assertLive() {},
        deps: {
          loadRuntime: async () => ({ manifest, promptTemplate: "" }),
          llm: {
            generate: async () => {
              throw new Error("unused");
            },
          },
          ...(mode === "blocked"
            ? { toolExecutor: executor, hookPipeline: hooks }
            : {}),
        },
      });
      try {
        let caught: unknown;
        await bound.tools
          .call("list-characters", {})
          .catch((error: unknown) => {
            caught = error;
          });
        expect(caught).toMatchObject({
          name: "ToolError",
          code: mode === "blocked" ? "refused" : "unavailable",
          message:
            mode === "blocked"
              ? "Player input is required"
              : "Tool executor is unavailable",
        });
        expect(caught).toBeInstanceOf(Error);
        await expect(bound.drain()).rejects.toBe(caught);
        await expect(bound.tools.call("list-characters", {})).rejects.toBe(
          caught,
        );
        expect(execute).not.toHaveBeenCalled();
        expect(bound.records).toEqual([]);
        expect(bound.events).toEqual([]);
      } finally {
        await executor.close();
      }
    },
  );

  describe("coded rejections raised before or around the executor", () => {
    function bindProbe(hookPipeline?: ReturnType<typeof createHookPipeline>) {
      const execute = vi.fn(async () => ({ ok: true }));
      const command = tool({
        name: "list-characters",
        description: "Probe",
        parameters: z.object({}),
        execute,
      });
      const executor = createToolExecutor({ findTool: () => command });
      const bound = createRuntimeTools({
        manifest,
        context: {
          ...input,
          pluginId: manifest.pluginId,
          runtimeId: manifest.name,
        },
        buffer: [],
        signal: new AbortController().signal,
        assertLive() {},
        deps: {
          loadRuntime: async () => ({ manifest, promptTemplate: "" }),
          llm: {
            generate: async () => {
              throw new Error("unused");
            },
          },
          toolExecutor: executor,
          ...(hookPipeline ? { hookPipeline } : {}),
        },
      });
      return { bound, execute, executor };
    }

    it("rejects arguments that cannot be serialized with invalid-input and latches the failure", async () => {
      const { bound, execute, executor } = bindProbe();
      try {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        let caught: unknown;
        await bound.tools
          .call("list-characters", circular)
          .catch((error: unknown) => {
            caught = error;
          });
        expect(caught).toMatchObject({
          name: "ToolError",
          code: "invalid-input",
        });
        expect(caught).toBeInstanceOf(Error);
        if (caught instanceof Error) {
          expect(caught.message).toContain("JSON-serializable");
          expect(caught.message.startsWith("{")).toBe(false);
        }
        await expect(bound.drain()).rejects.toBe(caught);
        expect(execute).not.toHaveBeenCalled();
        expect(bound.records).toEqual([]);
      } finally {
        await executor.close();
      }
    });

    it("rejects an argument value with no JSON form with invalid-input", async () => {
      const { bound, execute, executor } = bindProbe();
      try {
        await expect(
          bound.tools.call(
            "list-characters",
            (() => undefined) as unknown as Record<string, unknown>,
          ),
        ).rejects.toMatchObject({ name: "ToolError", code: "invalid-input" });
        expect(execute).not.toHaveBeenCalled();
      } finally {
        await executor.close();
      }
    });

    it("rejects calls queued after a PostToolUse termination with cancelled", async () => {
      const hooks = createHookPipeline();
      hooks.register({
        id: "stop",
        event: "PostToolUse",
        handler: async () => ({
          action: "continue",
          replace: { terminate: true },
        }),
      });
      const { bound, execute, executor } = bindProbe(hooks);
      try {
        const first = bound.tools.call("list-characters", {});
        const second = bound.tools.call("list-characters", {});
        await expect(first).resolves.toEqual({ ok: true });
        let caught: unknown;
        await second.catch((error: unknown) => {
          caught = error;
        });
        expect(caught).toMatchObject({
          name: "ToolError",
          code: "cancelled",
          message: "Tool calls were terminated by PostToolUse",
        });
        expect(caught).toBeInstanceOf(Error);
        await expect(bound.drain()).rejects.toBe(caught);
        expect(execute).toHaveBeenCalledOnce();
      } finally {
        await executor.close();
      }
    });

    it("rejects a hook rewrite that is not JSON with the executor's invalid-input code", async () => {
      const hooks = createHookPipeline();
      hooks.register({
        id: "garble",
        event: "PreToolUse",
        handler: async () => ({
          action: "continue",
          replace: { toolCall: { arguments: "{not json" } },
        }),
      });
      const { bound, execute, executor } = bindProbe(hooks);
      try {
        await expect(
          bound.tools.call("list-characters", {}),
        ).rejects.toMatchObject({ name: "ToolError", code: "invalid-input" });
        expect(execute).not.toHaveBeenCalled();
        expect(bound.records).toHaveLength(1);
        expect(bound.records[0]?.input).toBe("{not json");
      } finally {
        await executor.close();
      }
    });
  });

  it("keeps logicalTurn absent for a thin host that does not supply a clock", async () => {
    const observed = vi.fn();
    const command = tool({
      name: "list-characters",
      description: "Probe",
      parameters: z.object({}),
      async execute(_args, context) {
        observed(context);
        return {};
      },
    });
    const bound = createRuntimeTools({
      manifest,
      context: {
        ...input,
        pluginId: manifest.pluginId,
        runtimeId: manifest.name,
      },
      buffer: [],
      signal: new AbortController().signal,
      assertLive() {},
      deps: {
        loadRuntime: async () => ({ manifest, promptTemplate: "" }),
        llm: {
          generate: async () => {
            throw new Error("unused");
          },
        },
        toolExecutor: createToolExecutor({ findTool: () => command }),
      },
    });
    await bound.tools.call("list-characters", {});
    await bound.drain();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]![0]).not.toHaveProperty("logicalTurn");
  });
  it("passes handler cancellation into tools and drops late buffered writes", async () => {
    const controller = new AbortController();
    const buffer: Proposal[] = [];
    const command = tool({
      name: "list-characters",
      description: "Fixture",
      parameters: z.object({}),
      async execute(_args, context) {
        expect(context.signal?.aborted).toBe(false);
        controller.abort(new Error("handler cancelled"));
        expect(context.signal?.aborted).toBe(true);
        return { late: true };
      },
    });
    const bound = createRuntimeTools({
      manifest,
      context: { ...input, pluginId: "community", runtimeId: manifest.name },
      buffer,
      signal: controller.signal,
      assertLive: () => controller.signal.throwIfAborted(),
      deps: {
        loadRuntime: async () => ({ manifest, promptTemplate: "" }),
        llm: {
          generate: async () => {
            throw new Error("unused");
          },
        },
        toolExecutor: createToolExecutor({ findTool: () => command }),
      },
    });
    await expect(bound.tools.call("list-characters", {})).rejects.toThrow(
      "handler cancelled",
    );
    await expect(bound.drain()).rejects.toThrow("handler cancelled");
    expect(buffer).toEqual([]);
  });
  it("shares buffered plugin data with the community store view without early persistence", async () => {
    let observed: unknown;
    const f = await fixture(async (ctx) => {
      await ctx.pluginData!.set("audit", "created", { ready: true });
      const view = ctx.store as FunctionStoreView;
      observed = await view.getPluginData("audit", "created");
      return { outcome: "success", value: {} };
    });
    expect(f.result.runtimeResults[0]?.status).toBe("success");
    expect(observed).toMatchObject({ value: { ready: true } });
    expect(
      await f.store.getPluginData(
        input.sessionId,
        "community",
        "audit",
        "created",
      ),
    ).toBeNull();
    await commit(f);
    expect(
      await f.store.getPluginData(
        input.sessionId,
        "community",
        "audit",
        "created",
      ),
    ).toMatchObject({ value: { ready: true } });
  });

  it("rolls character and plugin data back together when finalization fails", async () => {
    const f = await fixture(async (ctx) => {
      await ctx.tools!.call("create-character", {
        name: "Ada",
        type: "player",
      });
      await ctx.pluginData!.set("audit", "created", true);
      return { outcome: "success", value: {} };
    });
    await commit(f, true);
    expect(await f.store.listCharacters(input.sessionId)).toHaveLength(0);
    expect(
      await f.store.getPluginData(
        input.sessionId,
        "community",
        "audit",
        "created",
      ),
    ).toBeNull();
  });
  it("reads buffered tool writes and commits them with plugin data exactly once", async () => {
    const f = await fixture(async (ctx) => {
      const created = await ctx.tools!.call("create-character", {
        name: "Ada",
        type: "player",
        fields: { strength: 3 },
      });
      const listed = await ctx.tools!.call("list-characters", {
        type: "player",
      });
      expect(listed).toMatchObject({
        count: 1,
        characters: [expect.objectContaining({ name: "Ada" })],
      });
      await ctx.pluginData!.set("audit", "created", created);
      return { outcome: "success", completion: "done", value: { ready: true } };
    });
    expect(f.result.runtimeResults[0]?.status).toBe("success");
    expect(f.result.runtimeResults[0]?.toolCalls).toHaveLength(2);
    await commit(f);
    expect(await f.store.listCharacters(input.sessionId)).toHaveLength(1);
    expect(
      await f.store.getPluginData(
        input.sessionId,
        "community",
        "audit",
        "created",
      ),
    ).not.toBeNull();
  });

  it.each(["throw", "unauthorized", "invalid", "bigint", "cycle"])(
    "discards all buffered writes on %s",
    async (mode) => {
      const f = await fixture(async (ctx) => {
        await ctx.tools!.call("create-character", {
          name: "Ada",
          type: "player",
        });
        await ctx.pluginData!.set("audit", "created", true);
        if (mode === "throw") throw new Error("Abort after write");
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        // Swallowing a failed command must not accidentally commit an earlier write.
        await ctx
          .tools!.call(
            mode === "unauthorized" ? "update-character" : "create-character",
            mode === "bigint" ? { value: 1n } : mode === "cycle" ? cyclic : {},
          )
          .catch(() => {});
        return { outcome: "success", value: {} };
      });
      expect(f.result.runtimeResults[0]?.status).toBe("failed");
      expect(
        getPendingProposals(f.result.runtimeResults[0]?.output),
      ).toHaveLength(0);
      await commit(f);
      expect(await f.store.listCharacters(input.sessionId)).toHaveLength(0);
      expect(
        await f.store.getPluginData(
          input.sessionId,
          "community",
          "audit",
          "created",
        ),
      ).toBeNull();
    },
  );

  it("checks authorization after hook rewrites and revokes escaped handles", async () => {
    const hooks = createHookPipeline();
    hooks.register({
      id: "rewrite",
      event: "PreToolUse",
      handler: async () => ({
        action: "continue",
        replace: { toolCall: { name: "secret" } },
      }),
    });
    const execute = vi.fn(async () => ({}));
    const secret = tool({
      name: "secret",
      description: "Secret",
      parameters: z.object({}),
      execute,
    });
    let revoked = false;
    const bound = createRuntimeTools({
      manifest,
      context: { ...input, pluginId: "community", runtimeId: manifest.name },
      buffer: [],
      signal: new AbortController().signal,
      assertLive() {
        if (revoked) throw new Error("revoked");
      },
      deps: {
        loadRuntime: async () => ({ manifest, promptTemplate: "" }),
        llm: {
          generate: async () => {
            throw new Error("unused");
          },
        },
        hookPipeline: hooks,
        toolExecutor: createToolExecutor({ findTool: () => secret }),
      },
    });
    await expect(bound.tools.call("list-characters", {})).rejects.toMatchObject(
      { name: "ToolError", code: "unavailable" },
    );
    expect(execute).not.toHaveBeenCalled();
    revoked = true;
    expect(() => bound.tools.call("create-character", {})).toThrow("revoked");
  });
});
