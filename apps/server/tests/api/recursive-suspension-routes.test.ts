import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import { commitExecution, executeTurn } from "@covel/runtime";
import type { DataStore } from "@covel/store";
import type { RuntimeManifest, RuntimeResult } from "@covel/shared";
import type { FunctionHandler } from "@covel/shared/plugin-runtime";
import { resumeRoutes } from "../../src/routes/api/resume.js";
import {
  maybeSweepExpiredSuspensions,
  suspensionExpirer,
} from "../../src/routes/api/suspension-sweep.js";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";

const opened: DataStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((store) => store.close()));
});
const parent = {
  name: "probe/parent",
  pluginId: "probe",
  description: "Parent",
  runtimeType: "function",
  stage: "narrative",
  trigger: { type: "auto" },
  outputKind: "system",
} as RuntimeManifest;
const child = {
  ...parent,
  name: "probe/child",
  trigger: { type: "manual" },
} as RuntimeManifest;
const ok = { outcome: "success", value: {} } as const;
async function fixture() {
  const store = createMemoryStore();
  opened.push(store);
  const timestamp = new Date().toISOString();
  await store.createSession({
    id: "session",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    setupRuntimes: {},
    seats: [
      { id: "main", controller: "human", role: "player", characters: "auto" },
    ],
    activePlugins: ["probe"],
    locale: "en-US",
    metadata: {
      approvalScopeNonce: "approval",
      sessionIncarnationNonce: "incarnation",
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const eventBus = createEventBus(store);
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  eventBus.onEmit((event) =>
    events.push({
      type: event.type,
      payload: event.payload as Record<string, unknown>,
    }),
  );
  const handlers: Record<string, FunctionHandler> = {
    [parent.name]: async (ctx) => {
      if (ctx.resumedFromSuspensionId) return ok;
      await ctx.progress!.report({
        jobId: "parent",
        state: "succeeded",
        sequence: 1,
      });
      await ctx.recursiveCall({ manualTrigger: { runtimeId: child.name } });
      return {
        outcome: "suspended",
        reason: "Answer",
        resumeSchema: {
          type: "object",
          required: ["answer"],
          properties: { answer: { type: "string" } },
        },
      };
    },
    [child.name]: async (ctx) => {
      await ctx.progress!.report({
        jobId: "child",
        state: "succeeded",
        sequence: 1,
      });
      await ctx.pluginData!.set("notes", "saved", "value");
      return ok;
    },
  };
  const loadRuntime = async (manifest: RuntimeManifest) => ({
    manifest,
    promptTemplate: "",
    handler: handlers[manifest.name],
  });
  const llm = { generate: vi.fn() };
  const execution = await executeTurn(
    {
      sessionId: "session",
      turnId: "turn",
      playerMessage: "Go",
      origin: "player",
    },
    [parent, child],
    { store, eventBus, loadRuntime, llm },
  );
  await commitExecution({
    store,
    eventBus,
    execution,
    completion: { kind: "turn", turnId: "turn", durationMs: 0 },
  });
  const suspension = (await store.listSuspensions("session"))[0]!;
  const savedChild = suspension.pendingContinuation.nestedResults![0]!
    .result as RuntimeResult;
  const registry = createPluginRegistry();
  registry.register({
    id: "probe",
    source: "builtin",
    status: "registered",
    loadedRuntimes: new Map(),
    summary: {
      id: "probe",
      name: "Probe",
      description: "",
      kind: "plugin",
      runtimeCount: 2,
    },
    manifests: [parent, child].map((manifest) => ({
      manifest,
      runtime: { function: {} },
      promptTemplate: "",
      rawFrontmatter: {},
    })),
  });
  const app = new Hono();
  const lock = createInProcessSessionLock();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("sessionLock", lock);
    c.set("eventBus", eventBus);
    c.set("loadRuntimeFn", loadRuntime);
    c.set("getPluginSource", () => "builtin");
    c.set("llmAdapter", llm);
    await next();
  });
  app.route("/api/sessions", resumeRoutes);
  app.route("/api/actions", actionRoutes);
  const path = `/api/sessions/session/suspensions/${suspension.id}`;
  const resume = (data: unknown = { answer: "yes" }) =>
    app.request(`${path}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
  const state = async () => {
    const rows = await store.listJobStatus("session", { jobId: "child" });
    return rows.map((row) => row.state);
  };
  const lifecycle = () =>
    events
      .filter(
        (event) =>
          event.payload.runId === savedChild.runId &&
          event.type !== "runtime.started",
      )
      .map((event) => event.payload.status)
      .filter(Boolean);
  return {
    store,
    eventBus,
    events,
    handlers,
    app,
    registry,
    lock,
    path,
    resume,
    state,
    lifecycle,
    suspension,
    savedChild,
  };
}

describe("recursive suspension routes", () => {
  it.each(["success", "suspended"] as const)(
    "deletes resolved history after %s without cancelling saved work",
    async (status) => {
      const f = await fixture();
      f.handlers[parent.name] = async () =>
        status === "success"
          ? ok
          : {
              outcome: "suspended",
              reason: "Another answer",
              resumeSchema: { type: "object" },
            };
      expect((await f.resume()).status).toBe(200);
      const snapshot = async () => ({
        jobs: await f.store.listJobStatus("session"),
        traces: await f.store.listTraceEvents("session"),
        writes: await f.store.listPluginData("session", "probe", "notes"),
        session: await f.store.getSession("session"),
        events: structuredClone(f.events),
      });
      const before = await snapshot();
      expect((await f.app.request(f.path, { method: "DELETE" })).status).toBe(
        200,
      );
      expect(await f.store.getSuspension(f.suspension.id)).toBeNull();
      expect(await snapshot()).toEqual(before);
      expect((await f.state()).at(-1)).toBe(
        status === "success" ? "succeeded" : "waiting-input",
      );
      if (status === "suspended") {
        const successor = (await f.store.listSuspensions("session")).find(
          (row) => !row.resolvedAt,
        )!;
        expect(successor.id).not.toBe(f.suspension.id);
        f.handlers[parent.name] = async () => ok;
        const response = await f.app.request(
          `/api/sessions/session/suspensions/${successor.id}/resume`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ data: {} }),
          },
        );
        expect(response.status).toBe(200);
      }
      for (const jobId of ["parent", "child"])
        expect(
          (await f.store.listJobStatus("session", { jobId })).at(-1)?.state,
        ).toBe("succeeded");
      expect(await f.store.listPluginData("session", "probe", "notes")).toEqual(
        [expect.objectContaining({ key: "saved", value: "value" })],
      );
    },
  );

  it.each(["failed", "throw", "rollback"])(
    "settles %s, releases the claim and corrects the same child after retry",
    async (failure) => {
      const f = await fixture();
      if (failure === "failed")
        f.handlers[parent.name] = async () => ({
          outcome: "failed",
          error: "Failed attempt",
        });
      if (failure === "throw")
        f.handlers[parent.name] = async () => {
          throw new Error("Thrown attempt");
        };
      if (failure === "rollback") {
        const transaction = f.store.withTransaction.bind(f.store);
        vi.spyOn(f.store, "withTransaction").mockImplementationOnce((work) =>
          transaction(async (tx) => {
            await work(tx);
            throw new Error("Rejected transaction");
          }),
        );
      }
      expect((await f.resume()).status).toBe(500);
      expect(
        (await f.store.getSuspension(f.suspension.id))?.resolvedAt,
      ).toBeUndefined();
      expect(await f.state()).toEqual(["succeeded", "waiting-input", "failed"]);
      expect(f.lifecycle()).toEqual(["success", "suspended", "failed"]);
      const resumedRun = f.events.find(
        (event) => event.type === "runtime.started" && event.payload.resumed,
      )!.payload.runId;
      expect(
        f.events.filter((event) => event.payload.runId === resumedRun).at(-1)
          ?.payload.status,
      ).toBe("failed");
      expect(
        (await f.store.queryTraceEvents("session", { turnId: "turn" }))
          .filter(
            (row) => (row.payload as { runId?: string }).runId === resumedRun,
          )
          .at(-1)?.type,
      ).toBe("runtime.failed");
      expect(await f.store.listPluginData("session", "probe", "notes")).toEqual(
        [],
      );
      f.handlers[parent.name] = async () => ok;
      expect((await f.resume()).status).toBe(200);
      expect(await f.state()).toEqual([
        "succeeded",
        "waiting-input",
        "failed",
        "succeeded",
      ]);
      expect(f.lifecycle()).toEqual([
        "success",
        "suspended",
        "failed",
        "success",
      ]);
      const traces = await f.store.queryTraceEvents("session", {
        turnId: "turn",
        types: ["runtime.completed", "runtime.failed"],
      });
      expect(
        traces
          .filter(
            (row) =>
              (row.payload as { runId?: string }).runId === f.savedChild.runId,
          )
          .map((row) => (row.payload as { status: string }).status),
      ).toEqual(["suspended", "failed", "success"]);
    },
  );

  it("does not settle invalid input, and cancels all saved work after abandon", async () => {
    const f = await fixture();
    expect((await f.resume({})).status).toBe(400);
    expect(await f.state()).toEqual(["succeeded", "waiting-input"]);
    expect((await f.app.request(f.path, { method: "DELETE" })).status).toBe(
      200,
    );
    expect(await f.state()).toEqual([
      "succeeded",
      "waiting-input",
      "cancelled",
    ]);
    expect(f.lifecycle()).toEqual(["success", "suspended", "skipped"]);
    expect(await f.store.listPluginData("session", "probe", "notes")).toEqual(
      [],
    );
  });

  it.each(["outdated", "expiry"])(
    "cancels the saved subtree on %s",
    async (reason) => {
      const f = await fixture();
      if (reason === "outdated") {
        const timestamp = new Date().toISOString();
        await f.store.setPluginData({
          id: "changed",
          sessionId: "session",
          pluginId: "probe",
          namespace: "notes",
          key: "saved",
          value: "newer",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        const response = await f.resume();
        expect(response.status).toBe(409);
        expect(await response.text()).toContain("suspension_outdated");
      } else {
        const expire = suspensionExpirer({
          store: f.store,
          eventBus: f.eventBus,
          pluginRegistry: f.registry,
          sessionLock: f.lock,
        });
        expect(
          await maybeSweepExpiredSuspensions(
            { store: f.store, expire },
            { force: true, now: Date.now() + 8 * 24 * 60 * 60_000 },
          ),
        ).toBe(1);
      }
      expect(await f.state()).toEqual([
        "succeeded",
        "waiting-input",
        "cancelled",
      ]);
      expect(f.lifecycle()).toEqual(["success", "suspended", "skipped"]);
    },
  );

  it("delivers each saved-child suspension correction once on the action stream", async () => {
    const f = await fixture();
    // A new suspension also cancels the older owner, on its original turn.
    const response = await f.app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "action",
        sessionId: "session",
        type: "submit_actions",
        payload: { actions: [{ kind: "say", text: "Continue" }] },
      }),
    });
    const stream = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map(
        (line) =>
          JSON.parse(line.slice(6)) as {
            type: string;
            turnId: string;
            payload: Record<string, unknown>;
          },
      );
    expect(
      stream.find(
        (event) =>
          event.type === "runtime.skipped" &&
          event.payload.runId === f.savedChild.runId,
      ),
    ).toMatchObject({
      turnId: "turn",
      payload: { turnId: "turn", status: "skipped" },
    });
    const childEvents = stream.filter(
      (event) =>
        event.type === "runtime.completed" &&
        event.payload.runtimeId === child.name,
    );
    expect(childEvents.map((event) => event.payload.status)).toEqual([
      "success",
      "suspended",
    ]);
    expect(new Set(childEvents.map((event) => event.payload.runId)).size).toBe(
      1,
    );
    const runId = childEvents[0]!.payload.runId;
    const traces = await f.store.queryTraceEvents("session", {
      types: ["runtime.completed"],
    });
    expect(
      traces
        .filter((row) => (row.payload as { runId?: string }).runId === runId)
        .map((row) => (row.payload as { status: string }).status),
    ).toEqual(["success", "suspended"]);
  });
});
