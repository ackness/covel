/**
 * An agent guard and a function handler receive the same context under the
 * same rules, whatever the plugin's source: a bundled plugin has no
 * capability a community plugin lacks, and a community guard has every
 * capability a community handler has. Source changes only the security rule
 * on outbound HTTP (`permissions.http`).
 */

import { describe, expect, it, vi } from "vitest";
import type {
  ExecutionContext,
  InputSlot,
  RuntimeManifest,
  TurnInput,
  TurnResult,
} from "@covel/shared";
import type {
  FunctionHandlerContext,
  PluginRuntimeGateway,
  PluginRuntimeUtils,
} from "@covel/shared/plugin-runtime";
import type { PluginSource } from "@covel/plugin-loader";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import { executeAgentGuard } from "../src/agent-loop/turn-agent-guard.js";
import { executeFunctionRuntime } from "../src/function-runtime/turn-function-runtime.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";

const SESSION_ID = "sess-guard-parity";
const input: TurnInput = {
  origin: "player",
  sessionId: SESSION_ID,
  turnId: "turn-1",
  playerMessage: "look",
  locale: "en-US",
};
const executionContext: ExecutionContext = {
  executionId: "exec-1",
  origin: "player",
  countPolicy: "none",
};
const nested = async (): Promise<TurnResult> => ({
  sessionId: SESSION_ID,
  turnId: "nested",
  executionContext,
  runtimeResults: [],
  durationMs: 0,
  timestamp: new Date().toISOString(),
});
const inputs: Record<string, InputSlot> = {
  rules: {
    cardinality: "one",
    value: { dc: 12 },
    source: { pluginId: "p", runtimeId: "p/rules", resultId: "r-1" },
  },
};

function gateway(): PluginRuntimeGateway {
  const usage = { inputTokens: 0, outputTokens: 0 };
  return {
    generateText: async () => ({ text: "", finishReason: "stop", usage }),
    generateObject: async <T>() => ({
      object: {} as T,
      finishReason: "stop",
      usage,
    }),
    resolveSlot: () => null,
  };
}

async function deps(source: PluginSource): Promise<TurnExecutorDeps> {
  const store = createMemoryStore();
  const now = new Date().toISOString();
  await store.createSession({
    id: SESSION_ID,
    worldId: "w",
    locale: "en-US",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: ["p"],
    createdAt: now,
    updatedAt: now,
  });
  const utils: PluginRuntimeUtils = {
    validateBaseUrl: () => ({ ok: true }),
    fetchWithRetry: vi.fn(async () => new Response("ok")),
  };
  return {
    loadRuntime: async () => {
      throw new Error("not used");
    },
    llm: {
      generate: async () => ({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    },
    store,
    gateway: gateway(),
    utils,
    mediaStore: createMemoryMediaStore(),
    getPluginSource: () => source,
  };
}

function manifest(runtimeType: "function" | "agent"): RuntimeManifest {
  return {
    name: `p/${runtimeType}`,
    pluginId: "p",
    description: runtimeType,
    stage: "narrative",
    runtimeType,
    trigger: { type: "auto" },
    outputKind: "plugin",
    permissions: { http: [{ origin: "https://allowed.example.com" }] },
  } as RuntimeManifest;
}

const common = {
  input,
  hookPipeline: undefined,
  triggerEvent: undefined,
  inputs,
  executionContext,
  recursionDepth: 0,
  startTime: Date.now(),
  runId: "run-1",
  timeoutMs: 5_000,
};

async function handlerContext(
  source: PluginSource,
): Promise<FunctionHandlerContext> {
  let seen: FunctionHandlerContext | undefined;
  const m = manifest("function");
  await executeFunctionRuntime({
    ...common,
    manifest: m,
    loaded: {
      manifest: m,
      promptTemplate: "",
      handler: async (ctx) => {
        seen = ctx;
        return { outcome: "success", value: {} };
      },
    },
    deps: await deps(source),
    createRecursiveCall: () => nested,
  });
  return seen!;
}

async function guardRun(
  source: PluginSource,
  body: (ctx: FunctionHandlerContext) => Promise<void> = async () => {},
) {
  let seen: FunctionHandlerContext | undefined;
  const recursive = vi.fn(nested);
  const runtimeDeps = await deps(source);
  const m = manifest("agent");
  const result = await executeAgentGuard({
    ...common,
    manifest: m,
    loaded: {
      manifest: m,
      promptTemplate: "",
      guard: async (ctx) => {
        seen = ctx;
        await body(ctx);
        return { skip: true };
      },
    },
    deps: runtimeDeps,
    createRecursiveCall: () => recursive,
  });
  return { context: seen!, result, recursive, utils: runtimeDeps.utils! };
}

describe("agent guard context", () => {
  it.each(["builtin", "community"] as const)(
    "has the fields a %s function handler has",
    async (source) => {
      const handler = await handlerContext(source);
      const { context: guard } = await guardRun(source);
      expect(Object.keys(guard).sort()).toEqual(Object.keys(handler).sort());
    },
  );

  it("is the same for a bundled and a community guard", async () => {
    const { context: builtin } = await guardRun("builtin");
    const { context: community } = await guardRun("community");
    expect(Object.keys(community).sort()).toEqual(Object.keys(builtin).sort());
    expect(Object.keys(community.store).sort()).toEqual(
      Object.keys(builtin.store).sort(),
    );
  });

  it("receives the run's input bindings, frozen", async () => {
    const { context } = await guardRun("community");
    expect(context.inputs).toEqual(inputs);
    expect(Object.isFrozen(context.inputs!.rules)).toBe(true);
  });

  it("lets a community guard start a nested turn and log", async () => {
    const { result, recursive } = await guardRun("community", async (ctx) => {
      await ctx.recursiveCall({ playerMessage: "again" });
      await ctx.logger!.info("ran");
    });
    expect(result?.status).toBe("skipped");
    expect(recursive).toHaveBeenCalledOnce();
  });

  it("holds a community guard's HTTP to its permissions", async () => {
    let denied: unknown;
    const { utils } = await guardRun("community", async (ctx) => {
      await ctx.utils!.fetchWithRetry("https://allowed.example.com/x");
      denied = await ctx
        .utils!.fetchWithRetry("https://other.example.com/x")
        .catch((error: unknown) => error);
    });
    expect(String(denied)).toMatch(/http permission denied/);
    expect(utils.fetchWithRetry).toHaveBeenCalledOnce();
  });
});
