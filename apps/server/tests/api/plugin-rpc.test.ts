/**
 * PR-3: POST /api/sessions/:id/plugin-rpc integration tests.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type DataStore,
  type MediaStore,
} from "@covel/store";
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  submitFormHandler,
  type PluginRpcRegistry,
  type RpcExecutor,
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
import type { RuntimeManifest } from "@covel/shared";
import { createEventBus } from "@covel/events";
import { pluginRpcRoutes } from "../../src/routes/api/plugin-rpc.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import branchReplyHandler from "../../../../plugins/branch-reply/handler.js";

type Env = {
  Variables: {
    store: DataStore;
    rpcExecutor: RpcExecutor;
    rpcRegistry: PluginRpcRegistry;
    rpcApprovalGate: RpcApprovalGate;
  };
};

function setup(): {
  app: Hono;
  store: DataStore;
  registry: PluginRpcRegistry;
  executor: RpcExecutor;
  gate: RpcApprovalGate;
  pluginRegistry: PluginRegistry;
} {
  const store = createMemoryStore();
  const registry = createPluginRpcRegistry();
  registry.registerFrameworkDefault("submit-form", submitFormHandler);
  registry.registerFrameworkDefault("echo", async (payload) => ({
    echoed: payload,
  }));
  const executor = createRpcExecutor({
    registry,
    loadHandler: async () => async (payload) => ({ pluginEcho: payload }),
  });
  const gate = createRpcApprovalGate();
  const pluginRegistry = createPluginRegistry();
  const app = new Hono<Env>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("rpcExecutor", executor);
    c.set("rpcRegistry", registry);
    c.set("rpcApprovalGate", gate);
    // Minimal pluginRegistry so the runtimeId branch can resolve "runtime
    // not found" without 500ing on missing DI. Full executeTurn wiring is
    // covered by the bootstrap integration tests.
    c.set("pluginRegistry", pluginRegistry);
    await next();
  });
  app.route("/api/sessions", pluginRpcRoutes);
  return { app, store, registry, executor, gate, pluginRegistry };
}

async function seedSession(
  store: DataStore,
  id = "sess-rpc-1",
  locale = "zh-CN",
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id,
    worldId: "cloudmere",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale,
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

async function seedInteractionTemplate(
  store: DataStore,
  sessionId: string,
  interactionId: string,
  content: string,
): Promise<void> {
  await store.appendTurnMessage({
    id: `tpl-${interactionId}`,
    sessionId,
    turnId: "turn-1",
    sourceType: "runtime",
    role: "assistant",
    name: "tpl",
    content,
    order: 700,
    pendingInput: { formId: interactionId },
    createdAt: new Date().toISOString(),
  });
}

function submitFormRequest(
  app: Hono,
  sessionId: string,
  submissions: ReadonlyArray<Record<string, unknown>>,
) {
  return app.request(`/api/sessions/${sessionId}/plugin-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pluginId: "framework",
      action: "submit-form",
      payload: { turnId: "turn-1", submissions },
    }),
  });
}

describe("POST /api/sessions/:id/plugin-rpc (PR-3)", () => {
  let app: Hono;
  let store: DataStore;
  let registry: PluginRpcRegistry;
  let gate: RpcApprovalGate;

  beforeEach(async () => {
    ({ app, store, registry, gate } = setup());
    await seedSession(store);
  });

  it("returns 404 for unknown session", async () => {
    const res = await app.request("/api/sessions/missing/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "framework",
        action: "echo",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when neither action nor runtimeId is set", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: "framework" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when both action and runtimeId are set", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "framework",
        action: "echo",
        runtimeId: "narrator",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when runtime is not active in session", async () => {
    // With an empty pluginRegistry in setup(), no runtime is active; the
    // handler should surface this as 404 "runtime-not-active" rather than
    // attempting to execute a nonexistent runtime.
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "codex",
        runtimeId: "codex",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("runtime-not-active");
  });

  it("dispatches a framework default action and returns the result", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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

  it("dispatches a plugin-declared action via lazy loader", async () => {
    registry.registerPluginAction(
      "codex",
      "regenerate",
      { handler: "./rpc/regenerate.js" },
      "official",
    );

    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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

  it('returns 404 with code "unknown-action" when action not registered', async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "nonexistent",
        action: "whatever",
        payload: null,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown-action");
  });

  it("forwards submit-form payload to the framework default handler", async () => {
    // Seed a template message so the handler can fill it.
    await store.appendTurnMessage({
      id: "msg-template",
      sessionId: "sess-rpc-1",
      turnId: "turn-1",
      sourceType: "runtime",
      sourcePluginId: "char-creator",
      role: "assistant",
      name: "form-template",
      content: "Player name is {{name}}",
      order: 700,
      pendingInput: { formId: "form-char-creation" },
      createdAt: new Date().toISOString(),
    });

    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "framework",
        action: "submit-form",
        payload: {
          turnId: "turn-1",
          submissions: [
            {
              interactionId: "form-char-creation",
              type: "form",
              values: { name: "Aria" },
            },
          ],
        },
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      result: {
        accepted: boolean;
        results: ReadonlyArray<{ filledNarrative: string }>;
      };
    };
    expect(body.status).toBe("ok");
    expect(body.result.accepted).toBe(true);
    expect(body.result.results[0].filledNarrative).toBe("Player name is Aria");
  });

  it("forwards a choice submission and fills the template with selectedLabel", async () => {
    await seedInteractionTemplate(
      store,
      "sess-rpc-1",
      "ch-1",
      "You chose {{selectedLabel}}",
    );
    const res = await submitFormRequest(app, "sess-rpc-1", [
      {
        interactionId: "ch-1",
        type: "choice",
        values: { selectedId: "a", selectedLabel: "Attack" },
      },
    ]);
    const body = (await res.json()) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    expect(body.result.results[0].filledNarrative).toBe("You chose Attack");
  });

  it("threads session.locale into the handler: confirmation localizes to en-US", async () => {
    await seedSession(store, "sess-rpc-en", "en-US");
    await seedInteractionTemplate(
      store,
      "sess-rpc-en",
      "cf-1",
      "Result: {{confirmed}}",
    );
    const res = await submitFormRequest(app, "sess-rpc-en", [
      {
        interactionId: "cf-1",
        type: "confirmation",
        values: { confirmed: true },
      },
    ]);
    const body = (await res.json()) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    // Proves plugin-rpc.ts threads session.locale='en-US' into the dispatch ctx.
    expect(body.result.results[0].filledNarrative).toBe("Result: Confirm");
  });

  it("confirmation stays 确认 under the default zh-CN session locale", async () => {
    await seedInteractionTemplate(
      store,
      "sess-rpc-1",
      "cf-2",
      "Result: {{confirmed}}",
    );
    const res = await submitFormRequest(app, "sess-rpc-1", [
      {
        interactionId: "cf-2",
        type: "confirmation",
        values: { confirmed: true },
      },
    ]);
    const body = (await res.json()) as {
      result: { results: Array<{ filledNarrative: string }> };
    };
    expect(body.result.results[0].filledNarrative).toBe("Result: 确认");
  });

  it("processes a batch of form+choice submissions in one request", async () => {
    const res = await submitFormRequest(app, "sess-rpc-1", [
      { interactionId: "b1", type: "form", values: { name: "A" } },
      { interactionId: "b2", type: "choice", values: { selectedId: "x" } },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { results: Array<{ interactionId: string }> };
    };
    expect(body.result.results.map((r) => r.interactionId)).toEqual([
      "b1",
      "b2",
    ]);
  });

  it("returns 400 for an invalid submission type", async () => {
    const res = await submitFormRequest(app, "sess-rpc-1", [
      { interactionId: "x", type: "bogus", values: {} },
    ]);
    expect(res.status).toBe(400);
  });

  it("returns 400 when submission.values is not an object", async () => {
    const res = await submitFormRequest(app, "sess-rpc-1", [
      { interactionId: "x", type: "form", values: [] },
    ]);
    expect(res.status).toBe(400);
  });

  it("rejects framework actions when pluginId is not the canonical sentinel (LOW-3)", async () => {
    // `echo` is a framework default but the request uses pluginId="codex".
    // The canonical sentinel is "framework" — anything else gets 404.
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "codex",
        action: "echo",
        payload: {},
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown-action");
  });

  it("returns 400 when submit-form payload is missing turnId", async () => {
    const res = await app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "framework",
        action: "submit-form",
        payload: { submissions: [] },
      }),
    });
    expect(res.status).toBe(400);
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
    app: Hono;
    store: DataStore;
    registry: PluginRpcRegistry;
    gate: RpcApprovalGate;
    activateCalls: () => number;
  } {
    const store = createMemoryStore();
    const registry = createPluginRpcRegistry();
    const executor = createRpcExecutor({
      registry,
      loadHandler: async () => async (payload) => ({ echoed: payload }),
    });
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
      c.set("activatePluginLocalTools", activate);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);
    return { app, store, registry, gate, activateCalls: () => activateCount };
  }

  function call(app: Hono, action: string) {
    return app.request("/api/sessions/sess-rpc-1/plugin-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: PLUGIN_ID, action, payload: { n: 1 } }),
    });
  }

  it("routes an entry-registered action through the approval gate instead of 404", async () => {
    const { app, store, registry, activateCalls } = setupEntry();
    await seedSession(store);

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

    const first = await call(app, "entry-action");
    const { approvalId } = (await first.json()) as { approvalId: string };
    gate.decide({
      approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });

    const actionApproval = await call(app, "entry-action");
    expect(actionApproval.status).toBe(202);
    const secondPending = (await actionApproval.json()) as {
      approvalId: string;
      pending: { action: string };
    };
    expect(secondPending.pending.action).toBe("entry-action");
    gate.decide({
      approvalId: secondPending.approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });

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

    // Approve loading the entry, then verify an undeclared action is rejected
    // before any action-specific approval is created.
    const first = await call(app, "does-not-exist");
    const { approvalId } = (await first.json()) as { approvalId: string };
    gate.decide({
      approvalId,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });
    const res = await call(app, "does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("unknown-action");
  });
});

// ── Runtime-mode integration tests (plugin-rpc-runtime-pipeline M8b) ─────

type FakeLlm = { generate: (...a: unknown[]) => Promise<unknown> };
type CapturedLlmMessage = { readonly role: string; readonly content: unknown };

class CapturingLlm {
  readonly calls: CapturedLlmMessage[][] = [];

  async generate(params: { readonly messages: readonly CapturedLlmMessage[] }) {
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

function makeFunctionEntry(args: {
  pluginId: string;
  runtimeId: string;
  handler: FunctionHandler;
  execution?: "sync" | "background";
  priority?: number;
  /** Semantic capability tags for framework discovery (findPluginByCapability). */
  capabilities?: readonly string[];
  /** Plugin discovery source — drives trust-gate verdict. Defaults to 'builtin'
   * so happy-path tests auto-allow without explicit approvals. Community
   * coverage is exercised by the approval-required test below. */
  source?: PluginSource;
  /** Per-runtime userSettings frontmatter (audit F7 coverage). */
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
  // RPC trust gate (audit F2). Trust now comes from `entry.source`, which the
  // server bootstrap derives from discovery (first-dir=bundled, others=community).
  const manifest: RuntimeManifest = {
    name: args.runtimeId,
    pluginId: args.pluginId,
    description: "test function runtime",
    priority: args.priority ?? 600,
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
    handler: args.handler,
  };

  const parsed = {
    manifest,
    promptTemplate: "",
    rawFrontmatter: {},
  };

  const entry: PluginRegistryEntry = {
    id: args.pluginId,
    summary: makeSummary(args.pluginId),
    manifest: parsed,
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
  priority?: number;
  source?: PluginSource;
  trigger?: RuntimeManifest["trigger"];
  relations?: RuntimeManifest["relations"];
}): { entry: PluginRegistryEntry; loaded: LoadedRuntime } {
  const manifest: RuntimeManifest = {
    name: args.runtimeId,
    pluginId: args.pluginId,
    description: "test agent runtime",
    priority: args.priority ?? 500,
    runtimeType: "agent",
    outputKind: args.outputKind ?? "story",
    pluginType: "plugin",
    trigger: args.trigger ?? { type: "manual" },
    ...(args.relations ? { relations: args.relations } : {}),
  } as RuntimeManifest;

  const loaded: LoadedRuntime = {
    manifest,
    promptTemplate: "You are a test narrator.",
  };
  const parsed = {
    manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  const entry: PluginRegistryEntry = {
    id: args.pluginId,
    summary: makeSummary(args.pluginId),
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([[args.runtimeId, loaded]]),
    status: "registered",
    source: args.source ?? "builtin",
  } as PluginRegistryEntry;
  return { entry, loaded };
}

interface RuntimeTestEnv {
  app: Hono;
  store: DataStore;
  pluginRegistry: PluginRegistry;
}

function setupRuntimeTestEnv(args: {
  pluginId: string;
  runtimeId: string;
  handler: FunctionHandler;
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
  const rpcExecutor = createRpcExecutor({
    registry: rpcRegistry,
    loadHandler: async () => async () => ({}),
  });
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

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", pluginRegistry);
    c.set("rpcExecutor", rpcExecutor);
    c.set("rpcRegistry", rpcRegistry);
    c.set("rpcApprovalGate", gate);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", loadRuntimeFn);
    c.set("toolExecutor", undefined);
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
  return { app, store, pluginRegistry, gate };
}

async function seedRuntimeSession(
  store: DataStore,
  pluginId: string,
  sessionId = "sess-rt-1",
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id: sessionId,
    worldId: "cloudmere",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [pluginId],
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Wait until `predicate()` returns true or the attempt budget is exhausted.
 * Background jobs flip `_jobs/{id}` from `pending` to `done` via a
 * setImmediate-scheduled async closure — we can't await it directly from the
 * test, so poll the store with microtask yields. No wall-clock sleeps.
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

    // Sync path must NOT write anything into the reserved _jobs namespace.
    const jobs = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
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
      handler: branchReplyHandler as FunctionHandler,
      priority: undefined,
      // Declares the prompt-history-rewriter capability so the framework
      // discovers it (instead of hardcoding "branch-reply" in the executor).
      capabilities: ["branch-reply", "prompt-history-rewriter"],
    });
    const { entry: narratorEntry, loaded: narratorLoaded } = makeAgentEntry({
      pluginId: "chat-mode-narrator",
      runtimeId: "chat-mode-narrator",
      outputKind: "story",
      trigger: { type: "auto" },
      relations: {
        requires: ["branch-reply"],
      },
    });
    pluginRegistry.register(branchEntry);
    pluginRegistry.register(narratorEntry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({
      registry: rpcRegistry,
      loadHandler: async () => async () => ({}),
    });
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
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("toolExecutor", undefined);
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
    app.route("/api/actions", actionRoutes);

    const createSession = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "sess-branch-api",
        plugins: ["chat-mode-narrator"],
        locale: "zh-CN",
      }),
    });
    expect(createSession.status).toBe(200);
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

    const createCandidates = await app.request(
      `/api/sessions/${session.id}/plugin-rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pluginId: "branch-reply",
          runtimeId: "branch-reply",
          payload: {
            action: "createCandidates",
            turnId: "turn-story-1",
            candidates: ["Candidate one text.", "Accepted branch text."],
            count: 2,
          },
        }),
      },
    );
    expect(createCandidates.status).toBe(200);

    const acceptCandidate = await app.request(
      `/api/sessions/${session.id}/plugin-rpc`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
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

    const branchTurns = await store.listPluginData(
      session.id,
      "branch-reply",
      "turns",
    );
    expect(branchTurns[0]?.value).toMatchObject({
      turnId: "turn-story-1",
      status: "accepted",
      acceptedCandidateId: "turn-story-1-candidate-2",
      acceptedText: "Accepted branch text.",
    });

    // Advance out of the Pre-Game band so a send_message schedules the
    // main-loop narrator (priority 500). /api/actions enforces band gating;
    // without this the narrator would not run and no LLM call would be made.
    await store.updateSession(session.id, {
      turnCount: 1,
      preGameCompleted: ["pregame"],
      updatedAt: new Date().toISOString(),
    });

    const nextTurn = await app.request(`/api/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "req-branch-next",
        type: "send_message",
        sessionId: session.id,
        locale: "zh-CN",
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

  it("writes a failed _jobs row when an expected background follower is missing", async () => {
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
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        expectsBackgroundFollower: true,
      }),
    });

    // expectsBackgroundFollower switches the runtime to async-job mode:
    // the route returns 202 immediately with a pending _jobs/<jobId>, then
    // setImmediate runs the prompt-builder. When no follower is emitted, the
    // job row settles to status:'failed' with a 'expected-background-follower-missing' reason.
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

    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      return (
        rows.length === 1 &&
        (rows[0]?.value as { status?: string } | undefined)?.status === "failed"
      );
    });
    const jobs = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.key).toBe(body.jobId);
    expect(jobs[0]?.value).toMatchObject({
      status: "failed",
      progress: 100,
      runtimeId: SYNC_RUNTIME,
      reason: "expected-background-follower-missing",
    });
    expect(String((jobs[0]?.value as { error?: string }).error)).toContain(
      "completed without emitting",
    );
  });

  // ── Audit F7: X-Plugin-User-Settings header → ctx.userSettings ──
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
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: {},
      }),
    });

    expect(res.status).toBe(200);
    expect(handlerCtx?.userSettings).toEqual({ model: "wan2.7-image-pro" });
  });

  it("commits pluginData[] returned by a function handler into plugin_data rows", async () => {
    // F5 regression — `output.pluginData: [{namespace,key,value}]` must
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

  it("returns 202 + jobId for a background runtime and writes _jobs pending → done", async () => {
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

    // Pending row must be visible immediately after the 202 response.
    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      return rows.some((r) => r.key === body.jobId);
    });
    const pendingRows = await store.listPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_jobs",
    );
    const pending = pendingRows.find((r) => r.key === body.jobId);
    expect(pending).toBeDefined();
    const pendingValue = pending!.value as {
      status: string;
      runtimeId: string;
      turnId: string;
      startedAt: string;
    };
    expect(pendingValue.status).toBe("pending");
    expect(pendingValue.runtimeId).toBe(BG_RUNTIME);
    expect(pendingValue.turnId).toBe(body.turnId);

    // Release the handler and wait for the writeback to flip to "done".
    released!();
    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      const row = rows.find((r) => r.key === body.jobId);
      const v = row?.value as { status?: string } | undefined;
      return v?.status === "done";
    });

    const doneRows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    const done = doneRows.find((r) => r.key === body.jobId);
    const doneValue = done!.value as {
      status: string;
      runtimeId: string;
      turnId: string;
      completedAt: string;
      durationMs: number;
      runtimeResults: ReadonlyArray<{
        runtimeId: string;
        status: string;
        output: { ok?: boolean; stage?: string };
      }>;
    };
    expect(doneValue.status).toBe("done");
    expect(doneValue.runtimeId).toBe(BG_RUNTIME);
    expect(doneValue.turnId).toBe(body.turnId);
    expect(typeof doneValue.completedAt).toBe("string");
    expect(typeof doneValue.durationMs).toBe("number");
    expect(doneValue.runtimeResults).toHaveLength(1);
    expect(doneValue.runtimeResults[0]?.runtimeId).toBe(BG_RUNTIME);
    expect(doneValue.runtimeResults[0]?.status).toBe("success");
    expect(doneValue.runtimeResults[0]?.output).toMatchObject({
      ok: true,
      stage: "done",
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

  it("writes _jobs status: failed when a background runtime handler throws (F8 regression)", async () => {
    // Audit F8: before this fix, executeTurn caught the handler exception
    // and marked the runtime as `failed` inside `runtimeResults`, but the
    // background writeback still wrote top-level `status: 'done'`. Frontend
    // watching `_jobs.status` would render a failed image as success.
    // After the fix, any failed runtime surfaces at the top-level AND
    // `value.error` carries the first error message for UI display.
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
        pluginId: PLUGIN_ID,
        runtimeId: BG_RUNTIME,
        payload: {},
      }),
    });

    // The request itself still succeeds with 202 — failure surfaces
    // asynchronously via the `_jobs` writeback, NOT via HTTP status.
    expect(res.status).toBe(202);
    const body = (await res.json()) as { jobId: string };

    // Wait for the writeback to complete — status must be 'failed'.
    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      const row = rows.find((r) => r.key === body.jobId);
      const v = row?.value as { status?: string } | undefined;
      return v?.status === "failed";
    });

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    const row = rows.find((r) => r.key === body.jobId);
    const v = row!.value as {
      status: string;
      runtimeResults?: ReadonlyArray<{
        status: string;
        error?: string;
      }>;
      error?: string;
    };

    expect(v.status).toBe("failed");
    expect(v.error).toContain("handler-exploded");
    // runtimeResults preserved for debug/trace even on failure.
    expect(v.runtimeResults).toBeDefined();
    expect(v.runtimeResults![0]?.status).toBe("failed");
    expect(v.runtimeResults![0]?.error).toContain("handler-exploded");
  });

  // ── Audit F2 regression: trust comes from discovery source, not pluginType.
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

    // First call — community trust forces pending approval. Handler must NOT
    // run. Response is 202 with an `approvalId` the frontend can resolve.
    const first = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { n: 1 },
      }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      status: string;
      approvalId?: string;
    };
    expect(firstBody.status).toBe("approval-required");
    expect(typeof firstBody.approvalId).toBe("string");
    expect(handlerCalls).toBe(0);

    // Resolve the approval as if the frontend called /api/approvals/:id/decision
    // with { decision: 'allow', scope: 'session' }.
    const decideResult = gate.decide({
      approvalId: firstBody.approvalId!,
      decision: "allow",
      scope: "session",
      decidedAt: new Date().toISOString(),
    });
    expect(decideResult.ok).toBe(true);

    // Retry — now auto-allowed for the rest of the session.
    const second = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: PLUGIN_ID,
        runtimeId: SYNC_RUNTIME,
        payload: { n: 2 },
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      status: string;
      runtimeResults: ReadonlyArray<{ status: string }>;
    };
    expect(secondBody.status).toBe("ok");
    expect(secondBody.runtimeResults[0]?.status).toBe("success");
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
    const rpcExecutor = createRpcExecutor({
      registry: rpcRegistry,
      loadHandler: async () => async () => ({}),
    });
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

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("toolExecutor", undefined);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);

    await seedRuntimeSession(store, PLUGIN_ID, SESSION_ID);

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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

  // ── Audit F1: event-chain fan-out respects manifest.execution. ────
  //
  // A P600 sync target emitting an event that matches a P610 follower
  // with `execution: 'background'` must NOT block the sync response on
  // the follower. The route schedules `_jobs/<jobId>` pending BEFORE
  // the 200 flushes, fires setImmediate for the follower, and returns
  // `deferredJobs` so the frontend can subscribe.
  it("sync target + background follower: fast sync response + _jobs per follower", async () => {
    const TARGET = "test-f1/target";
    const FOLLOWER = "test-f1/follower";
    const store = createMemoryStore();
    const pluginRegistry = createPluginRegistry();

    const { loaded: targetLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: TARGET,
      priority: 600,
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
      priority: 610,
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
      manifest: targetLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const parsedFollower = {
      manifest: followerLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: makeSummary(PLUGIN_ID),
      manifest: parsedTarget,
      manifests: [parsedTarget, parsedFollower],
      loadedRuntimes: new Map([
        [TARGET, targetLoaded],
        [FOLLOWER, followerLoaded],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({
      registry: rpcRegistry,
      loadHandler: async () => async () => ({}),
    });
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

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("toolExecutor", undefined);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);

    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: "cloudmere",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [PLUGIN_ID],
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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
      runtimeResults: ReadonlyArray<{ runtimeId: string; status: string }>;
      deferredJobs?: ReadonlyArray<{ jobId: string; runtimeId: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.runtimeResults).toHaveLength(1);
    expect(body.runtimeResults[0]?.runtimeId).toBe(TARGET);
    expect(body.deferredJobs).toHaveLength(1);
    expect(body.deferredJobs![0]?.runtimeId).toBe(FOLLOWER);

    // Follower must have NOT finished yet (response flushed before the
    // setImmediate task got to run its awaited body).
    expect(followerFinished).toBe(false);

    // Wait for the follower to complete and write _jobs done.
    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      const row = rows.find((r) => r.key === body.deferredJobs![0].jobId);
      const v = row?.value as { status?: string } | undefined;
      return v?.status === "done";
    });

    expect(followerStarted).toBe(true);
    expect(followerFinished).toBe(true);

    // Follower should have committed its pluginData through the standard
    // pipeline so the frontend gallery sees the image.
    const images = await store.listPluginData(SESSION_ID, PLUGIN_ID, "images");
    expect(images).toHaveLength(1);
    expect((images[0].value as { url: string }).url).toBe(
      "https://cdn.test/a sunset.png",
    );
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
  // follower handler. Mirrors the F1 setup but parameterises the handler
  // and skips the followerGate/start/finish bookkeeping the F1 case tracks
  // (we care about emitter/store side effects here, not scheduling order).
  function setupTargetAndFollower(args: {
    targetHandler?: FunctionHandler;
    followerHandler: FunctionHandler;
    followerSource?: PluginSource;
  }): {
    app: Hono;
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
      priority: 600,
      execution: "sync",
      handler: targetHandler,
    });

    const { loaded: followerLoaded } = makeFunctionEntry({
      pluginId: PLUGIN_ID,
      runtimeId: FOLLOWER,
      priority: 610,
      execution: "background",
      handler: args.followerHandler,
      ...(args.followerSource ? { source: args.followerSource } : {}),
    });
    (followerLoaded.manifest as { trigger: unknown }).trigger = {
      type: "event",
      topic: "image.prompt.ready",
    };

    const parsedTarget = {
      manifest: targetLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    const parsedFollower = {
      manifest: followerLoaded.manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    };
    pluginRegistry.register({
      id: PLUGIN_ID,
      summary: makeSummary(PLUGIN_ID),
      manifest: parsedTarget,
      manifests: [parsedTarget, parsedFollower],
      loadedRuntimes: new Map([
        [TARGET, targetLoaded],
        [FOLLOWER, followerLoaded],
      ]),
      status: "registered",
      source: "builtin",
    } as PluginRegistryEntry);

    const rpcRegistry = createPluginRpcRegistry();
    const rpcExecutor = createRpcExecutor({
      registry: rpcRegistry,
      loadHandler: async () => async () => ({}),
    });
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

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("pluginRegistry", pluginRegistry);
      c.set("rpcExecutor", rpcExecutor);
      c.set("rpcRegistry", rpcRegistry);
      c.set("rpcApprovalGate", gate);
      c.set("llmAdapter", llm);
      c.set("loadRuntimeFn", loadRuntimeFn);
      c.set("toolExecutor", undefined);
      c.set("resolveModel", () => undefined);
      c.set("eventBus", eventBus);
      c.set("compactorRunner", compactorRunner);
      c.set("sessionLock", sessionLock);
      c.set("prepareToolsForSession", async () => undefined);
      await next();
    });
    app.route("/api/sessions", pluginRpcRoutes);

    return { app, store, targetRuntimeId: TARGET, followerRuntimeId: FOLLOWER };
  }

  async function dispatchTargetAndAwaitJobs(
    app: Hono,
    store: DataStore,
    targetRuntimeId: string,
  ): Promise<{ jobId: string }> {
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: "cloudmere",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "zh-CN",
      activePlugins: [PLUGIN_ID],
      createdAt: now,
      updatedAt: now,
    });

    const res = await app.request(`/api/sessions/${SESSION_ID}/plugin-rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
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

    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      const row = rows.find((r) => r.key === jobId);
      const v = row?.value as { status?: string } | undefined;
      return v?.status === "done" || v?.status === "failed";
    });

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

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    const row = rows.find((r) => r.key === jobId);
    const value = row?.value as { status?: string };
    expect(value?.status).toBe("done");
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
