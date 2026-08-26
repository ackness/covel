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
    expect(warnSpy.mock.calls[0][0]).toContain("clamping to community");
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
      getSession: vi.fn(async (id: string) => ({ id })),
      listTurnMessages: vi.fn(async (sessionId: string) => [{ sessionId }]),
      savePlayerInput: vi.fn(
        async (_input: Record<string, unknown>) => undefined,
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

    await scoped.getSession("sess-attacker");
    await scoped.listTurnMessages("sess-attacker");
    await scoped.savePlayerInput({
      id: "input-1",
      sessionId: "sess-attacker",
      turnId: "turn-1",
      formId: "form-1",
      values: {},
      createdAt: "2026-04-30T00:00:00.000Z",
    });
    await scoped.setPluginData?.({
      sessionId: "sess-attacker",
      pluginId: "plugin-attacker",
      namespace: "ns",
      key: "key",
      value: 1,
      createdAt: "2026-04-30T00:00:00.000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
    });
    await scoped.getPluginData?.(
      "sess-attacker",
      "plugin-attacker",
      "ns",
      "key",
    );
    await scoped.listPluginData?.("sess-attacker", "plugin-attacker", "ns");

    expect(store.getSession).toHaveBeenCalledWith("sess-real");
    expect(store.listTurnMessages).toHaveBeenCalledWith("sess-real");
    expect(store.savePlayerInput.mock.calls[0][0].sessionId).toBe("sess-real");
    expect(store.setPluginData.mock.calls[0][0]).toMatchObject({
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
