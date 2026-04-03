/**
 * Tests for the PluginRegistrar API from the plugin author's perspective.
 *
 * These tests validate what plugin developers interact with when writing
 * a plugin's `server/index.ts` register() function. Uses inline helpers
 * that mirror the plugin-test-utils patterns.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createPluginRegistry,
  createToolRegistry,
  createHookRegistry,
  createSessionPluginScope,
  createScopedToolRegistry,
  createScopedHookRegistry,
} from "../src/index.js";
import type { PluginManifest, ToolExecutionContext } from "@covel/shared";
import type {
  PluginRegistrar,
  ContributionMap,
  ToolHandler,
  HookHandler,
  RuntimeHandler,
  ContextProvider,
  CommandRegistration,
  HookHandlerContext,
  RuntimeHandlerContext,
  ContextProviderInput,
} from "../src/types.js";

// ── Helpers (inline equivalents of plugin-test-utils) ───────────

function createCollectingRegistrar(): {
  registrar: PluginRegistrar;
  contributions: ContributionMap;
} {
  const contributions: ContributionMap = {
    tools: new Map<string, ToolHandler>(),
    hooks: new Map<string, HookHandler>(),
    contextProviders: new Map<string, ContextProvider>(),
    runtimeHandlers: new Map<string, RuntimeHandler>(),
    commands: [],
  };

  const registrar: PluginRegistrar = {
    addTool(id, handler) { contributions.tools.set(id, handler); },
    addHook(id, handler) { contributions.hooks.set(id, handler); },
    addContextProvider(id, handler) { contributions.contextProviders.set(id, handler); },
    addRuntimeHandler(runtimeId, handler) { contributions.runtimeHandlers.set(runtimeId, handler); },
    addCommand(registration) { contributions.commands.push(registration); },
  };

  return { registrar, contributions };
}

function createMockToolContext(
  overrides?: Partial<ToolExecutionContext>,
): ToolExecutionContext {
  return {
    toolId: "test-tool",
    pluginId: "test-plugin",
    runtimeId: "test-runtime",
    locale: "zh-CN",
    input: {},
    state: {},
    ...overrides,
  } as ToolExecutionContext;
}

function createMockHandlerContext(
  overrides?: Partial<RuntimeHandlerContext> & {
    generateTextImpl?: (prompt: string) => Promise<string>;
  },
): RuntimeHandlerContext {
  const { generateTextImpl, ...direct } = overrides ?? {};
  return {
    runtimeId: "test-runtime",
    pluginId: "test-plugin",
    locale: "zh-CN",
    context: {},
    instructions: undefined,
    data: undefined,
    generateText: generateTextImpl ?? (async (prompt: string) => `[mock: ${prompt.slice(0, 50)}]`),
    ...direct,
  };
}

function createMockProviderInput(
  overrides?: Partial<ContextProviderInput>,
): ContextProviderInput {
  return {
    pluginId: "test-plugin",
    runtimeId: "test-runtime",
    locale: "zh-CN",
    state: {},
    world: { name: "测试世界" },
    characters: [],
    ...overrides,
  };
}

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

// ── PluginRegistrar.addTool ─────────────────────────────────────

describe("PluginRegistrar.addTool", () => {
  /** A tool registered via addTool is accessible by its ID in the contribution map. */
  it("registers a tool handler accessible by ID", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    const handler: ToolHandler = async (ctx) => ({
      output: `processed: ${JSON.stringify(ctx.input)}`,
    });

    registrar.addTool("search-records", handler);

    expect(contributions.tools.has("search-records")).toBe(true);
    expect(contributions.tools.get("search-records")).toBe(handler);
  });

  /** The tool handler receives a correctly shaped ToolExecutionContext. */
  it("tool receives correct context shape", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    const contextSpy = vi.fn();

    registrar.addTool("inspect", async (ctx) => {
      contextSpy(ctx);
      return { output: "inspected" };
    });

    const handler = contributions.tools.get("inspect")!;
    const ctx = createMockToolContext({
      pluginId: "test-plugin",
      runtimeId: "main",
      locale: "en-US",
      input: { target: "goblin" },
      state: { hp: 100 },
    });

    await handler(ctx);

    expect(contextSpy).toHaveBeenCalledTimes(1);
    const received = contextSpy.mock.calls[0][0];
    expect(received.pluginId).toBe("test-plugin");
    expect(received.runtimeId).toBe("main");
    expect(received.locale).toBe("en-US");
    expect(received.input).toEqual({ target: "goblin" });
    expect(received.state).toEqual({ hp: 100 });
  });

  /** A tool handler can return proposals alongside output. */
  it("tool can return proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addTool("heal", async (ctx) => {
      const amount = (ctx.input as { amount: number }).amount;
      return {
        output: { healed: amount },
        proposals: [
          { kind: "state.patch", payload: { hp: 100 } },
          { kind: "event.emit", payload: { type: "healed", amount } },
        ],
      };
    });

    const handler = contributions.tools.get("heal")!;
    const result = await handler(
      createMockToolContext({ input: { amount: 30 } }),
    );

    expect(result.output).toEqual({ healed: 30 });
    expect(result.proposals).toHaveLength(2);
    const kinds = result.proposals!.map((p) => p.kind).sort();
    expect(kinds).toEqual(["event.emit", "state.patch"]);
  });

  /** A tool can return simple output without any proposals. */
  it("tool can return simple output without proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addTool("lookup", async () => ({
      output: { found: true, name: "Excalibur" },
    }));

    const handler = contributions.tools.get("lookup")!;
    const result = await handler(createMockToolContext());

    expect(result.output).toEqual({ found: true, name: "Excalibur" });
    expect(result.proposals).toBeUndefined();
  });

  /** Multiple tools can be registered through the same registrar. */
  it("registers multiple tools", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addTool("read", async () => ({ output: "data" }));
    registrar.addTool("write", async () => ({ output: "ok" }));
    registrar.addTool("delete", async () => ({ output: "deleted" }));

    expect(contributions.tools.size).toBe(3);
    expect(contributions.tools.has("read")).toBe(true);
    expect(contributions.tools.has("write")).toBe(true);
    expect(contributions.tools.has("delete")).toBe(true);
  });
});

// ── PluginRegistrar.addHook ─────────────────────────────────────

describe("PluginRegistrar.addHook", () => {
  /** A hook registered via addHook is stored in the contribution map. */
  it("registers hooks for specific lifecycle events", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    const handler: HookHandler = async () => ({ allow: true });
    registrar.addHook("turn-guard", handler);

    expect(contributions.hooks.has("turn-guard")).toBe(true);
    expect(contributions.hooks.get("turn-guard")).toBe(handler);
  });

  /** A hook can block tool execution by returning allow=false. */
  it("hook can block tool execution via 'block' action", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addHook("danger-guard", async (ctx: HookHandlerContext) => {
      const input = ctx.toolCall?.input as Record<string, unknown> | undefined;
      if (input?.dangerous) {
        return { allow: false };
      }
      return { allow: true };
    });

    const handler = contributions.hooks.get("danger-guard")!;

    const blocked = await handler({
      event: "PreToolUse",
      runtimeId: "main",
      pluginId: "guard",
      locale: "zh-CN",
      toolCall: { toolId: "attack", input: { dangerous: true } },
    });
    expect(blocked.allow).toBe(false);

    const allowed = await handler({
      event: "PreToolUse",
      runtimeId: "main",
      pluginId: "guard",
      locale: "zh-CN",
      toolCall: { toolId: "attack", input: { dangerous: false } },
    });
    expect(allowed.allow).toBe(true);
  });

  /** A hook can modify input by returning rewrittenInput. */
  it("hook can modify via 'rewrite' action", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addHook("normalizer", async (ctx: HookHandlerContext) => ({
      allow: true,
      rewrittenInput: {
        ...(ctx.toolCall?.input as Record<string, unknown>),
        normalized: true,
        timestamp: "2025-01-01T00:00:00Z",
      },
    }));

    const handler = contributions.hooks.get("normalizer")!;
    const result = await handler({
      event: "PreToolUse",
      runtimeId: "main",
      pluginId: "norm",
      locale: "zh-CN",
      toolCall: { toolId: "action", input: { name: "test" } },
    });

    expect(result.allow).toBe(true);
    expect(result.rewrittenInput).toEqual({
      name: "test",
      normalized: true,
      timestamp: "2025-01-01T00:00:00Z",
    });
  });

  /** The hook context includes the runtimeId for scoping decisions. */
  it("hook receives runtimeId in context", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    const capturedRuntimeId = vi.fn();

    registrar.addHook("runtime-checker", async (ctx: HookHandlerContext) => {
      capturedRuntimeId(ctx.runtimeId);
      return { allow: true };
    });

    const handler = contributions.hooks.get("runtime-checker")!;
    await handler({
      event: "TurnStart",
      runtimeId: "narrator-runtime",
      pluginId: "checker",
      locale: "zh-CN",
    });

    expect(capturedRuntimeId).toHaveBeenCalledWith("narrator-runtime");
  });

  /** PostToolUse hooks receive tool output in the toolCall context. */
  it("PostToolUse hook receives output in toolCall context", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    const capturedOutput = vi.fn();

    registrar.addHook("post-logger", async (ctx: HookHandlerContext) => {
      capturedOutput(ctx.toolCall?.output);
      return { allow: true };
    });

    const handler = contributions.hooks.get("post-logger")!;
    await handler({
      event: "PostToolUse",
      runtimeId: "main",
      pluginId: "logger",
      locale: "zh-CN",
      toolCall: {
        toolId: "search",
        input: { query: "test" },
        output: { results: ["a", "b"] },
      },
    });

    expect(capturedOutput).toHaveBeenCalledWith({ results: ["a", "b"] });
  });
});

// ── PluginRegistrar.addContextProvider ───────────────────────────

describe("PluginRegistrar.addContextProvider", () => {
  /** A context provider is registered and can produce content for prompt assembly. */
  it("context provider contributes to prompt assembly", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addContextProvider("world-lore", async (input) => ({
      section: "World Lore",
      content: `The world "${(input.world as { name: string })?.name}" has ancient magic.`,
    }));

    expect(contributions.contextProviders.has("world-lore")).toBe(true);

    const provider = contributions.contextProviders.get("world-lore")!;
    const result = await provider(
      createMockProviderInput({ world: { name: "Eldoria" } }),
    );

    expect(result).toEqual({
      section: "World Lore",
      content: 'The world "Eldoria" has ancient magic.',
    });
  });

  /** Context provider receives session state for conditional content generation. */
  it("context provider receives session state", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    const capturedState = vi.fn();

    registrar.addContextProvider("state-aware", async (input) => {
      capturedState(input.state);
      return { stateInfo: input.state };
    });

    const provider = contributions.contextProviders.get("state-aware")!;
    const state = { questActive: true, currentLocation: "dungeon" };
    await provider(createMockProviderInput({ state }));

    expect(capturedState).toHaveBeenCalledWith(state);
  });

  /** Multiple context providers can be registered with different IDs. */
  it("multiple context providers with different IDs", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addContextProvider("high-priority", async () => ({
      section: "Critical",
    }));
    registrar.addContextProvider("low-priority", async () => ({
      section: "Background",
    }));

    expect(contributions.contextProviders.size).toBe(2);
    expect(contributions.contextProviders.has("high-priority")).toBe(true);
    expect(contributions.contextProviders.has("low-priority")).toBe(true);
  });
});

// ── PluginRegistrar.addRuntimeHandler ───────────────────────────

describe("PluginRegistrar.addRuntimeHandler", () => {
  /** A custom runtime handler is registered in the contribution map. */
  it("registers a custom runtime handler", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    const handler: RuntimeHandler = async () => ({ proposals: [] });

    registrar.addRuntimeHandler("custom-narrator", handler);

    expect(contributions.runtimeHandlers.has("custom-narrator")).toBe(true);
    expect(contributions.runtimeHandlers.get("custom-narrator")).toBe(handler);
  });

  /** Runtime handler receives context and can use generateText for LLM calls. */
  it("handler receives context and can generate text", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addRuntimeHandler("story-gen", async (ctx) => {
      const text = ctx.generateText
        ? await ctx.generateText("Tell a story about a brave knight.")
        : "No LLM available";

      return {
        proposals: [
          { kind: "narrative.append", payload: { text } },
        ],
      };
    });

    const handler = contributions.runtimeHandlers.get("story-gen")!;
    const handlerCtx = createMockHandlerContext({
      runtimeId: "story-gen",
      pluginId: "narrator",
      generateTextImpl: async (prompt) => `Once upon a time: ${prompt.slice(0, 20)}...`,
    });

    const result = await handler(handlerCtx);

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].kind).toBe("narrative.append");
    const payload = result.proposals[0].payload as { text: string };
    expect(payload.text).toContain("Once upon a time");
  });

  /** Runtime handler returns proposals with multiple kinds. */
  it("handler returns proposals", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addRuntimeHandler("quest-updater", async () => ({
      proposals: [
        { kind: "state.patch", payload: { questPhase: "act2" } },
        { kind: "event.emit", payload: { type: "quest_advanced" } },
        { kind: "narrative.append", payload: { text: "The quest advances..." } },
      ],
    }));

    const handler = contributions.runtimeHandlers.get("quest-updater")!;
    const result = await handler(createMockHandlerContext());

    const kinds = result.proposals.map((p) => p.kind).sort();
    expect(kinds).toEqual(["event.emit", "narrative.append", "state.patch"]);

    const patch = result.proposals.find((p) => p.kind === "state.patch");
    expect(patch?.payload).toEqual({ questPhase: "act2" });
  });

  /** Runtime handler receives instructions (PLUGIN.md content) when provided. */
  it("handler receives instructions when provided", async () => {
    const { registrar, contributions } = createCollectingRegistrar();
    const capturedInstructions = vi.fn();

    registrar.addRuntimeHandler("instructed", async (ctx) => {
      capturedInstructions(ctx.instructions);
      return { proposals: [] };
    });

    const handler = contributions.runtimeHandlers.get("instructed")!;
    await handler(
      createMockHandlerContext({
        instructions: "You are a narrator. Tell vivid stories.",
      }),
    );

    expect(capturedInstructions).toHaveBeenCalledWith(
      "You are a narrator. Tell vivid stories.",
    );
  });
});

// ── PluginRegistrar.addCommand ──────────────────────────────────

describe("PluginRegistrar.addCommand", () => {
  /** A slash command is registered and stored in the contributions array. */
  it("registers a slash command", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addCommand({
      name: "roll",
      description: "Roll dice",
      handler: async () => ({ result: 17 }),
    });

    expect(contributions.commands).toHaveLength(1);
    expect(contributions.commands[0].name).toBe("roll");
    expect(contributions.commands[0].description).toBe("Roll dice");
  });

  /** A command with a Zod-like args schema validates input correctly. */
  it("command with Zod args schema validates input", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    const mockSchema = {
      safeParse(data: unknown) {
        const obj = data as Record<string, unknown>;
        if (typeof obj?.sides === "number" && obj.sides > 0) {
          return { success: true as const, data: obj };
        }
        return {
          success: false as const,
          error: {
            issues: [{ path: ["sides"], message: "Must be a positive number" }],
          },
        };
      },
    };

    registrar.addCommand({
      name: "roll",
      description: "Roll a die",
      handler: async (args) => {
        const parsed = args as { sides: number };
        return { result: parsed.sides };
      },
      argsSchema: mockSchema,
    });

    const cmd = contributions.commands[0];

    const valid = cmd.argsSchema!.safeParse({ sides: 20 });
    expect(valid.success).toBe(true);

    const invalid = cmd.argsSchema!.safeParse({ sides: -1 });
    expect(invalid.success).toBe(false);
  });

  /** Command execution returns a result with context data. */
  it("command execution returns result", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addCommand({
      name: "status",
      description: "Get status",
      handler: async (args, context) => ({
        status: "online",
        requestedBy: (context as Record<string, unknown>).userId,
      }),
    });

    const cmd = contributions.commands[0];
    const result = await cmd.handler(
      {},
      { userId: "player-1", sessionId: "sess-001" },
    );

    expect(result).toEqual({ status: "online", requestedBy: "player-1" });
  });

  /** Commands with help metadata and autocomplete hints are preserved. */
  it("command with help and autocomplete metadata", () => {
    const { registrar, contributions } = createCollectingRegistrar();

    registrar.addCommand({
      name: "teleport",
      description: "Teleport to a location",
      handler: async () => ({ success: true }),
      help: {
        usage: "/teleport <location>",
        examples: ["/teleport tavern", "/teleport dungeon-entrance"],
      },
      autocomplete: {
        positionalHints: ["location"],
        flagHints: [
          { name: "--silent", description: "Teleport without narration", takesValue: false },
        ],
      },
    });

    const cmd = contributions.commands[0];
    expect(cmd.help?.usage).toBe("/teleport <location>");
    expect(cmd.help?.examples).toHaveLength(2);
    expect(cmd.autocomplete?.positionalHints).toEqual(["location"]);
    expect(cmd.autocomplete?.flagHints).toHaveLength(1);
  });
});

// ── Integration: Full Plugin Registration Lifecycle ─────────────

describe("Plugin registration lifecycle", () => {
  /**
   * Simulate a complete plugin register() call that registers tools,
   * hooks, runtime handler, context provider, and command in a single invocation.
   */
  it("plugin registers tools, hooks, and runtime in one register() call", async () => {
    const { registrar, contributions } = createCollectingRegistrar();

    // Simulate a plugin's register() function
    function registerCombatPlugin(reg: PluginRegistrar): void {
      reg.addTool("attack", async (ctx) => {
        const target = (ctx.input as { target: string }).target;
        return {
          output: { damage: 10, target },
          proposals: [
            { kind: "state.patch", payload: { lastTarget: target } },
          ],
        };
      });

      reg.addTool("defend", async () => ({
        output: { armorBonus: 5 },
      }));

      reg.addHook("combat-guard", async (ctx) => {
        const input = ctx.toolCall?.input as Record<string, unknown> | undefined;
        if (input?.peaceful) {
          return { allow: false };
        }
        return { allow: true };
      });

      reg.addRuntimeHandler("combat-runtime", async (ctx) => {
        const text = ctx.generateText
          ? await ctx.generateText("Describe combat")
          : "Combat begins!";
        return {
          proposals: [{ kind: "narrative.append", payload: { text } }],
        };
      });

      reg.addContextProvider("combat-context", async () => ({
        section: "Combat Status",
        content: "Player is in combat.",
      }));

      reg.addCommand({
        name: "fight",
        description: "Start a fight",
        handler: async () => ({ started: true }),
      });
    }

    registerCombatPlugin(registrar);

    // Verify all contributions were collected
    expect(contributions.tools.size).toBe(2);
    expect(contributions.hooks.size).toBe(1);
    expect(contributions.runtimeHandlers.size).toBe(1);
    expect(contributions.contextProviders.size).toBe(1);
    expect(contributions.commands).toHaveLength(1);

    // Verify tool execution works
    const attackHandler = contributions.tools.get("attack")!;
    const attackResult = await attackHandler(
      createMockToolContext({ input: { target: "dragon" } }),
    );
    expect(attackResult.output).toEqual({ damage: 10, target: "dragon" });
    expect(attackResult.proposals).toHaveLength(1);
    expect(attackResult.proposals![0].kind).toBe("state.patch");
  });

  /**
   * Verify that session scope properly filters registered plugin items.
   * Tools and hooks from a disabled plugin are hidden from scoped views.
   */
  it("session scope filters registered items", () => {
    const pluginReg = createPluginRegistry();
    pluginReg.add(makeManifest("combat"), "/tmp/combat");
    pluginReg.add(makeManifest("inventory"), "/tmp/inventory");

    const toolReg = createToolRegistry();
    toolReg.register(
      "combat",
      { id: "attack", kind: "mutate" },
      async () => ({ output: null }),
    );
    toolReg.register(
      "inventory",
      { id: "list-items", kind: "query" },
      async () => ({ output: [] }),
    );

    const hookReg = createHookRegistry();
    hookReg.register(
      "combat",
      { id: "combat-hook", event: "PreToolUse", handlerKind: "command" },
      async () => ({ allow: true }),
      100,
    );

    // Create scope with only inventory active
    const scope = createSessionPluginScope(pluginReg, ["inventory"]);
    const scopedTools = createScopedToolRegistry(toolReg, scope);
    const scopedHooks = createScopedHookRegistry(hookReg, scope);

    expect(scopedTools.getByQualifiedId("combat:attack")).toBeUndefined();
    expect(scopedTools.getByQualifiedId("inventory:list-items")).toBeDefined();
    expect(scopedTools.listAll()).toHaveLength(1);

    expect(scopedHooks.getHooksForEvent("PreToolUse")).toHaveLength(0);
  });

  /** Disabling a plugin hides its tools from scoped views. */
  it("disable plugin hides its tools from scoped views", () => {
    const pluginReg = createPluginRegistry();
    pluginReg.add(makeManifest("alpha"), "/tmp/alpha");
    pluginReg.add(makeManifest("beta"), "/tmp/beta");

    const toolReg = createToolRegistry();
    toolReg.register(
      "alpha",
      { id: "t1", kind: "query" },
      async () => ({ output: "a" }),
    );
    toolReg.register(
      "beta",
      { id: "t2", kind: "query" },
      async () => ({ output: "b" }),
    );

    const scope = createSessionPluginScope(pluginReg);
    const scoped = createScopedToolRegistry(toolReg, scope);

    expect(scoped.listAll()).toHaveLength(2);

    scope.disable("beta");
    expect(scoped.listAll()).toHaveLength(1);
    expect(scoped.getByQualifiedId("beta:t2")).toBeUndefined();
    expect(scoped.getByQualifiedId("alpha:t1")).toBeDefined();
  });

  /** Re-enabling a previously disabled plugin restores access to its tools. */
  it("re-enable plugin restores access", () => {
    const pluginReg = createPluginRegistry();
    pluginReg.add(makeManifest("alpha"), "/tmp/alpha");
    pluginReg.add(makeManifest("beta"), "/tmp/beta");

    const toolReg = createToolRegistry();
    toolReg.register(
      "alpha",
      { id: "t1", kind: "query" },
      async () => ({ output: "a" }),
    );
    toolReg.register(
      "beta",
      { id: "t2", kind: "query" },
      async () => ({ output: "b" }),
    );

    const scope = createSessionPluginScope(pluginReg);
    const scoped = createScopedToolRegistry(toolReg, scope);

    scope.disable("beta");
    expect(scoped.getByQualifiedId("beta:t2")).toBeUndefined();

    scope.enable("beta");
    expect(scoped.getByQualifiedId("beta:t2")).toBeDefined();
    expect(scoped.listAll()).toHaveLength(2);
  });
});
