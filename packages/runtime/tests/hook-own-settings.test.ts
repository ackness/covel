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
import { buildHookSettings } from "../src/hooks/hook-settings.js";
import { finalizeExecution } from "../src/commit/finalize-execution.js";
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

  it("degrades to {} when a custom scope carries no settings", () => {
    runWithHookScope({ activePluginIds: new Set(["plugin-a"]) }, () => {
      expect(isHookScopeActive()).toBe(true);
      expect(currentOwnSettings("plugin-a")).toEqual({});
    });
  });
});

describe("operation settings snapshot", () => {
  it("owns nested defaults without freezing or retaining caller-owned objects", () => {
    const defaults = { nested: { value: "original" } };
    const snapshot = buildHookSettings(
      [
        {
          pluginId: "configured",
          userSettings: [
            { key: "config", type: "text", default: defaults, label: "Config" },
          ],
        },
      ],
      undefined,
    );
    expect(Object.isFrozen(defaults)).toBe(false);
    defaults.nested.value = "edited";
    expect(snapshot.configured.config).toEqual({
      nested: { value: "original" },
    });
    expect(Object.isFrozen(snapshot.configured.config)).toBe(true);
    expect(
      Object.isFrozen((snapshot.configured.config as typeof defaults).nested),
    ).toBe(true);
  });

  it("isolates concurrent operations through pre/post commit and ignores the caller's unrelated scope", async () => {
    const manifest = makeCfgManifest();
    const pipeline = createHookPipeline();
    const observed: Array<{
      sessionId: string;
      event: string;
      settings: unknown;
    }> = [];
    for (const event of ["PreStateCommit", "PostStateCommit"] as const) {
      pipeline.register({
        id: `configured:${event}`,
        event,
        pluginId: manifest.pluginId,
        handler: async (ctx) => {
          await Promise.resolve();
          observed.push({
            sessionId: ctx.sessionId,
            event,
            settings: ctx.getOwnSettings?.(),
          });
          return { action: "continue" };
        },
      });
    }
    const outcomes = await runWithHookScope(
      {
        activePluginIds: new Set([manifest.pluginId]),
        settings: { [manifest.pluginId]: { tone: "unrelated-operation" } },
      },
      () =>
        Promise.all(
          ["a", "b", "defaults"].map(async (sessionId) => {
            const hookSettings =
              sessionId === "defaults"
                ? undefined
                : buildHookSettings([manifest], {
                    [manifest.pluginId]: { tone: sessionId },
                  });
            return finalizeExecution({
              store: createMemoryStore(),
              sessionId,
              executionContext: {
                executionId: sessionId,
                origin: "manual",
                countPolicy: "none",
              },
              runtimes: [manifest],
              hookSettings,
              hookPipeline: pipeline,
              turnIds: [],
              results: [
                {
                  runtimeId: manifest.name,
                  pluginId: manifest.pluginId,
                  turnId: sessionId,
                  runId: sessionId,
                  status: "success",
                  output: {
                    statePatches: [{ table: "stats", field: "hp", value: 1 }],
                  },
                  toolCalls: [],
                  durationMs: 0,
                  timestamp: new Date().toISOString(),
                },
              ],
            });
          }),
        ),
    );
    expect(outcomes.every((outcome) => outcome.status === "committed")).toBe(
      true,
    );
    expect(observed).toHaveLength(6);
    for (const entry of observed) {
      expect(entry.settings).toEqual({
        tone: entry.sessionId === "defaults" ? "neutral" : entry.sessionId,
        verbosity: 3,
      });
      expect(Object.isFrozen(entry.settings)).toBe(true);
    }
  });
});

// ── pipeline injection ──────────────────────────────────────────────

const baseCtx: HookContext = {
  event: "TurnStart",
  sessionId: "sess-own",
  turnId: "turn-own",
};

describe("HookPipeline getOwnSettings injection", () => {
  it("binds a retained settings accessor to the originating operation", async () => {
    const pipeline = createHookPipeline();
    let readSettings: HookContext["getOwnSettings"];
    pipeline.register({
      id: "capture-settings",
      event: "TurnStart",
      pluginId: "plugin-a",
      handler: async (ctx) => {
        readSettings = ctx.getOwnSettings;
        return { action: "continue" };
      },
    });
    await runWithHookScope(
      {
        activePluginIds: new Set(["plugin-a"]),
        settings: { "plugin-a": Object.freeze({ tone: "origin" }) },
      },
      () => pipeline.run("TurnStart", baseCtx, {}),
    );
    expect(readSettings?.()).toEqual({ tone: "origin" });
    runWithHookScope(
      {
        activePluginIds: new Set(["plugin-a"]),
        settings: { "plugin-a": Object.freeze({ tone: "another-session" }) },
      },
      () => expect(readSettings?.()).toEqual({ tone: "origin" }),
    );
  });

  it("does not let caller or handler mutations widen another hook's activation set", async () => {
    const pipeline = createHookPipeline();
    const activePluginIds = new Set(["plugin-a"]);
    const seen: string[][] = [];
    const inactive = vi.fn(async () => ({ action: "continue" as const }));
    pipeline.register({
      id: "mutating-hook",
      event: "TurnStart",
      pluginId: "plugin-a",
      handler: async (ctx) => {
        (ctx.activePluginIds as Set<string>).add("plugin-b");
        return { action: "continue" };
      },
    });
    pipeline.register({
      id: "following-hook",
      event: "TurnStart",
      pluginId: "plugin-a",
      handler: async (ctx) => {
        seen.push([...(ctx.activePluginIds ?? [])]);
        return { action: "continue" };
      },
    });
    pipeline.register({
      id: "inactive-hook",
      event: "TurnStop",
      pluginId: "plugin-b",
      handler: inactive,
    });
    await runWithHookScope({ activePluginIds }, async () => {
      activePluginIds.add("plugin-b");
      await pipeline.run("TurnStart", baseCtx, {});
      await pipeline.run("TurnStop", { ...baseCtx, event: "TurnStop" }, {});
    });
    expect(seen).toEqual([["plugin-a"]]);
    expect(inactive).not.toHaveBeenCalled();
  });

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

    // Scope-less calls have no settings getter, but still receive cancellation.
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
    // Identity metadata is preserved; only the cancellation signal is added.
    expect(handler).toHaveBeenCalledWith(
      { ...ctx, signal: expect.any(AbortSignal) },
      { playerMessage: "hi" },
    );
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
    stage: "narrative",
    runtimeType: "agent",
    userSettings: [
      { key: "tone", type: "text", default: "neutral", label: "Tone" },
      { key: "verbosity", type: "number", default: 3, label: "Verbosity" },
    ],
  };
}

describe("executeTurn → hook getOwnSettings end-to-end", () => {
  it("preserves each runtime's own default when a plugin declares several runtimes", async () => {
    const makeRuntime = (name: string, tone: string): RuntimeManifest => ({
      ...makeCfgManifest(),
      name,
      runtimeType: "function",
      userSettings: [
        { key: "tone", type: "text", default: tone, label: "Tone" },
      ],
    });
    const manifests = [
      makeRuntime("configured/a", "quiet"),
      makeRuntime("configured/b", "loud"),
    ];
    const seen: unknown[] = [];
    const result = await executeTurn(
      { sessionId: "defaults", turnId: "defaults", playerMessage: "hello" },
      manifests,
      {
        store: await createMainLoopStore("defaults"),
        llm: new SimpleMockLLM(),
        loadRuntime: async (manifest) => ({
          manifest,
          promptTemplate: "",
          handler: async (ctx) => {
            seen.push(ctx.userSettings);
            return { outcome: "success", value: {} };
          },
        }),
      },
    );
    expect(result.runtimeResults.map((entry) => entry.status)).toEqual([
      "success",
      "success",
    ]);
    expect(seen).toEqual(
      expect.arrayContaining([{ tone: "quiet" }, { tone: "loud" }]),
    );
    expect(seen).toHaveLength(2);
  });

  it("merges manifest defaults with player values and exposes them to an in-turn hook", async () => {
    const sessionId = "sess-cfg";
    const manifest = makeCfgManifest();
    const pipeline = createHookPipeline();

    const playerValues = { tone: "dramatic" };
    let runtimeSettings: unknown;
    pipeline.register({
      id: "cfg-plugin:PreRuntime:settings",
      event: "PreRuntime",
      pluginId: "cfg-plugin",
      handler: async (_ctx, payload) => {
        runtimeSettings = payload.input.userSettings;
        return { action: "continue" };
      },
    });
    let cfgSeen: Readonly<Record<string, unknown>> | undefined;
    let otherSeen: Readonly<Record<string, unknown>> | undefined;

    pipeline.register({
      id: "cfg-plugin:TurnStart:0",
      event: "TurnStart",
      pluginId: "cfg-plugin",
      handler: async (ctx) => {
        cfgSeen = ctx.getOwnSettings?.();
        playerValues.tone = "changed-after-start";
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
      userSettings: { "cfg-plugin": playerValues },
    };

    const result = await executeTurn(input, [manifest], deps);

    expect(result.runtimeResults).toHaveLength(1);
    // Player value wins for tone; manifest default fills missing verbosity.
    expect(cfgSeen).toEqual({ tone: "dramatic", verbosity: 3 });
    expect(Object.isFrozen(cfgSeen)).toBe(true);
    expect(runtimeSettings).toEqual({
      "cfg-plugin": { tone: "dramatic" },
    });
    expect(playerValues.tone).toBe("changed-after-start");
    // Framework hook sees an empty bucket.
    expect(otherSeen).toEqual({});
  });
});
