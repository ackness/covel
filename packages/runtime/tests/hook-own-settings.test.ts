/**
 * HookContext.getOwnSettings — read-only per-session settings for hooks.
 *
 * Builds on the existing session hook scope (hooks/hook-scope.ts): the same
 * AsyncLocalStorage that carries `activePluginIds` now also carries a frozen,
 * per-plugin `userSettings` snapshot. The pipeline injects a per-handler
 * `getOwnSettings` accessor bound to the handler's own `pluginId`.
 *
 * Covers:
 * - hook-scope `currentOwnSettings` / `isHookScopeActive` primitives
 * - pipeline injection (plugin hook reads its own bucket; cross-plugin → {};
 *   framework hook → {}; outside scope → getter absent, ctx forwarded as-is)
 * - read-only guarantee (returned bucket is frozen)
 * - end-to-end through executeTurn (snapshot built from manifest.userSettings
 *   merged with TurnInput.userSettings, visible to an in-turn TurnStart hook)
 */

import { describe, it, expect, vi } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import {
  runWithHookScope,
  isHookScopeActive,
  currentOwnSettings,
} from "../src/hooks/hook-scope.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";
import type { HookContext } from "../src/hooks/types.js";
import { executeTurn } from "../src/turn-executor/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm/llm-adapter.js";

// ── hook-scope primitives ──────────────────────────────────────────

describe("hook-scope settings", () => {
  it("reports no active scope and returns a frozen empty bucket by default", () => {
    expect(isHookScopeActive()).toBe(false);
    const out = currentOwnSettings("any-plugin");
    expect(out).toEqual({});
    expect(Object.isFrozen(out)).toBe(true);
  });

  it("exposes a plugin's bucket inside the scope and isolates other plugins", () => {
    runWithHookScope(
      {
        activePluginIds: new Set(["plugin-a", "plugin-b"]),
        settings: {
          "plugin-a": Object.freeze({ tone: "dramatic" }),
          "plugin-b": Object.freeze({ tone: "calm" }),
        },
      },
      () => {
        expect(isHookScopeActive()).toBe(true);
        expect(currentOwnSettings("plugin-a")).toEqual({ tone: "dramatic" });
        expect(currentOwnSettings("plugin-b")).toEqual({ tone: "calm" });
        // Plugin absent from the snapshot → empty bucket.
        expect(currentOwnSettings("plugin-z")).toEqual({});
        // Framework / global hook (no pluginId) → empty bucket.
        expect(currentOwnSettings(undefined)).toEqual({});
      },
    );

    expect(isHookScopeActive()).toBe(false);
  });

  it("degrades to {} when the scope carries no settings (e.g. session/commit scopes)", () => {
    runWithHookScope({ activePluginIds: new Set(["plugin-a"]) }, () => {
      expect(isHookScopeActive()).toBe(true);
      expect(currentOwnSettings("plugin-a")).toEqual({});
    });
  });
});

// ── pipeline injection ──────────────────────────────────────────────

const baseCtx: HookContext = {
  event: "TurnStart",
  sessionId: "sess-own",
  turnId: "turn-own",
};

describe("HookPipeline getOwnSettings injection", () => {
  it("gives a plugin hook its own frozen settings inside a scope", async () => {
    const pipeline = createHookPipeline();
    let seen: Readonly<Record<string, unknown>> | undefined;

    pipeline.register({
      id: "plugin-a:TurnStart:0",
      event: "TurnStart",
      pluginId: "plugin-a",
      handler: async (ctx) => {
        seen = ctx.getOwnSettings?.();
        return { action: "continue" };
      },
    });

    await runWithHookScope(
      {
        activePluginIds: new Set(["plugin-a"]),
        settings: {
          "plugin-a": Object.freeze({ tone: "dramatic", verbosity: 3 }),
        },
      },
      () => pipeline.run("TurnStart", baseCtx, { playerMessage: "hi" }),
    );

    expect(seen).toEqual({ tone: "dramatic", verbosity: 3 });
    expect(Object.isFrozen(seen)).toBe(true);
  });

  it("never leaks another plugin's settings (isolation)", async () => {
    const pipeline = createHookPipeline();
    let seenByB: Readonly<Record<string, unknown>> | undefined;

    pipeline.register({
      id: "plugin-b:TurnStart:0",
      event: "TurnStart",
      pluginId: "plugin-b",
      handler: async (ctx) => {
        seenByB = ctx.getOwnSettings?.();
        return { action: "continue" };
      },
    });

    await runWithHookScope(
      {
        // plugin-b is active (so its hook fires) but has no settings bucket.
        activePluginIds: new Set(["plugin-a", "plugin-b"]),
        settings: { "plugin-a": Object.freeze({ secret: "A-only" }) },
      },
      () => pipeline.run("TurnStart", baseCtx, { playerMessage: "hi" }),
    );

    expect(seenByB).toEqual({});
  });

  it("returns {} for a framework hook with no pluginId", async () => {
    const pipeline = createHookPipeline();
    let seen: Readonly<Record<string, unknown>> | undefined;

    pipeline.register({
      id: "global:TurnStart:0",
      event: "TurnStart",
      handler: async (ctx) => {
        seen = ctx.getOwnSettings?.();
        return { action: "continue" };
      },
    });

    await runWithHookScope(
      {
        activePluginIds: new Set(["plugin-a"]),
        settings: { "plugin-a": Object.freeze({ tone: "dramatic" }) },
      },
      () => pipeline.run("TurnStart", baseCtx, { playerMessage: "hi" }),
    );

    expect(seen).toEqual({});
  });

  it("does not attach getOwnSettings outside an active scope (behaviour-preserving)", async () => {
    const pipeline = createHookPipeline();
    let hadGetter = true;

    // No runWithHookScope wrapper → no scope → context passed through untouched.
    const ctx = { ...baseCtx };
    const handler = vi.fn(async (c: HookContext) => {
      hadGetter = c.getOwnSettings !== undefined;
      return { action: "continue" as const };
    });
    pipeline.register({
      id: "plugin-a:TurnStart:0",
      event: "TurnStart",
      pluginId: "plugin-a",
      handler,
    });

    await pipeline.run("TurnStart", ctx, { playerMessage: "hi" });

    expect(hadGetter).toBe(false);
    // The exact context object is forwarded unchanged when no scope is active.
    expect(handler).toHaveBeenCalledWith(ctx, { playerMessage: "hi" });
  });
});

// ── end-to-end through executeTurn ──────────────────────────────────

class SimpleMockLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "ok",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

async function createMainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  await store.appendTurnMessage({
    id: "prior-player-0",
    sessionId,
    turnId: "prior-turn",
    sourceType: "player",
    role: "user",
    content: "prior turn",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

function makeCfgManifest(): RuntimeManifest {
  return {
    name: "cfg-plugin",
    pluginId: "cfg-plugin",
    description: "Configurable plugin",
    priority: 500,
    runtimeType: "agent",
    userSettings: [
      { key: "tone", type: "text", default: "neutral", label: "Tone" },
      { key: "verbosity", type: "number", default: 3, label: "Verbosity" },
    ],
  };
}

describe("executeTurn → hook getOwnSettings end-to-end", () => {
  it("merges manifest defaults with player values and exposes them to an in-turn hook", async () => {
    const sessionId = "sess-cfg";
    const manifest = makeCfgManifest();
    const pipeline = createHookPipeline();

    let cfgSeen: Readonly<Record<string, unknown>> | undefined;
    let otherSeen: Readonly<Record<string, unknown>> | undefined;

    pipeline.register({
      id: "cfg-plugin:TurnStart:0",
      event: "TurnStart",
      pluginId: "cfg-plugin",
      handler: async (ctx) => {
        cfgSeen = ctx.getOwnSettings?.();
        return { action: "continue" };
      },
    });
    // A framework (no-pluginId) hook always fires; it must see {}.
    pipeline.register({
      id: "global:TurnStart:0",
      event: "TurnStart",
      handler: async (ctx) => {
        otherSeen = ctx.getOwnSettings?.();
        return { action: "continue" };
      },
    });

    const deps: TurnExecutorDeps = {
      loadRuntime: async () => ({
        manifest,
        promptTemplate: "Say something.",
      }),
      llm: new SimpleMockLLM(),
      hookPipeline: pipeline,
      store: await createMainLoopStore(sessionId),
    };

    const input: TurnInput = {
      sessionId,
      turnId: "turn-cfg",
      playerMessage: "hello",
      // Player saved only `tone`; `verbosity` falls back to the manifest default.
      userSettings: { "cfg-plugin": { tone: "dramatic" } },
    };

    const result = await executeTurn(input, [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    // Player value wins for tone; manifest default fills missing verbosity.
    expect(cfgSeen).toEqual({ tone: "dramatic", verbosity: 3 });
    expect(Object.isFrozen(cfgSeen)).toBe(true);
    // Framework hook sees an empty bucket.
    expect(otherSeen).toEqual({});
  });
});
