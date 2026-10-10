/**
 * POST /api/sessions/:id/plugin-rpc integration tests.
 */

import { createTestRuntimeJobWorker } from "./__helpers/runtime-job-worker.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { type DataStore, type MediaStore } from "@covel/store";
import { createMemoryMediaStore, createMemoryStore } from "@covel/store/memory";
import {
  PluginExtensionHost,
  PluginServiceRegistry,
  createPluginRpcRegistry,
  createRpcExecutor,
  type PluginRpcRegistry,
  type RpcExecutor,
  type LLMAdapter,
  type LLMResponse,
  type RpcHandlerContext,
} from "@covel/runtime";
import { createRpcApprovalGate, type RpcApprovalGate } from "@covel/approval";
import {
  createPluginRegistry,
  type PluginRegistry,
  type PluginRegistryEntry,
  type PluginSummary,
  type PluginSource,
  type LoadedRuntime,
  type FunctionHandler,
} from "@covel/plugin-loader";
import type { LLMMessage, RuntimeManifest } from "@covel/shared";
import { createEventBus } from "@covel/events";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import {
  createInProcessSessionLock,
  SessionLockTimeoutError,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";
import { publicPluginDataValue } from "../../src/routes/api/plugin-rpc/runtime-job-public.js";
import branchReplyHandler from "../../../../plugins/branch-reply/handler.js";
import branchReplyEntry from "../../../../plugins/branch-reply/server/index.js";
import { makeErrorHandler } from "../../src/api-error.js";
import { setSessionWorld } from "../helpers/session-world.js";

type Env = {
  Variables: {
    store: DataStore;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
  };
};

function setup(): {
  app: Hono<Env>;
  store: DataStore;
  registry: PluginRpcRegistry;
  executor: RpcExecutor;
  gate: RpcApprovalGate;
  pluginRegistry: PluginRegistry;
  sessionLock: SessionLock;
} {
  const store = createMemoryStore();
  const registry = createPluginRpcRegistry();
  registry.registerFrameworkDefault("echo", async (payload) => ({
    echoed: payload,
  }));
  const executor = createRpcExecutor({ registry });
  const gate = createRpcApprovalGate();
  const pluginRegistry = createPluginRegistry();
  const sessionLock = createInProcessSessionLock();
  const app = new Hono<Env>();
  app.onError(makeErrorHandler("[test]", false));
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("rpcExecutor", executor);
    c.set("rpcRegistry", registry);
    c.set("rpcApprovalGate", gate);
    // Minimal pluginRegistry so the runtimeId branch can resolve "runtime
    // not found" without 500ing on missing DI. Full executeTurn wiring is
    // covered by the bootstrap integration tests.
    c.set("pluginRegistry", pluginRegistry);
    c.set("sessionLock", sessionLock);
    c.set(
      "resolveModel",
      (manifest: RuntimeManifest, override?: string) =>
        `resolved:${override ?? manifest.model ?? "default"}`,
    );
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  ownClientAddress(app);
  return {
    app,
    store,
    registry,
    executor,
    gate,
    pluginRegistry,
    sessionLock,
  };
}

let nextClient = 0;

/**
 * The route's rate limiter counts per client address and route template and
 * lives as long as the module. Give each app an address of its own so one
 * test's requests do not use up another's budget.
 */
function ownClientAddress(app: { request: Hono["request"] }): void {
  const clientAddress = `10.1.${Math.trunc(nextClient / 250)}.${nextClient % 250}`;
  nextClient++;
  const request = app.request.bind(app);
  app.request = ((
    input: RequestInfo | URL,
    init?: RequestInit,
    env?: unknown,
  ) =>
    request(
      input,
      init,
      env ?? { incoming: { socket: { remoteAddress: clientAddress } } },
    )) as typeof app.request;
}

async function seedSession(
  store: DataStore,
  id = "sess-rpc-1",
  locale = "zh-CN",
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    phase: "playing",
    setupRuntimes: {},
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id,
    worldId: "cloudmere",
    status: "active",
    completedPlayerTurns: 1,

    locale,
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

async function decideSessionApproval(
  gate: RpcApprovalGate,
  store: DataStore,
  sessionId: string,
  pluginId: string,
  approvalId: string,
) {
  const session = await store.getSession(sessionId);
  if (!session) throw new Error("expected session");
  return gate.decide(
    {
      approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    },
    sessionApprovalScope(session, pluginId),
  );
}

describe("POST /api/sessions/:id/plugin-rpc", () => {
  let app: Hono<Env>;
  let store: DataStore;
  let registry: PluginRpcRegistry;
  let pluginRegistry: PluginRegistry;
  let sessionLock: SessionLock;

  beforeEach(async () => {
    ({ app, store, registry, pluginRegistry, sessionLock } = setup());
    await seedSession(store);
  });

  it("lets the global handler report lock contention and log unexpected dispatch failures", async () => {
    await seedSession(store, "sess-rpc-error");
    for (const [error, status, body] of [
      [
        new SessionLockTimeoutError("private session lock detail"),
        503,
        { error: "Session is busy, please retry", code: "session_busy" },
      ],
      [
        new Error("private storage detail"),
        500,
        { error: "Internal server error" },
      ],
    ] as const) {
      const log = vi
        .spyOn(console, status === 503 ? "warn" : "error")
        .mockImplementation(() => {});
      const lock = vi
        .spyOn(sessionLock, "withLock")
        .mockRejectedValueOnce(error);
      try {
        const response = await app.request(
          "/api/sessions/sess-rpc-error/plugin-rpc",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: "action",
              pluginId: "framework",
              action: "echo",
              payload: {},
            }),
          },
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        expect(log).toHaveBeenCalled();
        expect(log.mock.calls[0]?.[0]).toContain("POST");
      } finally {
        lock.mockRestore();
        log.mockRestore();
      }
    }
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.request("/api/sessions/missing/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "echo",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when kind action omits action", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "action", pluginId: "framework" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when kind action includes a runtime selector", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "echo",
        runtimeId: "narrator",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when runtime is not active in session", async () => {
    // With an empty pluginRegistry in setup(), no runtime is active; the
    // handler should surface this as 404 "runtime_not_active" rather than
    // attempting to execute a nonexistent runtime.
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: "codex",
        runtimeId: "codex",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("runtime_not_active");
    expect(body).not.toHaveProperty("status");
  });

  it("dispatches a framework default action and returns the result", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "echo",
        payload: { hello: "world" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe("ok");
    expect(body.result).toEqual({ echoed: { hello: "world" } });
  });

  it("resolves a command server-side and returns refreshed scoped context", async () => {
    const runtime: RuntimeManifest = {
      name: "inspector/story",
      pluginId: "inspector",
      description: "Inspector story runtime",
      runtimeType: "agent",
      outputKind: "story",
      model: "story",
      outputContract: "narrative@1",
      commands: [
        {
          name: "inspect",
          aliases: ["i"],
          description: "Inspect the session",
          arguments: [{ name: "depth", type: "integer", required: true }],
          action: "inspect-state",
          context: ["models"],
        },
      ],
    };
    const parsed = {
      runtime: { type: runtime.runtimeType ?? ("agent" as const) },
      manifest: runtime,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: "inspector",
      packageManifest: {
        ...parsed,
        plugin: {
          id: "inspector",
          kind: "plugin",
          description: "Inspector",
          contributes: { commands: runtime.commands },
        },
      },
      summary: {
        id: "inspector",
        name: "Inspector",
        description: "Inspector",
        pluginType: "plugin",
        runtimeCount: 1,
      },

      manifests: [parsed],
      loadedRuntimes: new Map([
        [runtime.name, { manifest: runtime, promptTemplate: "" }],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const handlerContexts: RpcHandlerContext[] = [];
    const handlerPayloads: unknown[] = [];
    registry.registerPluginHandler(
      "inspector",
      "inspect-state",
      async (payload, context) => {
        handlerContexts.push(context);
        handlerPayloads.push(payload);
        if (context.command?.source === "composer") {
          await store.updateSession("sess-rpc-1", {
            runtimeModelOverrides: { "inspector/story": "after" },
          });
        }
        return { ok: true };
      },
      {},
      "builtin",
    );
    await store.updateSession("sess-rpc-1", {
      activePlugins: ["inspector"],
      runtimeModelOverrides: { "inspector/story": "before" },
    });

    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "command",
        commandId: "inspector:inspect",
        input: "/i 3",
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerPayloads[0]).toMatchObject({
      command: "inspect",
      commandId: "inspector:inspect",
      canonical: "/inspect 3",
      raw: "/i 3",
      argv: ["3"],
      args: { depth: 3 },
      source: "composer",
    });
    expect(handlerContexts[0]?.environment?.session).toBeUndefined();
    expect(handlerContexts[0]?.environment?.activeRuntimes?.[0]?.model).toEqual(
      {
        slot: "before",
        resolved: "resolved:before",
        source: "session-override",
      },
    );
    const body = (await res.json()) as {
      environment?: {
        activeRuntimes?: Array<{ model?: { slot: string; resolved?: string } }>;
      };
    };
    expect(body.environment?.activeRuntimes?.[0]?.model).toMatchObject({
      slot: "after",
      resolved: "resolved:after",
    });

    const uiRes = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "command",
        commandId: "inspector:inspect",
        args: { depth: 3 },
      }),
    });
    expect(uiRes.status).toBe(200);
    expect(handlerPayloads[1]).toMatchObject({
      command: "inspect",
      commandId: "inspector:inspect",
      canonical: "/inspect 3",
      raw: "/inspect 3",
      argv: ["3"],
      args: { depth: 3 },
      source: "plugin-ui",
    });
    expect(handlerContexts[1]?.command).toEqual(handlerPayloads[1]);
    expect(handlerPayloads[1]).toMatchObject({
      canonical: (handlerPayloads[0] as { canonical: string }).canonical,
      args: (handlerPayloads[0] as { args: unknown }).args,
    });

    const commandEvents = (await store.listTraceEvents("sess-rpc-1")).filter(
      (event) => event.type.startsWith("command."),
    );
    expect(
      commandEvents.map((event) => ({
        type: event.type,
        source: (event.payload as { source?: string }).source,
        commandId: (event.payload as { commandId?: string }).commandId,
      })),
    ).toEqual([
      {
        type: "command.invoked",
        source: "composer",
        commandId: "inspector:inspect",
      },
      {
        type: "command.completed",
        source: "composer",
        commandId: "inspector:inspect",
      },
      {
        type: "command.invoked",
        source: "plugin-ui",
        commandId: "inspector:inspect",
      },
      {
        type: "command.completed",
        source: "plugin-ui",
        commandId: "inspector:inspect",
      },
    ]);
    expect(commandEvents[0]?.traceId).toBe(
      (commandEvents[0]?.payload as { invocationId?: string } | undefined)
        ?.invocationId,
    );
    expect(commandEvents[0]?.traceId).not.toBe(commandEvents[2]?.traceId);
  });

  it("rejects commands that are not in the current active-plugin directory", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "command",
        commandId: "inactive:inspect",
        input: "/inspect",
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ code: "command_not_active" });
    expect(body).not.toHaveProperty("status");
  });

  it("rejects an action paused while it waits for the session lock", async () => {
    let releaseHolder!: () => void;
    let markHolderStarted!: () => void;
    const holderStarted = new Promise<void>((resolve) => {
      markHolderStarted = resolve;
    });
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = sessionLock.withLock("sess-rpc-1", async () => {
      markHolderStarted();
      await holderGate;
    });
    await holderStarted;

    const originalGetSession = store.getSession.bind(store);
    let markInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      markInitialRead = resolve;
    });
    const getSpy = vi
      .spyOn(store, "getSession")
      .mockImplementation(async (id) => {
        const current = await originalGetSession(id);
        markInitialRead();
        return current;
      });
    const request = app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "echo",
        payload: { shouldNotRun: true },
      }),
    });
    await initialRead;
    await store.updateSession("sess-rpc-1", { status: "paused" });
    releaseHolder();
    await holder;

    const res = await request;
    getSpy.mockRestore();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_not_active" });
  });

  it("gives builtin plugin actions scoped immediate writes without host store authority", async () => {
    await store.updateSession("sess-rpc-1", { activePlugins: ["codex"] });
    let exposed: string[] = [];
    const createdAt = "2026-01-01T00:00:00.000Z";
    await store.setPluginData({
      id: "existing-entry",
      sessionId: "sess-rpc-1",
      pluginId: "codex",
      namespace: "entries",
      key: "entry",
      value: { ready: false },
      createdAt,
      updatedAt: createdAt,
    });
    registry.registerPluginHandler(
      "codex",
      "edit",
      async (_payload, context) => {
        exposed = ["withTransaction", "close", "updateSession"].filter(
          (name) => typeof Reflect.get(context.store, name) === "function",
        );
        // A hostile handler names a foreign session; the bound view must
        // ignore the argument.
        const getSession = context.store.getSession as (
          sessionId: string,
        ) => Promise<unknown>;
        const snapshot = (await getSession("other")) as {
          status: string;
        };
        snapshot.status = "ended";
        const value = { ready: true };
        const now = new Date().toISOString();
        // Foreign identity fields are not part of the view's record type.
        const foreignRecord = {
          sessionId: "other",
          pluginId: "other",
          namespace: "entries",
          key: "entry",
          value,
          createdAt: now,
          updatedAt: now,
        };
        await context.store.setPluginData!(foreignRecord);
        value.ready = false;
        throw new Error("after the immediate write");
      },
      {},
      "builtin",
    );
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "codex",
        action: "edit",
      }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Internal server error" });
    expect(exposed).toEqual([]);
    expect((await store.getSession("sess-rpc-1"))?.status).toBe("active");
    expect(
      await store.getPluginData("sess-rpc-1", "codex", "entries", "entry"),
    ).toMatchObject({
      id: "existing-entry",
      createdAt,
      value: { ready: true },
    });
    expect(
      await store.getPluginData("other", "other", "entries", "entry"),
    ).toBeNull();
  });

  it.each(["builtin", "community"] as const)(
    "rejects actions from a disabled %s plugin before approval or handler execution",
    async (trust) => {
      const handler = vi.fn(async () => ({ updated: true }));
      registry.registerPluginHandler("fixture", "update", handler, {}, trust);
      const response = await app.request(
        "/api/sessions/sess-rpc-1/plugin-rpc",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "action",
            pluginId: "fixture",
            action: "update",
          }),
        },
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "plugin_not_active",
      });
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it("rechecks action activation after waiting for the session lock", async () => {
    const { app, store, registry, sessionLock, gate } = setup();
    await seedSession(store);
    await store.updateSession("sess-rpc-1", { activePlugins: ["fixture"] });
    const handler = vi.fn(async () => ({ updated: true }));
    registry.registerPluginHandler("fixture", "update", handler, {}, "builtin");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const evaluate = gate.evaluate.bind(gate);
    vi.spyOn(gate, "evaluate").mockImplementation((input) => {
      admitted.resolve();
      return evaluate(input);
    });
    const owner = sessionLock.withLock("sess-rpc-1", async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const pending = app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "fixture",
        action: "update",
      }),
    });
    await admitted.promise;
    await store.updateSession("sess-rpc-1", { activePlugins: [] });
    release.resolve();
    await owner;
    const response = await pending;
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "plugin_not_active" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("dispatches an entry-registered plugin action", async () => {
    await store.updateSession("sess-rpc-1", { activePlugins: ["codex"] });
    registry.registerPluginHandler(
      "codex",
      "regenerate",
      async (payload) => ({ pluginEcho: payload }),
      {},
      "builtin",
    );

    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "codex",
        action: "regenerate",
        payload: { card: "shrine" },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; result: unknown };
    expect(body.status).toBe("ok");
    expect(body.result).toEqual({ pluginEcho: { card: "shrine" } });
  });

  it('returns 404 with code "unknown_action" when action not registered', async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "nonexistent",
        action: "whatever",
        payload: null,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("unknown_action");
    expect(body).not.toHaveProperty("status");
  });

  it("has no framework action that stores a form answer without its turn", async () => {
    // Answers go through the `submit_interaction` action, which stores them
    // and runs the follow-up turn as one step.
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "framework",
        action: "submit-form",
        payload: { turnId: "turn-1", submissions: [] },
      }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code?: string }).code).toBe(
      "unknown_action",
    );
  });

  it("rejects framework actions when pluginId is not the canonical sentinel", async () => {
    // `echo` is a framework default but the request uses pluginId="codex".
    // The canonical sentinel is "framework" — anything else gets 404.
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: "codex",
        action: "echo",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown_action");
  });
});

// ── Action-level deferred community entry (H2) ───────────────────────────
//
// A community plugin that migrated its rpc actions to a deferred `entry`
// module has NO registered declaration until the entry runs, and community
// entry code must not run before the approval gate clears. So an unregistered
// action on such a plugin must route through the gate (approval-required),
// not hard-404. After approval, activation runs the entry and the action
// dispatches; a genuinely-unknown action 404s once the entry is active.

describe("POST /api/sessions/:id/plugin-rpc — deferred community entry (H2)", () => {
  const PLUGIN_ID = "community-entry-plug";

  function setupEntry(): {
    app: Pick<Hono, "request">;
    store: DataStore;
    registry: PluginRpcRegistry;
    gate: RpcApprovalGate;
    activateCalls: () => number;
  } {
    const store = createMemoryStore();
    const registry = createPluginRpcRegistry();
    const executor = createRpcExecutor({ registry });
    const gate = createRpcApprovalGate();
    let activated = false;
    let activateCount = 0;
    // Simulates activatePluginServerCode: running the entry registers the
    // action into the rpc registry. Idempotent.
    const activate = async (pluginId: string): Promise<void> => {
      activateCount += 1;
      if (pluginId === PLUGIN_ID && !activated) {
        activated = true;
        registry.registerPluginHandler(
          PLUGIN_ID,
          "entry-action",
          async (payload) => ({ handled: payload }),
          {},
          "community",
        );
      }
    };
    // Pending until the entry has run (community, has entry, not yet invoked).
    const hasPendingEntry = (pluginId: string): boolean =>
      pluginId === PLUGIN_ID && !activated;

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("rpcExecutor", executor);
      c.set("rpcRegistry", registry);
      c.set("rpcApprovalGate", gate);
      c.set("pluginRegistry", createPluginRegistry());
      c.set("hasPendingPluginEntry", hasPendingEntry);
      c.set("activatePluginServerCode", activate);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    ownClientAddress(app);
    return { app, store, registry, gate, activateCalls: () => activateCount };
  }

  function call(app: Pick<Hono, "request">, action: string) {
    return app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "action",
        pluginId: PLUGIN_ID,
        action,
        payload: { n: 1 },
      }),
    });
  }

  it("routes an entry-registered action through the approval gate instead of 404", async () => {
    const { app, store, registry, activateCalls } = setupEntry();
    await seedSession(store);
    await store.updateSession("sess-rpc-1", { activePlugins: [PLUGIN_ID] });

    const res = await call(app, "entry-action");

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      approvalId?: string;
      pending?: { action: string };
    };
    expect(body.status).toBe("approval-required");
    expect(typeof body.approvalId).toBe("string");
    expect(body.pending?.action).toBe("covel:plugin-server-code");
    // The community entry MUST NOT have run before approval.
    expect(activateCalls()).toBe(0);
    expect(registry.getPluginAction(PLUGIN_ID, "entry-action")).toBeUndefined();
  });

  it("activates the entry and dispatches after the approval is granted", async () => {
    const { app, store, gate, registry } = setupEntry();
    await seedSession(store);
    await store.updateSession("sess-rpc-1", { activePlugins: [PLUGIN_ID] });

    const first = await call(app, "entry-action");
    const { approvalId } = (await first.json()) as { approvalId: string };
    await decideSessionApproval(
      gate,
      store,
      "sess-rpc-1",
      PLUGIN_ID,
      approvalId,
    );

    const actionApproval = await call(app, "entry-action");
    expect(actionApproval.status).toBe(202);
    const secondPending = (await actionApproval.json()) as {
      approvalId: string;
      pending: { action: string };
    };
    expect(secondPending.pending.action).toBe("entry-action");
    await decideSessionApproval(
      gate,
      store,
      "sess-rpc-1",
      PLUGIN_ID,
      secondPending.approvalId,
    );

    const third = await call(app, "entry-action");
    expect(third.status).toBe(200);
    const body = (await third.json()) as {
      status: string;
      result: { handled: { n: number } };
    };
    expect(body.status).toBe("ok");
    expect(body.result).toEqual({ handled: { n: 1 } });
    // Entry ran → action now registered.
    expect(registry.getPluginAction(PLUGIN_ID, "entry-action")).toBeDefined();
  });

  it("404s a genuinely-unknown action once the entry is active", async () => {
    const { app, store, gate } = setupEntry();
    await seedSession(store);
    await store.updateSession("sess-rpc-1", { activePlugins: [PLUGIN_ID] });

    // Approve loading the entry, then verify an undeclared action is rejected
    // before any action-specific approval is created.
    const first = await call(app, "does-not-exist");
    const { approvalId } = (await first.json()) as { approvalId: string };
    await decideSessionApproval(
      gate,
      store,
      "sess-rpc-1",
      PLUGIN_ID,
      approvalId,
    );
    const res = await call(app, "does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown_action");
  });
});

// ── Runtime-mode integration tests (plugin-rpc-runtime-pipeline M8b) ─────

type FakeLlm = LLMAdapter;

class CapturingLlm implements LLMAdapter {
  readonly calls: LLMMessage[][] = [];

  async generate(
    params: Parameters<LLMAdapter["generate"]>[0],
  ): Promise<LLMResponse> {
    this.calls.push([...params.messages]);
    return {
      content: "Next narrator output.",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function makeSummary(id: string): PluginSummary {
  return {
    id,
    name: id,
    description: "",
    pluginType: "plugin",
    runtimeCount: 1,
  };
}

/**
 * What a test handler may return: a full handler result, or a flat object the
 * fixture wraps into one (`events`, `pluginData` and the like become effects).
 */
type FlatHandler = (
  ctx: Parameters<FunctionHandler>[0],
) => Promise<Record<string, unknown>>;

function makeFunctionEntry(args: {
  pluginId: string;
  runtimeId: string;
  handler: FlatHandler;
  execution?: "sync" | "background";
  stage?: RuntimeManifest["stage"];
  /** Semantic capability tags for framework discovery. */
  capabilities?: readonly string[];
  /** Plugin discovery source — drives trust-gate verdict. Defaults to 'builtin'
   * so happy-path tests auto-allow without explicit approvals. Community
   * coverage is exercised by the approval-required test below. */
  source?: PluginSource;
  /** Per-runtime userSettings frontmatter coverage. */
  userSettings?: ReadonlyArray<{
    readonly key: string;
    readonly type: "text" | "number" | "toggle" | "select" | "textarea";
    readonly default: unknown;
    readonly label: string | Readonly<Record<string, string>>;
    readonly options?: ReadonlyArray<{
      readonly value: string;
      readonly label: string | Readonly<Record<string, string>>;
    }>;
  }>;
}): { entry: PluginRegistryEntry; loaded: LoadedRuntime } {
  // Note: `pluginType` is author-supplied and no longer affects the runtime
  // RPC trust gate. Trust now comes from `entry.source`, which the
  // server bootstrap derives from discovery (first-dir=bundled, others=community).
  const manifest: RuntimeManifest = {
    name: args.runtimeId,
    pluginId: args.pluginId,
    description: "test function runtime",
    stage: args.stage ?? "post-turn",
    runtimeType: "function",
    outputKind: "plugin",
    pluginType: "plugin",
    handler: "./handler.js",
    trigger: { type: "manual" },
    ...(args.execution ? { execution: args.execution } : {}),
    ...(args.capabilities ? { capabilities: args.capabilities } : {}),
    ...(args.userSettings ? { userSettings: args.userSettings } : {}),
  } as RuntimeManifest;

  const loaded: LoadedRuntime = {
    manifest,
    promptTemplate: "",
    handler: async (ctx) => {
      const raw = await args.handler(ctx);
      if (
        raw.kind === "covel.tool-result" ||
        raw.outcome === "success" ||
        raw.outcome === "failed" ||
        raw.outcome === "skipped" ||
        raw.outcome === "suspended"
      ) {
        return raw as never;
      }
      const {
        events,
        interactions,
        pluginData,
        assetGenerations,
        notifications,
        ui,
        statePatches,
        preGameDone,
        ...value
      } = raw;
      const effects = {
        ...(events ? { events } : {}),
        ...(interactions ? { interactions } : {}),
        ...(pluginData ? { pluginData } : {}),
        ...(assetGenerations ? { assetGenerations } : {}),
        ...(notifications ? { notifications } : {}),
        ...(ui ? { ui } : {}),
        ...(statePatches ? { statePatches } : {}),
      };
      return {
        outcome: "success",
        value: value as never,
        ...(Object.keys(effects).length > 0
          ? { effects: effects as never }
          : {}),
        ...(preGameDone === true ? { completion: "done" as const } : {}),
      };
    },
  };

  const parsed = {
    runtime: { type: manifest.runtimeType ?? ("agent" as const) },
    manifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };

  const entry: PluginRegistryEntry = {
    id: args.pluginId,
    summary: makeSummary(args.pluginId),

    manifests: [parsed],
    loadedRuntimes: new Map([[args.runtimeId, loaded]]),
    status: "registered",
    source: args.source ?? "builtin",
  } as PluginRegistryEntry;

  return { entry, loaded };
}

function makeAgentEntry(args: {
  pluginId: string;
  runtimeId: string;
  outputKind?: "story" | "plugin" | "system";
  stage?: RuntimeManifest["stage"];
  source?: PluginSource;
  trigger?: RuntimeManifest["trigger"];
}): { entry: PluginRegistryEntry; loaded: LoadedRuntime } {
  const manifest: RuntimeManifest = {
    name: args.runtimeId,
    pluginId: args.pluginId,
    description: "test agent runtime",
    stage: args.stage ?? "narrative",
    runtimeType: "agent",
    outputKind: args.outputKind ?? "story",
    pluginType: "plugin",
    trigger: args.trigger ?? { type: "manual" },
  } as RuntimeManifest;

  const loaded: LoadedRuntime = {
    manifest,
    promptTemplate: "You are a test narrator.",
  };
  const parsed = {
    runtime: { type: manifest.runtimeType ?? ("agent" as const) },
    manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  const entry: PluginRegistryEntry = {
    id: args.pluginId,
    summary: makeSummary(args.pluginId),

    manifests: [parsed],
    loadedRuntimes: new Map([[args.runtimeId, loaded]]),
    status: "registered",
    source: args.source ?? "builtin",
  } as PluginRegistryEntry;
  return { entry, loaded };
}

interface RuntimeTestEnv {
  app: Pick<Hono, "request">;
  store: DataStore;
  pluginRegistry: PluginRegistry;
  sessionLock: SessionLock;
}

function setupRuntimeTestEnv(args: {
  pluginId: string;
  runtimeId: string;
  handler: FlatHandler;
  execution?: "sync" | "background";
  source?: PluginSource;
  userSettings?: Parameters<typeof makeFunctionEntry>[0]["userSettings"];
  mediaStore?: MediaStore;
}): RuntimeTestEnv & { gate: RpcApprovalGate } {
  const store = createMemoryStore();
  const pluginRegistry = createPluginRegistry();
  const { entry, loaded } = makeFunctionEntry({
    pluginId: args.pluginId,
    runtimeId: args.runtimeId,
    handler: args.handler,
    execution: args.execution,
    ...(args.source ? { source: args.source } : {}),
    ...(args.userSettings ? { userSettings: args.userSettings } : {}),
  });
  pluginRegistry.register(entry);

  const rpcRegistry = createPluginRpcRegistry();
  const rpcExecutor = createRpcExecutor({ registry: rpcRegistry });
  const gate = createRpcApprovalGate();
  const eventBus = createEventBus(store);
  const sessionLock = createInProcessSessionLock();

  const llm: FakeLlm = {
    async generate() {
      // Function runtimes never touch the LLM, but executeTurn's type
      // expects a non-null adapter.
      return {
        content: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };

  const loadRuntimeFn = async (
    m: RuntimeManifest,
  ): Promise<LoadedRuntime | undefined> =>
    m.name === args.runtimeId ? loaded : undefined;

  const compactorRunner = {
    async run() {
      return { compacted: false };
    },
  };

  const runtimeJobWorker = createTestRuntimeJobWorker({
    store,
    eventBus,
    sessionLock,
    pluginRegistry,
    deps: {
      loadRuntime: loadRuntimeFn,
      llm,
      compactor: compactorRunner,
      ...(args.mediaStore ? { mediaStore: args.mediaStore } : {}),
    },
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("runtimeJobWorker", runtimeJobWorker);
    c.set("store", store);
    c.set("pluginRegistry", pluginRegistry);
    c.set("rpcExecutor", rpcExecutor);
    c.set("rpcRegistry", rpcRegistry);
    c.set("rpcApprovalGate", gate);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", loadRuntimeFn);
    c.set("resolveModel", () => undefined);
    c.set("eventBus", eventBus);
    c.set("compactorRunner", compactorRunner);
    c.set("sessionLock", sessionLock);
    if (args.mediaStore) {
      c.set("mediaStore", args.mediaStore);
    }
    c.set("prepareToolsForSession", async () => undefined);
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  ownClientAddress(app);
  return { app, store, pluginRegistry, gate, sessionLock };
}

async function seedRuntimeSession(
  store: DataStore,
  pluginId: string,
  sessionId = "sess-rt-1",
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    phase: "playing",
    setupRuntimes: {},
    metadata: {
      approvalScopeNonce: globalThis.crypto.randomUUID(),
      sessionIncarnationNonce: globalThis.crypto.randomUUID(),
    },
    id: sessionId,
    worldId: "cloudmere",
    status: "active",
    completedPlayerTurns: 1,

    locale: "zh-CN",
    activePlugins: [pluginId],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Wait until `predicate()` returns true or the attempt budget is exhausted.
 * Background jobs settle on the runtime job worker, which the test cannot
 * await directly, so poll the store with microtask yields. No wall-clock
 * sleeps.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  maxAttempts = 200,
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(
    "waitFor: predicate did not become true within the attempt budget",
  );
}

describe("POST /api/sessions/:id/plugin-rpc — runtime mode (M8b)", () => {
  const PLUGIN_ID = "test-runtime-plug";
  const SYNC_RUNTIME = "test-runtime-plug/sync-fn";
  const BG_RUNTIME = "test-runtime-plug/bg-fn";
  const SESSION_ID = "sess-rt-1";

  interface RuntimeJobRow {
    readonly status: string;
    readonly runtimeId: string;
    readonly reason?: string;
    readonly error?: string;
    readonly finishedAt?: string;
    readonly origin: {
      readonly activation: string;
      readonly sourceTurnId: string;
    };
    readonly payload: {
      readonly turnId?: string;
      readonly triggerEvent?: unknown;
    };
    readonly result?: {
      readonly turnId?: string;
      readonly durationMs?: number;
      readonly deferredJobs?: ReadonlyArray<{
        jobId: string;
        runtimeId: string;
      }>;
      readonly runtimeResults?: ReadonlyArray<{
        runtimeId: string;
        status: string;
        error?: string;
        output?: unknown;
      }>;
    };
  }

  /** Background runtimes run as durable runtime jobs. */
  async function runtimeJobs(
    store: DataStore,
    pluginId = PLUGIN_ID,
  ): Promise<Map<string, RuntimeJobRow>> {
    return new Map(
      (await store.listPluginData(SESSION_ID, pluginId, "_runtime_jobs")).map(
        (row) => [row.key, row.value as RuntimeJobRow],
      ),
    );
  }

  async function waitForJob(
    store: DataStore,
    jobId: string,
    statuses: readonly string[],
  ): Promise<RuntimeJobRow> {
    let job: RuntimeJobRow | undefined;
    await waitFor(async () => {
      job = (await runtimeJobs(store)).get(jobId);
      return job !== undefined && statuses.includes(job.status);
    }, 2_000);
    return job!;
  }

  async function expectPausedWhileQueued(
    execution: "sync" | "background",
    runtimeId: string,
  ): Promise<void> {
    const handler = vi.fn(async () => ({ ok: true }));
    const env = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId,
      execution,
      handler,
    });
    await seedRuntimeSession(env.store, PLUGIN_ID, SESSION_ID);

    let releaseHolder!: () => void;
    let markHolderStarted!: () => void;
    const holderStarted = new Promise<void>((resolve) => {
      markHolderStarted = resolve;
    });
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holder = env.sessionLock.withLock(SESSION_ID, async () => {
      markHolderStarted();
      await holderGate;
    });
    await holderStarted;

    const originalGetSession = env.store.getSession.bind(env.store);
    let markInitialRead!: () => void;
    const initialRead = new Promise<void>((resolve) => {
      markInitialRead = resolve;
    });
    const getSpy = vi
      .spyOn(env.store, "getSession")
      .mockImplementation(async (id) => {
        const current = await originalGetSession(id);
        markInitialRead();
        return current;
      });
    const request = env.app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId,
        payload: {},
      }),
    });
    await initialRead;
    await env.store.updateSession(SESSION_ID, { status: "paused" });
    releaseHolder();
    await holder;

    const res = await request;
    getSpy.mockRestore();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "session_not_active" });
    expect(handler).not.toHaveBeenCalled();
  }

  it("rejects a sync runtime paused while waiting for its lock", async () => {
    await expectPausedWhileQueued("sync", SYNC_RUNTIME);
  });

  it("rejects a background enqueue paused while waiting for its lock", async () => {
    await expectPausedWhileQueued("background", BG_RUNTIME);
  });

  it("runs a sync function runtime and returns 200 with runtimeResults", async () => {
    let handlerInvokedWith: Record<string, unknown> | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      handler: async (ctx) => {
        handlerInvokedWith = ctx as unknown as Record<string, unknown>;
        return { ok: true, tag: "sync-output" };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { clicked: "button" },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      turnId: string;
      runtimeResults: ReadonlyArray<{
        runtimeId: string;
        pluginId: string;
        status: string;
        output: { ok?: boolean; tag?: string };
      }>;
      durationMs: number;
    };
    expect(body.status).toBe("ok");
    expect(body.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof body.durationMs).toBe("number");
    expect(body.runtimeResults).toHaveLength(1);
    expect(body.runtimeResults[0]?.runtimeId).toBe(SYNC_RUNTIME);
    expect(body.runtimeResults[0]?.pluginId).toBe(PLUGIN_ID);
    expect(body.runtimeResults[0]?.status).toBe("success");
    expect(body.runtimeResults[0]?.output).toMatchObject({
      ok: true,
      tag: "sync-output",
    });

    // manualPayload forwarded through TurnInput → ctx.manualPayload
    expect(handlerInvokedWith?.manualPayload).toEqual({ clicked: "button" });

    // The sync path queues no background job.
    const jobs = await store.listPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_runtime_jobs",
    );
    expect(jobs).toHaveLength(0);

    // runManualTurn funnels through processTurnResults → saveAutoSnapshot:
    // every manual turn must leave an auto fork point behind, same as the
    // main /api/actions path.
    const snapshots = await store.listSnapshots(SESSION_ID);
    expect(
      snapshots.filter((s) => s.kind === "auto" && s.turnId === body.turnId),
    ).toHaveLength(1);
  });

  it("simulates branch-reply create/accept through API and uses the accepted candidate in the next narrator prompt", async () => {
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();
    const { entry: branchEntry, loaded: branchLoaded } = makeFunctionEntry({
      pluginId: "branch-reply",
      runtimeId: "branch-reply",
      execution: "sync",
      handler: branchReplyHandler,
      stage: undefined,
    });
    const { entry: narratorEntry, loaded: narratorLoaded } = makeAgentEntry({
      pluginId: "chat-mode-narrator",
      runtimeId: "chat-mode-narrator",
      outputKind: "story",
      trigger: { type: "auto" },
    });
    pluginRegistry.register(branchEntry);
    pluginRegistry.register(narratorEntry);

    const extensions = new PluginExtensionHost(
      new PluginServiceRegistry({
        list: async (id) => (await store.getSession(id))?.activePlugins ?? [],
        ensure: async () => {},
      }),
    );
    branchReplyEntry({
      provideExtension: (
        point: string,
        id: string,
        implementation: Parameters<PluginExtensionHost["register"]>[2],
      ) => extensions.register("branch-reply", { point, id }, implementation),
    });
    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({ registry: rpcRegistry });
    const gate = createRpcApprovalGate();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const llm = new CapturingLlm();
    const loadRuntimeFn = async (
      manifest: RuntimeManifest,
    ): Promise<LoadedRuntime | undefined> => {
      if (manifest.name === "branch-reply") return branchLoaded;
      if (manifest.name === "chat-mode-narrator") return narratorLoaded;
      return undefined;
    };
    const runtimeJobWorker = createTestRuntimeJobWorker({
      store,
      eventBus,
      sessionLock,
      pluginRegistry,
      deps: { loadRuntime: loadRuntimeFn, llm, extensions },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runtimeJobWorker", runtimeJobWorker);
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("pluginExtensions", extensions);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", {
        async run() {
          return { compacted: false };
        },
      });
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", sessionRoutes);
    app.route("/api/sessions", pluginRpcRoutes);
    ownClientAddress(app);
    app.route("/api/actions", actionRoutes);

    const createSession = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sess-branch-api",
        plugins: ["chat-mode-narrator", "branch-reply"],
        locale: "zh-CN",
      }),
    });
    expect(createSession.status).toBe(201);
    const session = (await createSession.json()) as {
      id: string;
      activePlugins: string[];
    };
    expect(session.activePlugins).toEqual(
      expect.arrayContaining(["chat-mode-narrator", "branch-reply"]),
    );

    await store.appendTurnMessage({
      id: "tm-player-1",
      sessionId: session.id,
      turnId: "turn-story-1",
      sourceType: "player",
      role: "user",
      content: "Open the sealed door.",
      order: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await store.appendTurnMessage({
      id: "tm-story-1",
      sessionId: session.id,
      turnId: "turn-story-1",
      sourceType: "runtime",
      sourcePluginId: "chat-mode-narrator",
      sourceRuntimeId: "chat-mode-narrator",
      role: "assistant",
      name: "chat-mode-narrator",
      content: "Original narrator text.",
      order: 500,
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    // The candidate set of the turn, as the seed and a regenerate store it:
    // the narration first, then a rephrasing.
    await store.setPluginData({
      id: "branch-message-1",
      sessionId: session.id,
      pluginId: "branch-reply",
      namespace: "message",
      key: "turn-story-1",
      value: {
        schemaVersion: 1,
        turnId: "turn-story-1",
        __turnId: "turn-story-1",
        status: "ready",
        runtimeId: "chat-mode-narrator",
        candidates: [
          {
            id: "turn-story-1-candidate-1",
            index: 0,
            text: "Original narrator text.",
            source: "original",
          },
          {
            id: "turn-story-1-candidate-2",
            index: 1,
            text: "Accepted branch text.",
            source: "regenerated",
          },
        ],
        selectedCandidateId: "turn-story-1-candidate-1",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
    });

    const acceptCandidate = await app.request(
      `/api/sessions/${session.id}/plugin-rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "runtime",
          pluginId: "branch-reply",
          runtimeId: "branch-reply",
          payload: {
            action: "acceptCandidate",
            turnId: "turn-story-1",
            candidateId: "turn-story-1-candidate-2",
          },
        }),
      },
    );
    expect(acceptCandidate.status).toBe(200);

    const accepted = await store.listPluginData(
      session.id,
      "branch-reply",
      "accepted",
    );
    expect(accepted[0]?.value).toMatchObject({
      turnId: "turn-story-1",
      text: "Accepted branch text.",
    });

    // Advance to the playing band so send_message schedules the main-loop
    // narrator (stage narrative).
    await store.updateSession(session.id, {
      phase: "playing",
      completedPlayerTurns: 0,
      updatedAt: new Date().toISOString(),
    });

    const nextTurn = await app.request(`/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-branch-next",
        type: "send_message",
        sessionId: session.id,
        payload: { content: "Continue from there." },
      }),
    });
    expect(nextTurn.status).toBe(200);
    // /api/actions runs executeTurn inside the SSE stream generator, so the turn
    // only executes as the body is consumed — drain to completion first.
    const reader = nextTurn.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }

    const lastCall = llm.calls[llm.calls.length - 1] ?? [];
    const assistantHistory = lastCall.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantHistory.map((message) => message.content)).toContain(
      "Accepted branch text.",
    );
    expect(assistantHistory.map((message) => message.content)).not.toContain(
      "Original narrator text.",
    );

    const persistedHistory = await store.listTurnMessages(session.id);
    expect(
      persistedHistory.find((message) => message.id === "tm-story-1")?.content,
    ).toBe("Original narrator text.");
  });

  it("injects ctx.media into sync runtime-mode handlers", async () => {
    const mediaStore = createMemoryMediaStore();
    let mediaId: string | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      mediaStore,
      handler: async (ctx) => {
        const ref = await ctx.media!.put(
          new Uint8Array([1, 2, 3]),
          "image/png",
        );
        mediaId = ref.id;
        return { ok: true, mediaId: ref.id };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
      }),
    });

    expect(res.status).toBe(200);
    expect(mediaId).toBeDefined();
    const lookup = await mediaStore.lookup(mediaId!);
    expect(lookup).toMatchObject({
      ownerSessionId: SESSION_ID,
      ownerPluginId: PLUGIN_ID,
    });
  });

  it("fails the queued job when an expected background follower is missing", async () => {
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      handler: async () => ({
        ok: true,
        prompt: "a foggy harbor",
      }),
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        expectsBackgroundFollower: true,
      }),
    });

    // expectsBackgroundFollower queues the prompt-builder as a durable job and
    // returns 202 at once. When the run emits no follower, the job settles as
    // failed with reason 'follower-not-emitted'.
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      jobId: string;
      pending: boolean;
      runtimeId: string;
      phase: string;
    };
    expect(body.status).toBe("accepted");
    expect(body.pending).toBe(true);
    expect(body.runtimeId).toBe(SYNC_RUNTIME);
    expect(body.phase).toBe("prompt");
    expect(typeof body.jobId).toBe("string");

    const job = await waitForJob(store, body.jobId, ["failed"]);
    expect([...(await runtimeJobs(store)).keys()]).toEqual([body.jobId]);
    expect(job).toMatchObject({
      status: "failed",
      runtimeId: SYNC_RUNTIME,
      reason: "follower-not-emitted",
      origin: { activation: "manual" },
    });
    expect(job.error).toContain("completed without emitting");
    // Panels see the job as a prompt phase without its frozen payload.
    const visible = publicPluginDataValue({
      namespace: "_runtime_jobs",
      value: job,
    });
    expect(visible).toMatchObject({ phase: "prompt" });
    expect(visible).not.toHaveProperty("payload");
  });

  // ── X-Plugin-User-Settings header → ctx.userSettings ──
  //
  // Player-authored plugin settings travel from the web client's
  // SettingsStore via the `X-Plugin-User-Settings` base64-JSON header.
  // The route decodes it, the executor merges manifest defaults, and the
  // handler receives the final bucket as `ctx.userSettings`.
  it("threads X-Plugin-User-Settings header through TurnInput into ctx.userSettings with defaults merged", async () => {
    let handlerCtx: Record<string, unknown> | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      userSettings: [
        {
          key: "model",
          type: "select",
          default: "wan2.7-image-pro",
          label: "Model",
        },
        { key: "size", type: "select", default: "1024*1024", label: "Size" },
        { key: "quality", type: "number", default: 80, label: "Quality" },
      ],
      handler: async (ctx) => {
        handlerCtx = ctx as unknown as Record<string, unknown>;
        return { ok: true };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    // Player has overridden `model` and `quality`; `size` must fall back.
    const settingsHeader = Buffer.from(
      JSON.stringify({
        [PLUGIN_ID]: { model: "wan2.5-image-turbo", quality: 95 },
      }),
      "utf-8",
    ).toString("base64");

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Plugin-User-Settings": settingsHeader,
      },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerCtx?.userSettings).toEqual({
      model: "wan2.5-image-turbo",
      size: "1024*1024",
      quality: 95,
    });
  });

  it("refreshes world settings between manual runtime operations", async () => {
    const seen: unknown[] = [];
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      userSettings: [
        { key: "tone", type: "text", default: "default", label: "Tone" },
      ],
      handler: async (ctx) => {
        seen.push(ctx.userSettings);
        return { ok: true };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);
    const worldId = `rpc-settings-${crypto.randomUUID()}`;
    await setSessionWorld(store, SESSION_ID, worldId);
    for (const tone of ["before", "after"]) {
      await store.upsertWorld({
        id: worldId,
        name: "Settings world",
        description: "",
        createdAt: new Date().toISOString(),
        metadata: { pluginSettings: { [PLUGIN_ID]: { tone } } },
      });
      const response = await app.request(
        `/api/sessions/${SESSION_ID}/plugin-rpc`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "runtime",
            pluginId: PLUGIN_ID,
            runtimeId: SYNC_RUNTIME,
            payload: {},
          }),
        },
      );
      expect(response.status).toBe(200);
    }
    expect(seen).toEqual([{ tone: "before" }, { tone: "after" }]);
  });

  it("falls back to manifest defaults when no X-Plugin-User-Settings header is sent", async () => {
    let handlerCtx: Record<string, unknown> | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      userSettings: [
        {
          key: "model",
          type: "select",
          default: "wan2.7-image-pro",
          label: "Model",
        },
      ],
      handler: async (ctx) => {
        handlerCtx = ctx as unknown as Record<string, unknown>;
        return { ok: true };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerCtx?.userSettings).toEqual({ model: "wan2.7-image-pro" });
  });

  it("ignores malformed X-Plugin-User-Settings header gracefully (falls back to defaults)", async () => {
    let handlerCtx: Record<string, unknown> | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      userSettings: [
        {
          key: "model",
          type: "select",
          default: "wan2.7-image-pro",
          label: "Model",
        },
      ],
      handler: async (ctx) => {
        handlerCtx = ctx as unknown as Record<string, unknown>;
        return { ok: true };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Not valid base64-JSON — server must not 500.
        "X-Plugin-User-Settings": "not@@base64",
      },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerCtx?.userSettings).toEqual({ model: "wan2.7-image-pro" });
  });

  it("commits pluginData[] returned by a function handler into plugin_data rows", async () => {
    // Regression — `output.pluginData: [{namespace,key,value}]` must
    // land in the store through the normal commit pipeline. Before the
    // normaliser change this field was a plain runtime output field with
    // no side effects — the image gallery and _jobs writeback relied on
    // it but silently got nothing.
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      handler: async () => ({
        ok: true,
        pluginData: [
          {
            namespace: "images",
            key: "job-alpha",
            value: { url: "https://cdn.test/alpha.png", mimeType: "image/png" },
          },
          {
            namespace: "images",
            key: "job-beta",
            value: { url: "https://cdn.test/beta.png", mimeType: "image/png" },
          },
        ],
      }),
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });
    expect(res.status).toBe(200);

    const images = await store.listPluginData(SESSION_ID, PLUGIN_ID, "images");
    expect(images).toHaveLength(2);
    const byKey = new Map(
      images.map((r) => [r.key, r.value as { url?: string }]),
    );
    expect(byKey.get("job-alpha")?.url).toBe("https://cdn.test/alpha.png");
    expect(byKey.get("job-beta")?.url).toBe("https://cdn.test/beta.png");
  });

  // `execution: background` has already returned 202 and detached from the
  // request, and the runtimes using it are media generations — mimo-tts's
  // manual narration runs for as long as the speech takes. Holding the session
  // lock across that queues every player action behind it, and under
  // PostgreSQL (30s acquire budget) makes them fail rather than wait.
  it("leaves the session lock free while a background runtime executes", async () => {
    let playerCouldAct = false;

    const env = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: BG_RUNTIME,
      execution: "background",
      handler: async () => {
        // Stands in for the player acting mid-generation. The timeout keeps a
        // regression from hanging the suite: if execution moves back under the
        // session lock this resolves `false` instead of deadlocking.
        await Promise.race([
          env.sessionLock.withLock(SESSION_ID, async () => {
            playerCouldAct = true;
          }),
          new Promise((resolve) => setTimeout(resolve, 250)),
        ]);
        return { ok: true };
      },
    });
    await seedRuntimeSession(env.store, PLUGIN_ID, SESSION_ID);

    const res = await env.app.request(
      `/api/sessions/${SESSION_ID}/plugin-rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "runtime",
          pluginId: PLUGIN_ID,
          runtimeId: BG_RUNTIME,
        }),
      },
    );
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    await waitForJob(env.store, jobId, ["succeeded"]);

    expect(playerCouldAct).toBe(true);
  });

  it("returns 202 + jobId for a background runtime and settles its queued job", async () => {
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });

    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: BG_RUNTIME,
      execution: "background",
      handler: async () => {
        // Block until the test has observed the pending row.
        await gate;
        return { ok: true, stage: "done" };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: BG_RUNTIME,
        payload: { prompt: "a sunset" },
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      status: string;
      jobId: string;
      pending: boolean;
      turnId: string;
      runtimeId: string;
    };
    expect(body.status).toBe("accepted");
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.pending).toBe(true);
    expect(body.runtimeId).toBe(BG_RUNTIME);

    // The queued row exists as soon as the 202 response is returned, and
    // carries the turn id the response announced.
    const pending = (await runtimeJobs(store)).get(body.jobId);
    expect(pending).toMatchObject({
      runtimeId: BG_RUNTIME,
      origin: { activation: "manual" },
      payload: { turnId: body.turnId },
    });
    expect(["queued", "claimed", "running"]).toContain(pending!.status);

    released!();
    const done = await waitForJob(store, body.jobId, ["succeeded"]);
    expect(done.runtimeId).toBe(BG_RUNTIME);
    expect(typeof done.finishedAt).toBe("string");
    expect(done.result?.turnId).toBe(body.turnId);
    expect(typeof done.result?.durationMs).toBe("number");
    expect(done.result?.runtimeResults).toHaveLength(1);
    expect(done.result?.runtimeResults?.[0]).toMatchObject({
      runtimeId: BG_RUNTIME,
      status: "success",
      output: { ok: true, stage: "done" },
    });
  });

  it("injects ctx.media into background runtime handlers", async () => {
    const mediaStore = createMemoryMediaStore();
    let mediaId: string | undefined;
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: BG_RUNTIME,
      execution: "background",
      mediaStore,
      handler: async (ctx) => {
        const ref = await ctx.media!.put(
          new Uint8Array([4, 5, 6]),
          "image/png",
        );
        mediaId = ref.id;
        return { ok: true, mediaId: ref.id };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: BG_RUNTIME,
      }),
    });

    expect(res.status).toBe(202);
    await waitFor(async () => mediaId !== undefined);

    const lookup = await mediaStore.lookup(mediaId!);
    expect(lookup).toMatchObject({
      ownerSessionId: SESSION_ID,
      ownerPluginId: PLUGIN_ID,
    });
  });

  it("fails the job when a background runtime handler throws", async () => {
    // executeTurn catches the handler exception and marks the runtime failed
    // inside its results; the job must not report success for it.
    const { app, store } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: BG_RUNTIME,
      execution: "background",
      handler: async () => {
        throw new Error("handler-exploded");
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: BG_RUNTIME,
        payload: {},
      }),
    });

    // The request itself still succeeds with 202 — failure surfaces
    // asynchronously on the job, NOT via HTTP status.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };

    const job = await waitForJob(store, body.jobId, ["failed"]);
    expect(job.reason).toBe("runtime-reported-failure");
    expect(job.error).toContain("handler-exploded");
    // Results stay on the job for debugging even on failure.
    expect(job.result?.runtimeResults?.[0]?.status).toBe("failed");
    expect(job.result?.runtimeResults?.[0]?.error).toContain(
      "handler-exploded",
    );
  });

  // ── Regression: trust comes from discovery source, not pluginType.
  //
  // A third-party plugin that forges `pluginType: 'core-plugin'` in its
  // frontmatter must NOT auto-bypass the approval gate. The server-side
  // contract is: `entry.source` is set by the bootstrap discovery pipeline
  // (first-dir = bundled, all others = community) and drives the trust-gate
  // verdict. `pluginType` is now display-only.
  it("community-source runtimes produce approval-required on first call, retry succeeds after approval", async () => {
    let handlerCalls = 0;
    const { app, store, gate } = setupRuntimeTestEnv({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      execution: "sync",
      source: "community",
      handler: async () => {
        handlerCalls += 1;
        return { ok: true };
      },
    });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    // Two-phase flow. Phase 1: with no server-code grant yet, the first
    // call asks for the exact COMMUNITY_SERVER_CODE_ACTION grant. Handler
    // must NOT run.
    const first = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { n: 1 },
      }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      status: string;
      approvalId?: string;
      pending?: { action?: string };
    };
    expect(firstBody.status).toBe("approval-required");
    expect(typeof firstBody.approvalId).toBe("string");
    expect(firstBody.pending?.action).toBe("covel:plugin-server-code");
    expect(handlerCalls).toBe(0);

    const serverCodeDecision = await decideSessionApproval(
      gate,
      store,
      SESSION_ID,
      PLUGIN_ID,
      firstBody.approvalId!,
    );
    expect(serverCodeDecision.ok).toBe(true);

    // Phase 2: the retry now asks for the exact `runtime:<name>` grant.
    const second = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { n: 2 },
      }),
    });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as {
      status: string;
      approvalId?: string;
      pending?: { action?: string };
    };
    expect(secondBody.status).toBe("approval-required");
    expect(secondBody.pending?.action).toBe(`runtime:${SYNC_RUNTIME}`);
    expect(handlerCalls).toBe(0);

    const runtimeDecision = await decideSessionApproval(
      gate,
      store,
      SESSION_ID,
      PLUGIN_ID,
      secondBody.approvalId!,
    );
    expect(runtimeDecision.ok).toBe(true);

    // Both exact grants present — the runtime executes for the rest of the
    // session.
    const third = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { n: 3 },
      }),
    });
    expect(third.status).toBe(200);
    const thirdBody = (await third.json()) as {
      status: string;
      runtimeResults: ReadonlyArray<{ status: string }>;
    };
    expect(thirdBody.status).toBe("ok");
    expect(thirdBody.runtimeResults[0]?.status).toBe("success");
    expect(handlerCalls).toBe(1);
  });

  it("ignores forged pluginType:core-plugin in manifest when entry.source is community", async () => {
    // Explicit regression: even if a community plugin claims `pluginType: core-plugin`
    // in its frontmatter, the runtime RPC trust gate keeps it at community level.
    // The makeFunctionEntry helper currently writes `pluginType: 'plugin'`, so to
    // exercise the exact forgery scenario we override the manifest post-register.
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();
    const { entry, loaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: SYNC_RUNTIME,
      handler: async () => ({ ok: true }),
      source: "community",
    });
    // Simulate a third-party plugin setting `pluginType: 'core-plugin'` in its manifest.
    (loaded.manifest as { pluginType: string }).pluginType = "core-plugin";
    pluginRegistry.register(entry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({ registry: rpcRegistry });
    const gate = createRpcApprovalGate();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const llm: FakeLlm = {
      async generate() {
        return {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const loadRuntimeFn = async (m: RuntimeManifest) =>
      m.name === SYNC_RUNTIME ? loaded : undefined;
    const compactorRunner = {
      async run() {
        return { compacted: false };
      },
    };

    const runtimeJobWorker = createTestRuntimeJobWorker({
      store,
      eventBus,
      sessionLock,
      pluginRegistry,
      deps: { loadRuntime: loadRuntimeFn, llm, compactor: compactorRunner },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runtimeJobWorker", runtimeJobWorker);
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    ownClientAddress(app);

    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });

    // Forged manifest MUST NOT short-circuit the approval gate.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("approval-required");
  });

  // ── Event-chain fan-out respects manifest.execution. ────
  //
  // A P600 sync target emitting an event that matches a P610 follower
  // with `execution: 'background'` must NOT block the sync response on
  // the follower. The route queues one durable event job per follower in
  // the target's commit and returns `deferredJobs` so the frontend can
  // subscribe.
  it("sync target + background follower: fast sync response + one job per follower", async () => {
    const TARGET = "test-f1/target";
    const FOLLOWER = "test-f1/follower";
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();

    const { loaded: targetLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: TARGET,
      stage: "post-turn",
      execution: "sync",
      handler: async () => ({
        ok: true,
        events: [{ topic: "image.prompt.ready", data: { prompt: "a sunset" } }],
      }),
    });

    let followerStarted = false;
    let followerFinished = false;
    const followerGate = new Promise<void>((resolve) => {
      setImmediate(resolve); // resolved immediately; test just wants ordering guarantees
    });
    const { loaded: followerLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: FOLLOWER,
      stage: "post-turn",
      execution: "background",
      handler: async (ctx) => {
        followerStarted = true;
        await followerGate;
        followerFinished = true;
        const event = ctx.triggerEvent as
          { topic: string; data: { prompt?: string } } | undefined;
        return {
          fromFollower: true,
          prompt: event?.data?.prompt,
          pluginData: [
            {
              namespace: "images",
              key: ctx.turnId,
              value: {
                url: `https://cdn.test/${event?.data?.prompt ?? "x"}.png`,
              },
            },
          ],
        };
      },
    });
    // Attach follower trigger.type = event with topic matching the seed.
    (followerLoaded.manifest as { trigger: unknown }).trigger = {
      type: "event",
      topic: "image.prompt.ready",
    };

    // Multi-runtime plugin: one registry entry with BOTH manifests. The
    // pluginRegistry indexes by pluginId, so registering two entries with
    // the same id would overwrite. `getActiveRuntimes` walks `manifests[]`.
    const parsedTarget = {
      runtime: {
        type: targetLoaded.manifest.runtimeType ?? ("agent" as const),
      },
      manifest: targetLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const parsedFollower = {
      runtime: {
        type: followerLoaded.manifest.runtimeType ?? ("agent" as const),
      },
      manifest: followerLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: makeSummary(PLUGIN_ID),

      manifests: [parsedTarget, parsedFollower],
      loadedRuntimes: new Map([
        [TARGET, targetLoaded],
        [FOLLOWER, followerLoaded],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({ registry: rpcRegistry });
    const gate = createRpcApprovalGate();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const llm: FakeLlm = {
      async generate() {
        return {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const loadRuntimeFn = async (m: RuntimeManifest) =>
      m.name === TARGET
        ? targetLoaded
        : m.name === FOLLOWER
          ? followerLoaded
          : undefined;
    const compactorRunner = {
      async run() {
        return { compacted: false };
      },
    };

    const runtimeJobWorker = createTestRuntimeJobWorker({
      store,
      eventBus,
      sessionLock,
      pluginRegistry,
      deps: { loadRuntime: loadRuntimeFn, llm, compactor: compactorRunner },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runtimeJobWorker", runtimeJobWorker);
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    ownClientAddress(app);

    const now = new Date().toISOString();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      worldId: "cloudmere",
      status: "active",
      completedPlayerTurns: 1,

      locale: "zh-CN",
      activePlugins: [PLUGIN_ID],
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: TARGET,
        payload: {},
      }),
    });

    // Sync response must return 200 with only the target's result — follower
    // is NOT in runtimeResults. `deferredJobs` lists the follower's job id.
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      turnId: string;
      runtimeResults: ReadonlyArray<{ runtimeId: string; status: string }>;
      deferredJobs?: ReadonlyArray<{ jobId: string; runtimeId: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.runtimeResults).toHaveLength(1);
    expect(body.runtimeResults[0]?.runtimeId).toBe(TARGET);
    expect(body.deferredJobs).toHaveLength(1);
    expect(body.deferredJobs![0]?.runtimeId).toBe(FOLLOWER);

    // Follower must have NOT finished yet: the response does not wait for
    // the worker to run its job.
    expect(followerFinished).toBe(false);

    const followerJob = await waitForJob(store, body.deferredJobs![0]!.jobId, [
      "succeeded",
    ]);
    expect(followerJob.origin).toMatchObject({
      activation: "event",
      sourceTurnId: body.turnId,
    });

    expect(followerStarted).toBe(true);
    expect(followerFinished).toBe(true);

    // Follower should have committed its pluginData through the standard
    // pipeline so the frontend gallery sees the image.
    const images = await store.listPluginData(SESSION_ID, PLUGIN_ID, "images");
    expect(images).toHaveLength(1);
    expect((images[0]!.value as { url: string }).url).toBe(
      "https://cdn.test/a sunset.png",
    );
  });

  it("background target preserves its background follower chain", async () => {
    const { app, store, targetRuntimeId, followerRuntimeId } =
      setupTargetAndFollower({
        targetExecution: "background",
        followerHandler: async (ctx) => ({
          ok: true,
          pluginData: [
            {
              namespace: "images",
              key: ctx.turnId,
              value: { url: "https://cdn.test/background-chain.png" },
            },
          ],
        }),
      });
    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: targetRuntimeId,
      }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };

    const parent = await waitForJob(store, body.jobId, ["succeeded"]);
    const followerJobId = parent.result?.deferredJobs?.[0]?.jobId;
    expect(followerJobId).toBeDefined();
    const follower = await waitForJob(store, followerJobId!, ["succeeded"]);
    expect(follower.runtimeId).toBe(followerRuntimeId);
    expect(
      await store.listPluginData(SESSION_ID, PLUGIN_ID, "images"),
    ).toHaveLength(1);
  });

  // ── Audit P1: background follower aligned with executeTurn lifecycle. ──
  //
  // Before P1, the background follower path manually invoked the handler
  // with a stubbed `recursiveCall` that always threw, no `assetProgress`
  // emitter, and no per-turn TurnEmitter for `processRuntimeResult`. The
  // following three tests verify the post-P1 contract: a deferred follower
  // sees the same `recursiveCall` / `assetProgress` / `asset.generated`
  // surfaces a manual-trigger turn does.

  // Helper: register a sync target + background follower with the given
  // follower handler. Mirrors the earlier setup but parameterises the handler
  // and skips the followerGate/start/finish bookkeeping the earlier case tracks
  // (we care about emitter/store side effects here, not scheduling order).
  function setupTargetAndFollower(args: {
    targetHandler?: FlatHandler;
    targetExecution?: "sync" | "background";
    followerHandler: FlatHandler;
    followerSource?: PluginSource;
  }): {
    app: Pick<Hono, "request">;
    store: DataStore;
    targetRuntimeId: string;
    followerRuntimeId: string;
  } {
    const TARGET = "test-p1/target";
    const FOLLOWER = "test-p1/follower";
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();

    const targetHandler =
      args.targetHandler ??
      (async () => ({
        ok: true,
        events: [{ topic: "image.prompt.ready", data: { prompt: "a sunset" } }],
      }));

    const { loaded: targetLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: TARGET,
      stage: "post-turn",
      execution: args.targetExecution ?? "sync",
      handler: targetHandler,
    });

    const { loaded: followerLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: FOLLOWER,
      stage: "post-turn",
      execution: "background",
      handler: args.followerHandler,
      ...(args.followerSource ? { source: args.followerSource } : {}),
    });
    (followerLoaded.manifest as { trigger: unknown }).trigger = {
      type: "event",
      topic: "image.prompt.ready",
    };

    const parsedTarget = {
      runtime: {
        type: targetLoaded.manifest.runtimeType ?? ("agent" as const),
      },
      manifest: targetLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const parsedFollower = {
      runtime: {
        type: followerLoaded.manifest.runtimeType ?? ("agent" as const),
      },
      manifest: followerLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: makeSummary(PLUGIN_ID),

      manifests: [parsedTarget, parsedFollower],
      loadedRuntimes: new Map([
        [TARGET, targetLoaded],
        [FOLLOWER, followerLoaded],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({ registry: rpcRegistry });
    const gate = createRpcApprovalGate();
    const eventBus = createEventBus(store);
    const sessionLock = createInProcessSessionLock();
    const llm: FakeLlm = {
      async generate() {
        return {
          content: "",
          toolCalls: [],
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const loadRuntimeFn = async (m: RuntimeManifest) =>
      m.name === TARGET
        ? targetLoaded
        : m.name === FOLLOWER
          ? followerLoaded
          : undefined;
    const compactorRunner = {
      async run() {
        return { compacted: false };
      },
    };

    const runtimeJobWorker = createTestRuntimeJobWorker({
      store,
      eventBus,
      sessionLock,
      pluginRegistry,
      deps: { loadRuntime: loadRuntimeFn, llm, compactor: compactorRunner },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("runtimeJobWorker", runtimeJobWorker);
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    ownClientAddress(app);

    return { app, store, targetRuntimeId: TARGET, followerRuntimeId: FOLLOWER };
  }

  async function dispatchTargetAndAwaitJobs(
    app: Pick<Hono, "request">,
    store: DataStore,
    targetRuntimeId: string,
  ): Promise<{ jobId: string }> {
    const now = new Date().toISOString();
    await store.createSession({
      phase: "playing",
      setupRuntimes: {},
      metadata: {
        approvalScopeNonce: globalThis.crypto.randomUUID(),
        sessionIncarnationNonce: globalThis.crypto.randomUUID(),
      },
      id: SESSION_ID,
      worldId: "cloudmere",
      status: "active",
      completedPlayerTurns: 1,

      locale: "zh-CN",
      activePlugins: [PLUGIN_ID],
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "runtime",
        pluginId: PLUGIN_ID,
        runtimeId: targetRuntimeId,
        payload: {},
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deferredJobs?: ReadonlyArray<{ jobId: string; runtimeId: string }>;
    };
    expect(body.deferredJobs).toHaveLength(1);
    const jobId = body.deferredJobs![0]!.jobId;

    await waitForJob(store, jobId, ["succeeded", "failed"]);

    return { jobId };
  }

  it("background follower can call ctx.recursiveCall without throwing the unavailable stub", async () => {
    let recursiveCallObserved: "invoked" | "threw" | "unavailable" | "absent" =
      "absent";
    let observedDepth: number | undefined;

    const { app, store, targetRuntimeId } = setupTargetAndFollower({
      followerHandler: async (ctx) => {
        if (typeof ctx.recursiveCall !== "function") {
          recursiveCallObserved = "absent";
          return { ok: true };
        }
        try {
          // We don't actually need to recurse — calling with a delta that
          // points at a non-existent runtime resolves to a TurnResult with
          // an `abortReason`; that still proves the function is wired.
          const nested = await ctx.recursiveCall(
            { manualTrigger: { runtimeId: "nonexistent/leaf" } },
            { reason: "p1-recursive-smoke-test" },
          );
          recursiveCallObserved = "invoked";
          observedDepth = ctx.recursionDepth;
          return {
            ok: true,
            nestedAbort: nested.abortReason ?? null,
          };
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("recursiveCall is unavailable")
          ) {
            recursiveCallObserved = "unavailable";
          } else {
            recursiveCallObserved = "threw";
          }
          throw err;
        }
      },
    });

    const { jobId } = await dispatchTargetAndAwaitJobs(
      app,
      store,
      targetRuntimeId,
    );

    // recursiveCall must be a real function and must NOT throw the
    // pre-P1 "unavailable" sentinel.
    expect(recursiveCallObserved).toBe("invoked");
    expect(observedDepth).toBe(0);

    expect((await runtimeJobs(store)).get(jobId)?.status).toBe("succeeded");
  });

  it("background follower emits asset.progress through the per-turn TurnEmitter", async () => {
    const { app, store, targetRuntimeId } = setupTargetAndFollower({
      followerHandler: async (ctx) => {
        await ctx.assetProgress?.({
          assetId: "job-bg-1",
          phase: "generating",
          percent: 25,
          modality: "image",
          message: "queued by deferred follower",
        });
        await ctx.assetProgress?.({
          assetId: "job-bg-1",
          phase: "generating",
          percent: 75,
          modality: "image",
        });
        return { ok: true, assetId: "job-bg-1" };
      },
    });

    await dispatchTargetAndAwaitJobs(app, store, targetRuntimeId);

    const traceEvents = await store.listTraceEvents(SESSION_ID);
    const progressEvents = traceEvents.filter(
      (e) => e.type === "asset.progress",
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    const payloads = progressEvents.map(
      (e) =>
        e.payload as { assetId?: string; percent?: number; runtimeId?: string },
    );
    const ours = payloads.filter((p) => p.assetId === "job-bg-1");
    expect(ours).toHaveLength(2);
    expect(ours.every((p) => p.runtimeId === "test-p1/follower")).toBe(true);
    expect(ours.map((p) => p.percent).sort()).toEqual([25, 75]);
  });

  it("background follower asset.generate proposal flows asset.generated through emitter and processRuntimeResult", async () => {
    // 64-char hex MediaRef id (sha256 shape) so the asset.generate proposal
    // passes mediaRefSchema validation and reaches the commit fan-out.
    const ASSET_REF_ID = "a".repeat(64);

    const { app, store, targetRuntimeId } = setupTargetAndFollower({
      followerHandler: async (ctx) => {
        const event = ctx.triggerEvent as
          { topic: string; data: { prompt?: string } } | undefined;
        return {
          ok: true,
          assetGenerations: [
            {
              ref: {
                id: ASSET_REF_ID,
                mime: "image/png",
                size: 1234,
                url: "https://cdn.test/bg-image.png",
              },
              modality: "image",
              meta: { prompt: event?.data?.prompt ?? "unknown" },
            },
          ],
        };
      },
    });

    await dispatchTargetAndAwaitJobs(app, store, targetRuntimeId);

    // asset.generated trace event must have been emitted by the
    // CommitPipeline (session-kernel) when the follower's asset.generate
    // proposal was committed. Pre-P1 plugin-rpc passed no emitter into
    // processRuntimeResult so this fan-out silently no-op'd.
    const traceEvents = await store.listTraceEvents(SESSION_ID);
    const generated = traceEvents.filter((e) => e.type === "asset.generated");
    expect(generated.length).toBeGreaterThanOrEqual(1);
    const payload = generated[0]!.payload as {
      runtimeId?: string;
      pluginId?: string;
      asset?: { ref?: { id?: string }; modality?: string };
    };
    expect(payload.runtimeId).toBe("test-p1/follower");
    expect(payload.pluginId).toBe(PLUGIN_ID);
    expect(payload.asset?.modality).toBe("image");
    expect(payload.asset?.ref?.id).toBe(ASSET_REF_ID);
  });
});
