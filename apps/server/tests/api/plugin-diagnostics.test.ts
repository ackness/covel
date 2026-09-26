import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  createPluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import {
  createHookPipeline,
  createPluginRpcRegistry,
  PluginServiceRegistry,
  type PluginServiceCallEvent,
} from "@covel/runtime";
import { createMemoryStore, type SessionRecord } from "@covel/store";
import { tool, ToolRegistry } from "@covel/tools";
import {
  createPluginDiagnostics,
  RecentPluginServiceCalls,
} from "../../src/routes/api/plugin-diagnostics.js";
import {
  hashSessionOwnerToken,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";

afterEach(() => vi.unstubAllEnvs());

function session(id = "session", incarnation = "original"): SessionRecord {
  return {
    id,
    worldId: "fixture",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    completedPlayerTurns: 0,
    activePlugins: ["builtin", "community", "pending", "failed", "broken"],
    metadata: {
      sessionIncarnationNonce: incarnation,
      approvalScopeNonce: "private-approval-scope",
      ownerTokenHash: hashSessionOwnerToken("fixture-owner-token"),
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function callEvent(
  owner: SessionRecord,
  callId: string,
  overrides: Partial<PluginServiceCallEvent> = {},
): PluginServiceCallEvent {
  return {
    sessionId: owner.id,
    diagnosticScope: sessionIncarnationIdentity(owner),
    callId,
    callerPluginId: "consumer",
    providerPluginId: "provider",
    name: "rank",
    contract: "fixture/rank@1",
    durationMs: 2,
    outcome: "success",
    ...overrides,
  };
}

function fixture() {
  const registry = createPluginRegistry();
  const tools = new ToolRegistry();
  const hooks = createHookPipeline();
  const rpc = createPluginRpcRegistry();
  const ensure = vi.fn(async () => {});
  const services = new PluginServiceRegistry({
    ensure,
    list: async () => [],
  });
  const calls = new RecentPluginServiceCalls();
  const approved = new Set<string>();
  const pending = new Set<string>();
  const diagnostics = createPluginDiagnostics({
    registry,
    tools,
    hooks,
    rpc,
    services,
    calls,
    hasPendingEntry: (pluginId) => pending.has(pluginId),
    isServerCodeApproved: (_session, pluginId) => approved.has(pluginId),
  });
  function registerPlugin(
    id: string,
    overrides: Partial<PluginRegistryEntry> = {},
  ) {
    registry.register({
      id,
      source: "builtin",
      summary: {
        id,
        name: id,
        description: "private-description",
        pluginType: "plugin",
        runtimeCount: 1,
      },
      manifest: {
        manifest: {
          name: `${id}/runtime`,
          description: "private-description",
          stage: "post-turn",
          commands: [
            { name: "inspect", action: "inspect-action" },
            { name: "missing", action: "missing-action" },
          ],
        },
        promptTemplate: "private-prompt",
        rawFrontmatter: { secret: "private-frontmatter" },
      },
      loadedRuntimes: new Map(),
      status: "registered",
      ...overrides,
    });
  }
  return {
    registry,
    tools,
    hooks,
    rpc,
    services,
    calls,
    diagnostics,
    approved,
    pending,
    ensure,
    registerPlugin,
  };
}

describe("recent plugin service calls", () => {
  it("bounds the global history and returns the latest 100 matching calls", () => {
    const calls = new RecentPluginServiceCalls();
    const first = session("first");
    const second = session("second");
    calls.record(callEvent(first, "evicted"));
    for (let index = 0; index < 500; index++)
      calls.record(callEvent(second, `call-${index}`));
    expect(calls.list(first)).toEqual([]);
    const recent = calls.list(second);
    expect(recent).toHaveLength(100);
    expect(recent[0]!.callId).toBe("call-499");
    expect(recent[99]!.callId).toBe("call-400");
    expect(calls.list(second, "consumer")).toEqual(recent);
    expect(calls.list(second, "provider")).toEqual(recent);
    expect(calls.list(second, "other")).toEqual([]);
  });

  it("omits unscoped calls and isolates replacements sharing a public session id", () => {
    const calls = new RecentPluginServiceCalls();
    const original = session();
    const replacement = session(original.id, "replacement");
    calls.record(callEvent(original, "original-call"));
    calls.record(
      callEvent(original, "unscoped", { diagnosticScope: undefined }),
    );
    calls.record(callEvent(replacement, "replacement-call"));
    calls.record(callEvent(original, "late-original-call"));
    expect(calls.list(replacement).map(({ callId }) => callId)).toEqual([
      "replacement-call",
    ]);
    expect(calls.list(original).map(({ callId }) => callId)).toEqual([
      "late-original-call",
      "original-call",
    ]);
    expect(calls.list(session("different-id", "original"))).toEqual([]);
    expect(JSON.stringify(calls.list(original))).not.toContain("incarnation");
  });

  it("copies only public metadata and bounds retained string fields", () => {
    const calls = new RecentPluginServiceCalls();
    const owner = session();
    const oversized = "x".repeat(2048);
    const event = callEvent(owner, oversized, {
      parentCallId: oversized,
      turnId: oversized,
      runtimeId: oversized,
      callerPluginId: oversized,
      providerPluginId: oversized,
      name: oversized,
      contract: oversized,
      outcome: "error",
      errorCode: "invocation-error",
    });
    Object.assign(event, {
      input: "private-input",
      output: "private-output",
      error: new Error("private-error"),
      gateway: { apiKey: "private-key" },
    });
    calls.record(event);
    Object.assign(event, { name: "mutated" });
    const [copy] = calls.list(owner);
    for (const key of [
      "callId",
      "parentCallId",
      "turnId",
      "runtimeId",
      "callerPluginId",
      "providerPluginId",
      "name",
      "contract",
    ] as const) {
      expect(copy![key]).toHaveLength(256);
      expect(copy![key]).toMatch(/\.\.\.\[truncated\]$/);
    }
    expect(JSON.stringify(copy)).not.toContain("private-");
    expect(copy).not.toHaveProperty("diagnosticScope");
    expect(copy).not.toHaveProperty("sessionId");
    Object.assign(copy!, { name: "mutated-copy" });
    expect(calls.list(owner)[0]!.name).toMatch(/\[truncated\]$/);

    calls.record(callEvent(owner, "exact-boundary", { name: "y".repeat(256) }));
    expect(calls.list(owner)[0]!.name).toBe("y".repeat(256));
  });
});

describe("plugin diagnostics snapshots", () => {
  it("reads actual registrations, exposes no handlers, and follows disposal", () => {
    const { registerPlugin, diagnostics, tools, hooks, rpc, services, ensure } =
      fixture();
    registerPlugin("builtin");
    const handler = vi.fn(async () => "private-handler-result");
    const match = vi.fn(() => true);
    const disposeTool = tools.registerPlugin(
      "builtin",
      tool({
        name: "dynamic-tool",
        description: "private-tool-description",
        parameters: z.object({}),
        execute: handler,
      }),
    );
    const disposeHook = hooks.register({
      id: "dynamic-hook",
      event: "TurnStart",
      pluginId: "builtin",
      match,
      handler: async () => ({ action: "continue" }),
    });
    const disposeAction = rpc.registerPluginHandler(
      "builtin",
      "inspect-action",
      handler,
      {},
      "builtin",
    );
    const disposeService = services.register("builtin", {
      name: "dynamic-service",
      contract: "fixture/dynamic@1",
      input: z.unknown(),
      output: z.unknown(),
      handler,
    });
    const [snapshot] = diagnostics.snapshot(session()).plugins;
    expect(snapshot).toMatchObject({
      state: "ready",
      runtimeIds: ["builtin/runtime"],
      registrations: {
        tools: ["dynamic-tool"],
        hooks: [{ id: "dynamic-hook", event: "TurnStart" }],
        actions: ["inspect-action"],
        services: [{ name: "dynamic-service", contract: "fixture/dynamic@1" }],
      },
      commands: [
        { name: "inspect", action: "inspect-action", registered: true },
        { name: "missing", action: "missing-action", registered: false },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-");
    expect(handler).not.toHaveBeenCalled();
    expect(match).not.toHaveBeenCalled();
    expect(ensure).not.toHaveBeenCalled();
    expect(hooks.list()[0]).not.toHaveProperty("handler");
    expect(hooks.list()[0]).not.toHaveProperty("match");
    Object.assign(hooks.list()[0]!, { id: "mutated", event: "TurnStop" });
    Object.assign(snapshot!.registrations.hooks[0]!, { id: "mutated" });
    expect(
      diagnostics.snapshot(session()).plugins[0]!.registrations.hooks,
    ).toEqual([{ id: "dynamic-hook", event: "TurnStart" }]);
    disposeTool();
    disposeHook();
    disposeAction();
    disposeService();
    expect(diagnostics.snapshot(session()).plugins[0]!.registrations).toEqual({
      tools: [],
      hooks: [],
      actions: [],
      services: [],
    });
    expect(
      diagnostics.snapshot(session()).plugins[0]!.commands[0]!.registered,
    ).toBe(false);
  });

  it("reports inactive, approval, pending, activation and discovery states", () => {
    const { registerPlugin, diagnostics, rpc, approved, pending } = fixture();
    registerPlugin("builtin");
    registerPlugin("inactive");
    registerPlugin("community", { source: "community" });
    registerPlugin("pending");
    registerPlugin("failed", { error: "private-activation-error" });
    registerPlugin("broken", { status: "error", error: "private-load-error" });
    pending.add("pending");
    rpc.registerPluginHandler(
      "community",
      "inspect-action",
      async () => null,
      {},
      "community",
    );
    const snapshot = diagnostics.snapshot(session());
    expect(
      Object.fromEntries(
        snapshot.plugins.map((plugin) => [plugin.pluginId, plugin.state]),
      ),
    ).toEqual({
      builtin: "ready",
      inactive: "inactive",
      community: "approval-required",
      pending: "entry-pending",
      failed: "activation-error",
      broken: "load-error",
    });
    expect(
      snapshot.plugins.find(({ pluginId }) => pluginId === "community")!
        .registrations.actions,
    ).toEqual([]);
    approved.add("community");
    expect(diagnostics.snapshot(session(), "community").plugins).toEqual([
      expect.objectContaining({
        state: "ready",
        registrations: expect.objectContaining({ actions: ["inspect-action"] }),
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("private-");
  });

  it("accepts query-token authentication while rejecting unknown query options", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "commercial");
    vi.stubEnv("COVEL_DESKTOP_REST_TOKEN", "");
    const { diagnostics, registerPlugin } = fixture();
    registerPlugin("builtin");
    const store = createMemoryStore();
    await store.createSession(session());
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      await next();
    });
    app.route("/api/sessions", diagnostics.routes);
    const path = "/api/sessions/session/plugin-diagnostics";
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(`${path}?session_token=wrong`)).status).toBe(401);
    const authorized = `${path}?session_token=fixture-owner-token`;
    const result = await app.request(`${authorized}&pluginId=builtin`);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("no-store");
    expect(await result.text()).not.toContain("fixture-owner-token");
    expect((await app.request(`${authorized}&unknown=true`)).status).toBe(400);
    expect((await app.request(`${authorized}&pluginId=missing`)).status).toBe(
      404,
    );
    await store.close();
  });
});
