import { describe, expect, it, vi } from "vitest";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  RpcDispatchError,
  createRpcHandlerStoreView,
} from "../src/index.js";
import type { RpcHandler } from "../src/index.js";

describe("PluginRpcRegistry", () => {
  it("registers a plugin action and looks it up by (pluginId, action)", () => {
    const registry = createPluginRpcRegistry();
    const handler: RpcHandler = async () => ({ ok: true });
    registry.registerPluginHandler(
      "codex",
      "regenerate",
      handler,
      {},
      "builtin",
    );
    const entry = registry.getPluginAction("codex", "regenerate");
    expect(entry).toBeDefined();
    expect(entry?.action).toBe("regenerate");
    expect(entry?.pluginId).toBe("codex");
    expect(entry?.trustLevel).toBe("builtin");
    expect(entry?.handler).toBe(handler);
  });

  it("honors per-action trust override when it is more restrictive than plugin source", () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginHandler(
      "core-plugin",
      "risky-action",
      async () => null,
      { trustLevel: "community" },
      "builtin",
    );
    const entry = registry.getPluginAction("core-plugin", "risky-action");
    expect(entry?.trustLevel).toBe("community");
  });

  it("clamps trust escalation to plugin source (CRITICAL-1 fix)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createPluginRpcRegistry();
    // A community plugin tries to opt itself into builtin trust → clamped.
    registry.registerPluginHandler(
      "untrusted-plugin",
      "sneaky-action",
      async () => null,
      { trustLevel: "builtin" },
      "community",
    );
    const entry = registry.getPluginAction("untrusted-plugin", "sneaky-action");
    expect(entry?.trustLevel).toBe("community");
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0]).toContain("clamping to community");
    warnSpy.mockRestore();
  });

  it("clamps community plugin trying to claim builtin trust", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = createPluginRpcRegistry();
    registry.registerPluginHandler(
      "untrusted-plugin",
      "medium-action",
      async () => null,
      { trustLevel: "builtin" },
      "community",
    );
    const entry = registry.getPluginAction("untrusted-plugin", "medium-action");
    expect(entry?.trustLevel).toBe("community");
    warnSpy.mockRestore();
  });

  it("builtin plugin can downgrade an action to community", () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginHandler(
      "builtin-plugin",
      "restricted",
      async () => null,
      { trustLevel: "community" },
      "builtin",
    );
    expect(
      registry.getPluginAction("builtin-plugin", "restricted")?.trustLevel,
    ).toBe("community");
  });

  it.each([
    { options: { trustLevel: "unknown" }, source: "community" },
    { options: { trustLevel: null }, source: "community" },
    { options: { trustLevel: 1 }, source: "community" },
    { options: "builtin", source: "community" },
    { options: null, source: "community" },
    { options: {}, source: "unknown" },
  ])(
    "rejects untyped RPC trust inputs before publishing %#",
    ({ options, source }) => {
      const registry = createPluginRpcRegistry();
      expect(() =>
        registry.registerPluginHandler(
          "untrusted-plugin",
          "action",
          async () => null,
          options as never,
          source as never,
        ),
      ).toThrow(TypeError);
      expect(
        registry.getPluginAction("untrusted-plugin", "action"),
      ).toBeUndefined();
    },
  );

  it("throws on duplicate (pluginId, action) registration", () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginHandler("p", "a", async () => null, {}, "builtin");
    expect(() =>
      registry.registerPluginHandler("p", "a", async () => null, {}, "builtin"),
    ).toThrow(/duplicate registration/);
  });

  it("framework defaults are returned by getFrameworkDefault", () => {
    const registry = createPluginRpcRegistry();
    const handler: RpcHandler = async () => ({ ok: true });
    registry.registerFrameworkDefault("cancel", handler, {
      description: "stop the current turn",
    });
    const entry = registry.getFrameworkDefault("cancel");
    expect(entry?.handler).toBe(handler);
    expect(entry?.trustLevel).toBe("builtin");
    expect(entry?.description).toBe("stop the current turn");
  });

  it("list() returns framework + plugin entries", () => {
    const registry = createPluginRpcRegistry();
    registry.registerFrameworkDefault("submit-form", async () => null);
    registry.registerPluginHandler(
      "codex",
      "regenerate",
      async () => null,
      {},
      "builtin",
    );
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.action)).toContain("submit-form");
    expect(list.map((e) => e.action)).toContain("regenerate");
  });
});

describe("createRpcExecutor", () => {
  function makeExecutor() {
    const registry = createPluginRpcRegistry();
    const executor = createRpcExecutor({ registry });
    return { registry, executor };
  }

  it("dispatches a framework default action", async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault("submit-form", async (payload) => ({
      received: payload,
    }));

    const result = await executor.dispatch(
      { pluginId: "framework", action: "submit-form", payload: { x: 1 } },
      { sessionId: "sess-1", store: {} as never },
    );
    expect(result.entry.action).toBe("submit-form");
    expect(result.result).toEqual({ received: { x: 1 } });
  });

  it("dispatches an entry-registered plugin action", async () => {
    const { registry, executor } = makeExecutor();
    registry.registerPluginHandler(
      "codex",
      "regenerate",
      async () => "plugin-result",
      {},
      "builtin",
    );

    const result = await executor.dispatch(
      { pluginId: "codex", action: "regenerate", payload: null },
      { sessionId: "sess-1", store: {} as never },
    );
    expect(result.result).toBe("plugin-result");
  });

  it("plugin-declared action takes precedence over framework default of the same name", async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault(
      "submit-form",
      async () => "framework-version",
    );
    registry.registerPluginHandler(
      "codex",
      "submit-form",
      async () => "plugin-version",
      {},
      "builtin",
    );

    const result = await executor.dispatch(
      { pluginId: "codex", action: "submit-form", payload: null },
      { sessionId: "sess-1", store: {} as never },
    );
    expect(result.result).toBe("plugin-version");
  });

  it("refuses a plugin handler under the reserved framework ID", () => {
    const { registry } = makeExecutor();
    expect(() =>
      registry.registerPluginHandler(
        "framework",
        "slash-debug",
        async () => "impostor",
        {},
        "community",
      ),
    ).toThrow(/reserved/);
  });

  it("resolves the framework ID to framework defaults and a plugin ID to its own actions only", async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault("slash-debug", async () => "framework");
    await expect(
      executor.dispatch(
        { pluginId: "framework", action: "slash-debug", payload: null },
        { sessionId: "sess-1", store: {} as never },
      ),
    ).resolves.toMatchObject({ result: "framework" });
    // A plugin that did not register the action does not reach the default.
    await expect(
      executor.dispatch(
        { pluginId: "codex", action: "slash-debug", payload: null },
        { sessionId: "sess-1", store: {} as never },
      ),
    ).rejects.toMatchObject({ code: "unknown-action" });
  });

  it('throws RpcDispatchError with code "unknown-action" when nothing is registered', async () => {
    const { executor } = makeExecutor();
    await expect(
      executor.dispatch(
        { pluginId: "nope", action: "nada", payload: null },
        { sessionId: "sess-1", store: {} as never },
      ),
    ).rejects.toMatchObject({
      name: "RpcDispatchError",
      code: "unknown-action",
    });
  });

  it('wraps thrown handler errors as RpcDispatchError code "handler-threw"', async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault("boom", async () => {
      throw new Error("boom");
    });
    await expect(
      executor.dispatch(
        { pluginId: "framework", action: "boom", payload: null },
        { sessionId: "sess-1", store: {} as never },
      ),
    ).rejects.toMatchObject({
      name: "RpcDispatchError",
      code: "handler-threw",
    });
  });

  describe("handler time limit", () => {
    function recordingStore(writeDelay?: Promise<void>) {
      const writes: string[] = [];
      const store = {
        getSession: async () => ({
          phase: "playing" as const,
          completedPlayerTurns: 0,
          locale: "en",
          setupRuntimes: {},
        }),
        listTurnMessages: async () => [],
        setPluginData: async (record: { key: string }) => {
          await writeDelay;
          writes.push(record.key);
        },
      };
      return { store, writes };
    }

    it("fails a handler that never finishes and refuses its later writes", async () => {
      const registry = createPluginRpcRegistry();
      const executor = createRpcExecutor({ registry, handlerTimeoutMs: 20 });
      const { store, writes } = recordingStore();
      let signal: AbortSignal | undefined;
      let writeLate!: () => Promise<void>;
      registry.registerPluginHandler(
        "stuck",
        "hang",
        async (_payload, context) => {
          signal = context.signal;
          writeLate = () =>
            context.store.setPluginData!({
              namespace: "state",
              key: "late",
              value: 1,
            });
          await context.store.setPluginData!({
            namespace: "state",
            key: "early",
            value: 1,
          });
          return new Promise(() => {});
        },
        {},
        "community",
      );

      await expect(
        executor.dispatch(
          { pluginId: "stuck", action: "hang", payload: null },
          { sessionId: "sess-1", store },
        ),
      ).rejects.toMatchObject({
        name: "RpcDispatchError",
        code: "handler-timeout",
      });
      expect(signal?.aborted).toBe(true);
      await expect(writeLate()).rejects.toThrow(/accepts no more calls/);
      expect(writes).toEqual(["early"]);
    });

    it("refuses writes from synchronous abort listeners", async () => {
      const registry = createPluginRpcRegistry();
      const executor = createRpcExecutor({ registry, handlerTimeoutMs: 20 });
      const { store, writes } = recordingStore();
      let lateWrite: Promise<void> | undefined;
      registry.registerPluginHandler(
        "stuck",
        "abort-write",
        async (_payload, context) => {
          context.signal!.addEventListener("abort", () => {
            lateWrite = context.store.setPluginData!({
              namespace: "state",
              key: "after-abort",
              value: 1,
            });
          });
          return new Promise(() => {});
        },
        {},
        "community",
      );
      await expect(
        executor.dispatch(
          { pluginId: "stuck", action: "abort-write", payload: null },
          { sessionId: "sess-1", store },
        ),
      ).rejects.toMatchObject({ code: "handler-timeout" });
      await expect(lateWrite).rejects.toThrow(/accepts no more calls/);
      expect(writes).toEqual([]);
    });

    it("settles a write already in flight before reporting the timeout", async () => {
      const registry = createPluginRpcRegistry();
      const executor = createRpcExecutor({ registry, handlerTimeoutMs: 20 });
      let finishWrite!: () => void;
      const { store, writes } = recordingStore(
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
      );
      registry.registerPluginHandler(
        "slow",
        "write",
        async (_payload, context) => {
          await context.store.setPluginData!({
            namespace: "state",
            key: "in-flight",
            value: 1,
          });
          return "done";
        },
        {},
        "community",
      );

      let settled = false;
      const dispatched = executor
        .dispatch(
          { pluginId: "slow", action: "write", payload: null },
          { sessionId: "sess-1", store },
        )
        .finally(() => {
          settled = true;
        });
      dispatched.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 60));
      // The limit has passed, but the caller still holds the lock while the
      // store write it started is unsettled.
      expect(settled).toBe(false);
      finishWrite();
      await expect(dispatched).rejects.toMatchObject({
        code: "handler-timeout",
      });
      expect(writes).toEqual(["in-flight"]);
    });

    it("refuses a write the handler left running after it returned", async () => {
      const registry = createPluginRpcRegistry();
      const executor = createRpcExecutor({ registry });
      const { store, writes } = recordingStore();
      let floating: Promise<void> | undefined;
      registry.registerPluginHandler(
        "leaky",
        "fire-and-forget",
        async (_payload, context) => {
          setTimeout(() => {
            floating = context.store.setPluginData!({
              namespace: "state",
              key: "after-return",
              value: 1,
            });
          }, 0);
          return "returned";
        },
        {},
        "community",
      );

      await expect(
        executor.dispatch(
          { pluginId: "leaky", action: "fire-and-forget", payload: null },
          { sessionId: "sess-1", store },
        ),
      ).resolves.toMatchObject({ result: "returned" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await expect(floating).rejects.toThrow(/accepts no more calls/);
      expect(writes).toEqual([]);
    });
  });

  it("lookupEntry exposes resolution without invoking the handler", () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault("cancel", async () => null);
    const entry = executor.lookupEntry("framework", "cancel");
    expect(entry.action).toBe("cancel");
  });

  it("RpcDispatchError preserves error semantics (instance check)", async () => {
    const { executor } = makeExecutor();
    try {
      await executor.dispatch(
        { pluginId: "p", action: "a", payload: null },
        { sessionId: "sess-1", store: {} as never },
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RpcDispatchError);
    }
  });
});

describe("createRpcHandlerStoreView", () => {
  it("binds action-level RPC reads and writes to the current session and plugin", async () => {
    const store = {
      getSession: vi.fn(async (id: string) => ({
        id,
        incarnation: "inc-1",
        status: "active",
        phase: "setup",
        completedPlayerTurns: 0,
        locale: "en-US",
        activePlugins: ["plugin-real"],
        setupRuntimes: {
          "plugin-real/opening": {
            state: "pending",
            pluginVersion: "1.0.0",
            generation: 1,
            attempts: 1,
            lastError: "model timed out",
          },
        },
        createdAt: "2026-04-30T00:00:00.000Z",
        updatedAt: "2026-04-30T00:00:00.000Z",
      })),
      listRecentTurnMessages: vi.fn(
        async (sessionId: string, _limit: number) => [{ sessionId }],
      ),
      setPluginData: vi.fn(
        async (_record: Record<string, unknown>) => undefined,
      ),
      getPluginData: vi.fn(
        async (
          sessionId: string,
          pluginId: string,
          namespace: string,
          key: string,
        ) => ({ sessionId, pluginId, namespace, key }),
      ),
      listPluginData: vi.fn(
        async (sessionId: string, pluginId: string, namespace?: string) => [
          { sessionId, pluginId, namespace },
        ],
      ),
    };
    const scoped = createRpcHandlerStoreView(store as never, {
      sessionId: "sess-real",
      pluginId: "plugin-real",
    });

    // Plugin code reads a projection of the session, never the record.
    expect(await scoped.getSession()).toEqual({
      phase: "setup",
      completedPlayerTurns: 0,
      locale: "en-US",
      setupRuntimes: {
        "plugin-real/opening": {
          state: "pending",
          lastError: "model timed out",
        },
      },
    });
    await scoped.listTurnMessages();
    await scoped.listTurnMessages(5);
    await scoped.listTurnMessages(1_000_000);
    // Forged identity fields are not part of the view's types; held in variables
    // they reach the view as a plugin could send them, and must be ignored.
    const forgedData = {
      sessionId: "sess-attacker",
      pluginId: "plugin-attacker",
      namespace: "ns",
      key: "key",
      value: 1,
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
    };
    await scoped.setPluginData?.(forgedData);
    await scoped.getPluginData?.("ns", "key");
    await scoped.listPluginData?.("ns");

    expect(store.getSession).toHaveBeenCalledWith("sess-real");
    // Recent messages only, never more than the ceiling.
    expect(
      store.listRecentTurnMessages.mock.calls.map(([id, limit]) => [id, limit]),
    ).toEqual([
      ["sess-real", 200],
      ["sess-real", 5],
      ["sess-real", 200],
    ]);
    expect(scoped).not.toHaveProperty("savePlayerInput");
    expect(store.setPluginData.mock.calls[0]![0]).toMatchObject({
      sessionId: "sess-real",
      pluginId: "plugin-real",
      namespace: "ns",
      key: "key",
      value: 1,
    });
    expect(store.getPluginData).toHaveBeenCalledWith(
      "sess-real",
      "plugin-real",
      "ns",
      "key",
    );
    expect(store.listPluginData).toHaveBeenCalledWith(
      "sess-real",
      "plugin-real",
      "ns",
    );
  });
});
