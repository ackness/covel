import { describe, it, expect } from "vitest";
import { executeTool } from "../src/tools/tool-executor.js";
import { createToolRegistry, createHookRegistry } from "@covel/plugin-runtime";

describe("tool-executor", () => {
  it("executes a tool and returns result", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "my-plugin",
      { id: "greet", kind: "query" },
      async (ctx) => ({ output: `Hello ${(ctx.input as any).name}!` })
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      {
        qualifiedToolId: "my-plugin:greet",
        input: { name: "World" },
        runtimeId: "main",
        pluginId: "my-plugin",
        locale: "en-US",
      }
    );

    expect(result.output).toBe("Hello World!");
    expect(result.proposals).toHaveLength(0);
    expect(result.blocked).toBe(false);
  });

  it("collects proposals from mutate tools", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "combat",
      { id: "attack", kind: "mutate" },
      async () => ({
        output: { damage: 10 },
        proposals: [{ kind: "state.patch", payload: { hp: 90 } }],
      })
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      {
        qualifiedToolId: "combat:attack",
        input: {},
        runtimeId: "main",
        pluginId: "combat",
        locale: "en-US",
      }
    );

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].kind).toBe("state.patch");
  });

  it("blocks execution when PreToolUse hook denies", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "p",
      { id: "t", kind: "query" },
      async () => ({ output: "should not reach" })
    );

    hookRegistry.register(
      "guard",
      { id: "block-hook", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: false }),
      100
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      {
        qualifiedToolId: "p:t",
        input: {},
        runtimeId: "main",
        pluginId: "p",
        locale: "en-US",
      }
    );

    expect(result.blocked).toBe(true);
    expect(result.output).toBeNull();
  });

  it("rewrites input via PreToolUse hook", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    toolRegistry.register(
      "p",
      { id: "t", kind: "query" },
      async (ctx) => ({ output: ctx.input })
    );

    hookRegistry.register(
      "rewriter",
      { id: "rw-hook", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: true, rewrittenInput: { modified: true } }),
      100
    );

    const result = await executeTool(
      { toolRegistry, hookRegistry },
      {
        qualifiedToolId: "p:t",
        input: { original: true },
        runtimeId: "main",
        pluginId: "p",
        locale: "en-US",
      }
    );

    expect(result.output).toEqual({ modified: true });
  });

  it("throws for unknown tools", async () => {
    const toolRegistry = createToolRegistry();
    const hookRegistry = createHookRegistry();

    await expect(
      executeTool(
        { toolRegistry, hookRegistry },
        {
          qualifiedToolId: "unknown:tool",
          input: {},
          runtimeId: "main",
          pluginId: "unknown",
          locale: "en-US",
        }
      )
    ).rejects.toThrow("not found");
  });
});
