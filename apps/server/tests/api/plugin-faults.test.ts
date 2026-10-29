import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import type { SuspensionRecord } from "@covel/store";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { createEventBus } from "@covel/events";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { createRpcApprovalGate } from "@covel/approval";
import {
  executeTurn,
  createHookPipeline,
  createTurnEmitter,
  buildSessionSnapshot,
  PluginExtensionHost,
  PluginServiceRegistry,
} from "@covel/runtime";
import {
  COVEL_EVENT_META,
  DIMENSION_CONTRACT,
  sessionWorldContextV1,
  type RuntimeManifest,
  type Proposal,
} from "@covel/shared";
import { createHostPluginFaults } from "../../src/routes/api/plugin-faults.js";
import { commitExecution } from "../../src/routes/api/commit-execution.js";
import {
  buildTurnExecutorDeps,
  buildResumeTurnExecutorDeps,
} from "../../src/routes/api/turn-execution-deps.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import { registerSessionPluginRoutes } from "../../src/routes/api/session/plugin-routes.js";
import type { SessionRouteEnv } from "../../src/routes/api/session/route-env.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createPluginServiceAdmission } from "../../src/routes/api/bootstrap/plugin-service-admission.js";

const runtime: RuntimeManifest = {
  pluginId: "p",
  name: "p/run",
  description: "probe",
  runtimeType: "function",
  stage: "post-turn",
  trigger: { type: "auto" },
};
async function fixture(
  runtimes: readonly RuntimeManifest[] = [runtime],
  handler: FunctionHandler = async () => {
    throw new Error("self-caused");
  },
) {
  const store = createMemoryStore();
  const eventBus = createEventBus();
  const registry = createPluginRegistry();
  registry.register({
    id: "p",
    source: "builtin",
    packageManifest: parsePluginMd(
      "---\nid: p\nkind: plugin\ndescription: Probe\n---\n",
      "p/PLUGIN.md",
    ),
    manifests: runtimes.map((manifest) => ({
      runtime: manifest.runtimeType === "function" ? { function: {} } : {},
      manifest,
      promptTemplate: "",
      rawFrontmatter: {},
    })),
    summary: {
      id: "p",
      name: "Probe",
      description: "Probe",
      kind: "plugin",
      runtimeCount: runtimes.length,
    },
    loadedRuntimes: new Map(),
    status: "registered",
  });
  const now = new Date().toISOString();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    activePlugins: ["p"],
    metadata: {
      sessionIncarnationNonce: "original",
      approvalScopeNonce: "original",
    },
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    completedPlayerTurns: 0,
    createdAt: now,
    updatedAt: now,
  });
  registry.syncSessionActivations("s", ["p"]);
  const host = createHostPluginFaults({
    store,
    eventBus,
    registry: { getActiveRuntimes: () => runtimes },
  });
  const serviceAdmission = createPluginServiceAdmission({
    store,
    registry,
    pluginFaults: host.latch,
    ensurePluginEntry: async () => {},
  });
  const services = new PluginServiceRegistry(serviceAdmission.admission);
  const extensions = new PluginExtensionHost(services);
  const dimensionProvider = runtimes.find(
    (manifest) => manifest.outputContract === DIMENSION_CONTRACT,
  );
  if (dimensionProvider) {
    // The provider publishes committed dimensions through its extension even
    // when its separately scheduled runtime fails.
    extensions.register(
      dimensionProvider.pluginId,
      { point: sessionWorldContextV1.id, id: "world-context" },
      {
        handler: (_input, ctx) => ({
          dimensionProviderPluginId: dimensionProvider.pluginId,
          dimensions: ctx.world.dimensions,
        }),
      },
    );
  }
  const llm = {
    generate: async () => {
      throw new Error("no model");
    },
  };
  const loadRuntime = async (manifest: RuntimeManifest) => ({
    manifest,
    promptTemplate: "",
    handler,
  });
  const app = new Hono<SessionRouteEnv>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("eventBus", eventBus);
    c.set("pluginFaults", host.latch);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", loadRuntime);
    c.set("hookPipeline", hookPipeline);
    c.set("rpcApprovalGate", createRpcApprovalGate());
    c.set("sessionLock", createInProcessSessionLock());
    await next();
  });
  registerSessionPluginRoutes(app);
  app.route("/api/sessions", sessionRoutes);
  app.route("/api/sessions", resumeRoutes);
  const hookPipeline = createHookPipeline({
    onHandlerOutcome: host.onHandlerOutcome,
    isPluginLatched: host.latch.isLatched,
  });
  const run = async (
    turnId: string,
    origin: "player" | "manual" | "resume" | "background" = "player",
  ) => {
    const emitter = createTurnEmitter({
      store,
      eventBus,
      sessionId: "s",
      turnId,
    });
    const execution = await executeTurn(
      {
        sessionId: "s",
        turnId,
        logicalTurnId: turnId,
        playerMessage: "go",
        origin,
      },
      runtimes,
      {
        store,
        pluginFaults: host.latch,
        hookPipeline,
        emitter,
        services,
        extensions,
        llm,
        loadRuntime,
      },
    );
    const completion =
      origin === "background"
        ? { kind: "detached" as const, turnId }
        : origin === "resume"
          ? {
              kind: "resume" as const,
              turnId,
              suspensionId: "suspension",
              pluginId: "p",
              runtimeId: "p/run",
            }
          : { kind: "turn" as const, turnId, durationMs: 0 };
    await commitExecution({
      store,
      eventBus,
      hookPipeline,
      emitter,
      execution,
      completion,
    });
    return execution;
  };
  return { store, eventBus, host, app, run, hookPipeline };
}

describe("host plugin fault boundary", () => {
  // These prepared executions exercise the commit boundary. The real resume
  // route's pre-commit failure path is covered separately below.
  it.each(["player", "manual", "resume", "background"] as const)(
    "counts faults at the shared boundary for origin=%s",
    async (origin) => {
      const f = await fixture();
      for (const key of ["one", "two", "three"]) await f.run(key, origin);
      expect(f.host.latch.isLatched("s", "p")).toBe(true);
      const counted = (await f.store.listTraceEvents("s")).filter(
        (event) => event.type === "plugin.fault.counted",
      );
      expect(counted).toHaveLength(3);
      const fourth = await f.run("four", origin);
      expect(fourth.result.runtimeResults).toEqual([]);
    },
  );
  it("latches after two prior faults and a self-caused failure through the real resume route without committing or resolving the suspension", async () => {
    const handler = vi.fn<FunctionHandler>(async (ctx) => {
      if (ctx.resumedFromSuspensionId) {
        if (!ctx.pluginData) throw new Error("fixture requires plugin data");
        await ctx.pluginData.set("notes", "resume-write", "uncommitted");
        throw new Error("self-caused resume failure");
      }
      throw new Error("self-caused");
    });
    const f = await fixture([runtime], handler);
    await f.run("one");
    await f.run("two");
    expect(f.host.latch.isLatched("s", "p")).toBe(false);

    const timestamp = new Date().toISOString();
    const pending: Proposal = {
      id: "buffered-before-resume",
      sessionId: "s",
      turnId: "suspended-turn",
      timestamp,
      type: "plugin.data",
      source: { pluginId: runtime.pluginId, runtimeId: runtime.name },
      payload: {
        namespace: "notes",
        key: "buffered-write",
        value: "uncommitted",
      },
    };
    const suspension: SuspensionRecord = {
      id: "faulting-resume",
      sessionId: "s",
      turnId: "suspended-turn",
      pluginId: runtime.pluginId,
      runtimeId: runtime.name,
      reason: "Need input",
      resumeSchema: { type: "object" },
      createdAt: timestamp,
      pendingContinuation: {
        takenUnder: {
          playerTurns: (await f.store.getTurnMessageStats("s"))
            .playerMessageCount,
          pluginVersion: "0.0.0",
          writes: [],
        },
        executionContext: {
          executionId: "suspended-execution",
          origin: "manual",
          countPolicy: "none",
          logicalTurnId: "resume-logical-input",
        },
        messages: [],
        toolCallsSoFar: [],
        pendingProposals: [pending],
      },
    };
    await f.store.saveSuspension(suspension);
    const before = await f.store.getSession("s");
    const events: string[] = [];
    f.eventBus.onEmit((event) => events.push(event.type));
    const commit = vi.spyOn(f.store, "withTransaction");
    const response = await f.app.request(
      "/api/sessions/s/suspensions/faulting-resume/resume",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: {} }),
      },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Resume failed: self-caused resume failure",
    });
    expect(handler).toHaveBeenCalledTimes(3);
    expect(f.host.latch.latched("s")).toEqual([
      { pluginId: "p", consecutiveFaults: 3, latched: true, reason: "runtime" },
    ]);
    expect(events).toContain("plugin.fault.latched");
    expect(commit).not.toHaveBeenCalled();
    expect(await f.store.getSuspension(suspension.id)).toEqual(suspension);
    expect(await f.store.listPluginData("s", "p", "notes")).toEqual([]);
    expect(await f.store.getSession("s")).toEqual(before);
    const view = await f.app.request("/s/plugins");
    expect(await view.json()).toMatchObject({
      items: [
        expect.objectContaining({ id: "p", paused: { reason: "runtime" } }),
      ],
    });
  });

  it("publishes player notices for action forwarding; lists and resumes a paused plugin", async () => {
    const f = await fixture();
    const events: string[] = [];
    f.eventBus.onEmit((event) => events.push(event.type));
    for (const key of ["one", "two", "three"]) await f.run(key);
    expect(events).toContain("plugin.fault.latched");
    expect(COVEL_EVENT_META["plugin.fault.latched"].forwardToActionStream).toBe(
      true,
    );
    expect(COVEL_EVENT_META["plugin.fault.counted"].forwardToActionStream).toBe(
      false,
    );
    const list = await f.app.request("/s/plugins");
    expect(await list.json()).toMatchObject({
      items: [
        expect.objectContaining({ id: "p", paused: { reason: "runtime" } }),
      ],
    });
    const resumed = await f.app.request("/s/plugins/p/resume-fault", {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    expect(JSON.stringify(await resumed.json())).not.toContain('"paused"');
    expect(
      (await f.app.request("/s/plugins/p/resume-fault", { method: "POST" }))
        .status,
    ).toBe(409);
    expect(
      (
        await f.app.request("/s/plugins/unknown/resume-fault", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.app.request("/missing/plugins/p/resume-fault", {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      JSON.stringify(await buildSessionSnapshot(f.store, "s")),
    ).not.toContain('"paused"');
  });
  it.each([
    { outputKind: "story" as const },
    { outputContract: DIMENSION_CONTRACT },
  ])("never pauses protected manifest %j", async (extra) => {
    const f = await fixture([{ ...runtime, ...extra }]);
    for (const key of ["one", "two", "three"]) {
      const execution = await f.run(key);
      expect(execution.result.runtimeResults).toMatchObject([
        { runtimeId: runtime.name, status: "failed", fault: "runtime" },
      ]);
    }
    expect(f.host.latch.isLatched("s", "p")).toBe(false);
    const counted = (await f.store.listTraceEvents("s")).filter(
      (event) => event.type === "plugin.fault.counted",
    );
    expect(counted).toHaveLength(3);
    expect(counted.map((event) => event.payload)).toMatchObject([
      { pluginId: "p", consecutiveFaults: 1 },
      { pluginId: "p", consecutiveFaults: 2 },
      { pluginId: "p", consecutiveFaults: 3 },
    ]);
    const fourth = await f.run("four");
    expect(fourth.result.runtimeResults).toMatchObject([
      { runtimeId: runtime.name, status: "failed", fault: "runtime" },
    ]);
    expect(f.host.latch.isLatched("s", "p")).toBe(false);
  });
  it("attributes a broken hook to its owner and ignores the proposal owner", async () => {
    const f = await fixture([]);
    f.hookPipeline.register({
      id: "bad-hook",
      pluginId: "p",
      event: "PreStateCommit",
      handler: async () => {
        throw new Error("broken");
      },
    });
    for (const turnId of ["one", "two", "three"])
      await f.hookPipeline.run(
        "PreStateCommit",
        {
          event: "PreStateCommit",
          sessionId: "s",
          turnId,
          pluginId: "innocent",
        },
        {},
      );
    expect(f.host.latch.isLatched("s", "p")).toBe(true);
    expect(f.host.latch.isLatched("s", "innocent")).toBe(false);
  });
  it.each(["end", "delete"] as const)(
    "forgets process-local faults on session %s",
    async (operation) => {
      const f = await fixture();
      const ended = vi.fn(async () => {
        throw new Error("paused hook must not run");
      });
      f.hookPipeline.register({
        id: "end-hook",
        event: "SessionEnd",
        pluginId: "p",
        handler: ended,
      });
      for (const key of ["one", "two", "three"])
        f.host.latch.recordHookFault("s", "p", key, "hook");
      expect(f.host.latch.isLatched("s", "p")).toBe(true);
      const response = await f.app.request(
        "/api/sessions/s",
        operation === "delete"
          ? { method: "DELETE" }
          : {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: "ended" }),
            },
      );
      expect(response.status).toBe(200);
      expect(f.host.latch.latched("s")).toEqual([]);
      expect(ended).not.toHaveBeenCalled();
    },
  );

  it("wires the latch into ordinary and resume dependency builders", async () => {
    const f = await fixture();
    f.app.get("/deps", (c) => {
      expect(buildTurnExecutorDeps(c).pluginFaults).toBe(f.host.latch);
      expect(
        buildResumeTurnExecutorDeps(
          c,
          createTurnEmitter({ store: f.store, sessionId: "s", turnId: "turn" }),
          f.eventBus,
        ).pluginFaults,
      ).toBe(f.host.latch);
      return c.text("ok");
    });
    expect((await f.app.request("/deps")).status).toBe(200);
  });
});
