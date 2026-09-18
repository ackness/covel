import { describe, expect, it, vi } from "vitest";
import type { FunctionStoreView } from "@covel/shared/plugin-runtime";
import type { FunctionHandler } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { createCharacterTools, getPendingProposals, tool } from "@covel/tools";
import { z } from "zod";
import type { RuntimeManifest } from "@covel/shared";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
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

async function fixture(handler: FunctionHandler) {
  const store = createMemoryStore();
  await store.createSession({
    id: input.sessionId,
    worldId: null,
    status: "active",
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    activePlugins: ["community"],
    createdAt: new Date().toISOString(),
  });
  const tools = createCharacterTools(store, {});
  const deps = {
    store,
    loadRuntime: async () => ({ manifest, promptTemplate: "", handler }),
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
  const result = await executeTurn(input, [manifest], deps);
  expect(deps.llm.generate).not.toHaveBeenCalled();
  expect(await store.listCharacters(input.sessionId)).toHaveLength(0);
  return { store, result };
}

async function commit(
  f: Awaited<ReturnType<typeof fixture>>,
  failCommit = false,
) {
  return finalizeExecution({
    turnIds: [input.turnId],
    store: f.store,
    sessionId: input.sessionId,
    runtimes: [manifest],
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
  it("passes handler cancellation into tools and drops late buffered writes", async () => {
    const controller = new AbortController();
    const buffer = [];
    const command = tool({
      name: "list-characters",
      description: "Fixture",
      parameters: z.object({}),
      async execute(_args, context) {
        expect(context.signal).toBe(controller.signal);
        controller.abort(new Error("handler cancelled"));
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
    await expect(bound.tools.call("list-characters", {})).rejects.toThrow(
      "UNAUTHORIZED",
    );
    expect(execute).not.toHaveBeenCalled();
    revoked = true;
    expect(() => bound.tools.call("create-character", {})).toThrow("revoked");
  });
});
