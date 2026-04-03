/**
 * Integration tests for the full tool call lifecycle.
 *
 * Validates the complete flow: registration → hook guard → execution → proposal collection.
 * Uses real registry instances (not mocks) to test actual wiring.
 */

import { describe, it, expect, vi } from "vitest";
import { executeTool } from "../src/tools/tool-executor.js";
import {
  createToolRegistry,
  createHookRegistry,
  createPluginRegistry,
  createSessionPluginScope,
  createScopedToolRegistry,
  createScopedHookRegistry,
} from "@covel/plugin-runtime";
import type { ToolExecutionContext, PluginManifest } from "@covel/shared";

// ── Helpers ─────────────────────────────────────────────────────

function makeManifest(id: string): PluginManifest {
  return {
    schemaVersion: "1.0",
    id,
    displayName: id,
    version: "0.1.0",
    author: "test",
    description: `${id} test plugin`,
    defaultLocale: "zh-CN",
    supportedLocales: ["zh-CN"],
  };
}

function makeToolCallRequest(
  qualifiedToolId: string,
  overrides?: Partial<Parameters<typeof executeTool>[1]>,
) {
  const [pluginId] = qualifiedToolId.split(":");
  return {
    qualifiedToolId,
    input: {},
    runtimeId: "main-runtime",
    pluginId: pluginId ?? "test-plugin",
    locale: "zh-CN",
    ...overrides,
  };
}

// ── Tool Registration & Resolution ──────────────────────────────

describe("Tool Registration & Resolution", () => {
  /** Verify that a registered tool is findable by its qualified ID (pluginId:toolId). */
  it("registers a tool and finds it by qualified ID", () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "inventory",
      { id: "list-items", kind: "query" },
      async () => ({ output: [] }),
    );

    const tool = toolRegistry.getByQualifiedId("inventory:list-items");
    expect(tool).toBeDefined();
    expect(tool!.pluginId).toBe("inventory");
    expect(tool!.definition.id).toBe("list-items");
    expect(tool!.definition.kind).toBe("query");
  });

  /** Verify that tools from multiple plugins coexist with distinct qualified IDs. */
  it("registers tools from multiple plugins without collision", () => {
    const toolRegistry = createToolRegistry();

    toolRegistry.register(
      "combat",
      { id: "attack", kind: "mutate" },
      async () => ({ output: { damage: 5 } }),
    );
    toolRegistry.register(
      "inventory",
      { id: "add-item", kind: "mutate" },
      async () => ({ output: { added: true } }),
    );
    toolRegistry.register(
      "quest",
      { id: "check-progress", kind: "query" },
      async () => ({ output: { progress: 0.5 } }),
    );

    expect(toolRegistry.listAll()).toHaveLength(3);
    expect(toolRegistry.getByQualifiedId("combat:attack")).toBeDefined();
    expect(toolRegistry.getByQualifiedId("inventory:add-item")).toBeDefined();
    expect(toolRegistry.getByQualifiedId("quest:check-progress")).toBeDefined();
  });

  /** Same tool ID under different plugins creates distinct qualified IDs (no collision). */
  it("allows same tool ID under different plugins", () => {
    const toolRegistry = createToolRegistry();

    toolRegistry.register(
      "plugin-a",
      { id: "search", kind: "query" },
      async () => ({ output: "result-a" }),
    );
    toolRegistry.register(
      "plugin-b",
      { id: "search", kind: "query" },
      async () => ({ output: "result-b" }),
    );

    expect(toolRegistry.getByQualifiedId("plugin-a:search")).toBeDefined();
    expect(toolRegistry.getByQualifiedId("plugin-b:search")).toBeDefined();
    expect(toolRegistry.listAll()).toHaveLength(2);
  });

  /** Duplicate registration of the same pluginId:toolId throws an error. */
  it("rejects duplicate tool IDs within the same plugin", () => {
    const toolRegistry = createToolRegistry();

    toolRegistry.register(
      "combat",
      { id: "attack", kind: "mutate" },
      async () => ({ output: null }),
    );

    expect(() =>
      toolRegistry.register(
        "combat",
        { id: "attack", kind: "query" },
        async () => ({ output: null }),
      ),
    ).toThrow(/already registered/);
  });
});

// ── Tool Execution Flow ─────────────────────────────────────────

describe("Tool Execution Flow", () => {
  /** A query tool receives input and returns output without proposals. */
  it("executes a simple query tool with input and returns output", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "world",
      { id: "describe-location", kind: "query" },
      async (ctx: ToolExecutionContext) => ({
        output: { name: (ctx.input as { location: string }).location, description: "A dark forest" },
      }),
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("world:describe-location", {
        input: { location: "Dark Forest" },
      }),
    );

    expect(result.blocked).toBe(false);
    expect(result.output).toEqual({ name: "Dark Forest", description: "A dark forest" });
    expect(result.proposals).toHaveLength(0);
  });

  /** A mutate tool returns both output and proposals. */
  it("executes a mutate tool that returns proposals", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "combat",
      { id: "deal-damage", kind: "mutate" },
      async (ctx: ToolExecutionContext) => {
        const amount = (ctx.input as { amount: number }).amount;
        return {
          output: { dealt: amount },
          proposals: [
            { kind: "state.patch", payload: { hp: 100 - amount } },
            { kind: "event.emit", payload: { type: "damage_dealt", amount } },
          ],
        };
      },
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("combat:deal-damage", {
        input: { amount: 25 },
      }),
    );

    expect(result.output).toEqual({ dealt: 25 });
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals[0]).toEqual({
      kind: "state.patch",
      payload: { hp: 75 },
    });
    expect(result.proposals[1]).toEqual({
      kind: "event.emit",
      payload: { type: "damage_dealt", amount: 25 },
    });
  });

  /** Tool handler receives the state snapshot injected via the request. */
  it("executes tool with state context", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const receivedState = vi.fn();

    toolRegistry.register(
      "tracker",
      { id: "check-state", kind: "query" },
      async (ctx: ToolExecutionContext) => {
        receivedState(ctx.state);
        return { output: ctx.state };
      },
    );

    const state = { hp: 80, mp: 50, level: 3 };
    await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("tracker:check-state", { state }),
    );

    expect(receivedState).toHaveBeenCalledWith(state);
  });

  /** Tool handler receives the correct locale from the request. */
  it("executes tool with locale", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const receivedLocale = vi.fn();

    toolRegistry.register(
      "i18n",
      { id: "get-text", kind: "query" },
      async (ctx: ToolExecutionContext) => {
        receivedLocale(ctx.locale);
        return { output: ctx.locale === "en-US" ? "Hello" : "你好" };
      },
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("i18n:get-text", { locale: "en-US" }),
    );

    expect(receivedLocale).toHaveBeenCalledWith("en-US");
    expect(result.output).toBe("Hello");
  });

  /** When a tool handler throws, the error propagates (caller decides error handling). */
  it("propagates error when tool handler throws", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "buggy",
      { id: "crash", kind: "query" },
      async () => {
        throw new Error("Tool internal failure");
      },
    );

    await expect(
      executeTool(
        { toolRegistry, hookRegistry },
        makeToolCallRequest("buggy:crash"),
      ),
    ).rejects.toThrow("Tool internal failure");
  });

  /** When a tool handler exceeds the timeout, it rejects with a timeout error. */
  it("rejects when tool handler exceeds timeout", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "slow",
      { id: "wait", kind: "query" },
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return { output: "done" };
      },
    );

    await expect(
      executeTool(
        { toolRegistry, hookRegistry },
        makeToolCallRequest("slow:wait", { timeoutMs: 50 }),
      ),
    ).rejects.toThrow(/timed out/);
  });

  /** Tool receives raw input even if it is not a well-formed object. */
  it("passes raw input to handler without validation", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const capturedInput = vi.fn();

    toolRegistry.register(
      "raw",
      { id: "echo", kind: "query" },
      async (ctx: ToolExecutionContext) => {
        capturedInput(ctx.input);
        return { output: ctx.input };
      },
    );

    const weirdInput = "just a string, not an object";
    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("raw:echo", { input: weirdInput }),
    );

    expect(capturedInput).toHaveBeenCalledWith(weirdInput);
    expect(result.output).toBe(weirdInput);
  });

  /** Throws a clear error when calling a tool that does not exist. */
  it("throws for unknown tool qualified ID", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    await expect(
      executeTool(
        { toolRegistry, hookRegistry },
        makeToolCallRequest("nonexistent:missing"),
      ),
    ).rejects.toThrow(/not found/);
  });
});

// ── Hook Integration with Tools ─────────────────────────────────

describe("Hook Integration with Tools", () => {
  /** A PreToolUse hook that returns allow=false blocks tool execution entirely. */
  it("PreToolUse hook blocks tool execution", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const toolSpy = vi.fn();

    toolRegistry.register(
      "guarded",
      { id: "action", kind: "mutate" },
      async () => {
        toolSpy();
        return { output: "should not run" };
      },
    );

    hookRegistry.register(
      "guard-plugin",
      { id: "blocker", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: false }),
      100,
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("guarded:action", { input: { dangerous: true } }),
    );

    expect(result.blocked).toBe(true);
    expect(result.output).toBeNull();
    expect(result.proposals).toHaveLength(0);
    expect(toolSpy).not.toHaveBeenCalled();
  });

  /** A PreToolUse hook can rewrite tool input before execution. */
  it("PreToolUse hook modifies tool input", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "target",
      { id: "process", kind: "query" },
      async (ctx: ToolExecutionContext) => ({ output: ctx.input }),
    );

    hookRegistry.register(
      "sanitizer",
      { id: "clean-input", event: "PreToolUse", handlerKind: "command" },
      async (ctx) => ({
        allow: true,
        rewrittenInput: {
          ...(ctx.toolCall?.input as Record<string, unknown>),
          sanitized: true,
          dangerousField: undefined,
        },
      }),
      100,
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("target:process", {
        input: { data: "hello", dangerousField: "<script>" },
      }),
    );

    expect(result.blocked).toBe(false);
    const output = result.output as Record<string, unknown>;
    expect(output.sanitized).toBe(true);
    expect(output.data).toBe("hello");
  });

  /** PostToolUse hook receives the tool output for auditing/logging. */
  it("PostToolUse hook receives tool result", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const postHookSpy = vi.fn();

    toolRegistry.register(
      "data",
      { id: "fetch", kind: "query" },
      async () => ({ output: { items: [1, 2, 3] } }),
    );

    hookRegistry.register(
      "auditor",
      { id: "log-result", event: "PostToolUse", handlerKind: "command" },
      async (ctx) => {
        postHookSpy({
          toolId: ctx.toolCall?.toolId,
          input: ctx.toolCall?.input,
          output: ctx.toolCall?.output,
        });
        return { allow: true };
      },
      100,
    );

    await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("data:fetch", { input: { query: "test" } }),
    );

    expect(postHookSpy).toHaveBeenCalledTimes(1);
    const call = postHookSpy.mock.calls[0][0];
    expect(call.toolId).toBe("data:fetch");
    expect(call.input).toEqual({ query: "test" });
    expect(call.output).toEqual({ items: [1, 2, 3] });
  });

  /** Multiple PreToolUse hooks execute in loadingOrder sequence. */
  it("multiple hooks execute in loadingOrder sequence", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const executionOrder: string[] = [];

    toolRegistry.register(
      "multi",
      { id: "action", kind: "query" },
      async (ctx: ToolExecutionContext) => ({ output: ctx.input }),
    );

    // Register hooks in reverse order to verify sorting
    hookRegistry.register(
      "hook-c",
      { id: "third", event: "PreToolUse", handlerKind: "command" },
      async (ctx) => {
        executionOrder.push("third");
        return { allow: true };
      },
      300,
    );
    hookRegistry.register(
      "hook-a",
      { id: "first", event: "PreToolUse", handlerKind: "command" },
      async (ctx) => {
        executionOrder.push("first");
        return { allow: true };
      },
      100,
    );
    hookRegistry.register(
      "hook-b",
      { id: "second", event: "PreToolUse", handlerKind: "command" },
      async (ctx) => {
        executionOrder.push("second");
        return { allow: true };
      },
      200,
    );

    await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("multi:action"),
    );

    expect(executionOrder).toEqual(["first", "second", "third"]);
  });

  /** A chain of PreToolUse hooks where the second one blocks after the first rewrites. */
  it("hook chain: rewrite then block", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const toolSpy = vi.fn();

    toolRegistry.register(
      "chained",
      { id: "op", kind: "mutate" },
      async () => {
        toolSpy();
        return { output: "reached" };
      },
    );

    hookRegistry.register(
      "rewriter",
      { id: "rw", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: true, rewrittenInput: { rewritten: true } }),
      100,
    );
    hookRegistry.register(
      "blocker",
      { id: "bl", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: false }),
      200,
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("chained:op"),
    );

    expect(result.blocked).toBe(true);
    expect(toolSpy).not.toHaveBeenCalled();
  });

  /**
   * Only hooks with handlerKind "command" are executed by the tool executor.
   * Hooks with other handler kinds (e.g. "prompt") are skipped.
   */
  it("ignores hooks that are not of handlerKind 'command'", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();
    const promptHookSpy = vi.fn();

    toolRegistry.register(
      "p",
      { id: "t", kind: "query" },
      async () => ({ output: "ok" }),
    );

    hookRegistry.register(
      "prompt-hook-plugin",
      { id: "ph", event: "PreToolUse", handlerKind: "prompt" },
      async () => {
        promptHookSpy();
        return { allow: false };
      },
      100,
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      makeToolCallRequest("p:t"),
    );

    // The prompt hook should be skipped — tool executes normally
    expect(result.blocked).toBe(false);
    expect(result.output).toBe("ok");
    expect(promptHookSpy).not.toHaveBeenCalled();
  });
});

// ── Scoped Tool Execution ───────────────────────────────────────

describe("Scoped Tool Execution (session scope filtering)", () => {
  function setupScoped() {
    const pluginReg = createPluginRegistry();
    pluginReg.add(makeManifest("alpha"), "/tmp/alpha");
    pluginReg.add(makeManifest("beta"), "/tmp/beta");

    const toolReg = createToolRegistry();
    toolReg.register(
      "alpha",
      { id: "tool-a", kind: "query" },
      async () => ({ output: "alpha-result" }),
    );
    toolReg.register(
      "beta",
      { id: "tool-b", kind: "mutate" },
      async () => ({
        output: "beta-result",
        proposals: [{ kind: "state.patch", payload: { from: "beta" } }],
      }),
    );

    const hookReg = createHookRegistry();
    hookReg.register(
      "beta",
      { id: "beta-hook", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: true }),
      100,
    );

    return { pluginReg, toolReg, hookReg };
  }

  /** Tools from disabled plugins are not visible through scoped registries. */
  it("scoped registry hides tools from inactive plugins", () => {
    const { pluginReg, toolReg } = setupScoped();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.getByQualifiedId("alpha:tool-a")).toBeDefined();
    expect(scoped.getByQualifiedId("beta:tool-b")).toBeUndefined();
    expect(scoped.listAll()).toHaveLength(1);
  });

  /** Tool execution via scoped registries throws for inactive plugin tools. */
  it("executeTool throws when tool belongs to inactive plugin", async () => {
    const { pluginReg, toolReg, hookReg } = setupScoped();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scopedTools = createScopedToolRegistry(toolReg, scope);
    const scopedHooks = createScopedHookRegistry(hookReg, scope);

    await expect(
      executeTool(
        { toolRegistry: scopedTools, hookRegistry: scopedHooks },
        makeToolCallRequest("beta:tool-b"),
      ),
    ).rejects.toThrow(/not found/);
  });

  /** Enabling a plugin mid-session makes its tools visible immediately. */
  it("re-enabling a plugin restores tool access", async () => {
    const { pluginReg, toolReg, hookReg } = setupScoped();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scopedTools = createScopedToolRegistry(toolReg, scope);
    const scopedHooks = createScopedHookRegistry(hookReg, scope);

    // beta is inactive
    expect(scopedTools.getByQualifiedId("beta:tool-b")).toBeUndefined();

    // Enable beta
    scope.enable("beta");

    expect(scopedTools.getByQualifiedId("beta:tool-b")).toBeDefined();
    const result = await executeTool(
      { toolRegistry: scopedTools, hookRegistry: scopedHooks },
      makeToolCallRequest("beta:tool-b"),
    );
    expect(result.output).toBe("beta-result");
    expect(result.proposals).toHaveLength(1);
  });

  /** Hooks from disabled plugins are not executed during tool calls. */
  it("scoped hooks exclude inactive plugin hooks", async () => {
    const { pluginReg, toolReg, hookReg } = setupScoped();
    const scope = createSessionPluginScope(pluginReg, ["alpha"]);
    const scopedHooks = createScopedHookRegistry(hookReg, scope);

    // beta's PreToolUse hook is filtered out
    const hooks = scopedHooks.getHooksForEvent("PreToolUse");
    expect(hooks).toHaveLength(0);
  });
});
