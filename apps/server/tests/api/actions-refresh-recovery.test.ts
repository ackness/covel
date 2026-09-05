import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import { createEventBus } from "@covel/events";
import {
  createPluginRegistry,
  type PluginRegistryEntry,
} from "@covel/plugin-loader";
import type { LLMAdapter } from "@covel/runtime";
import { actionRoutes } from "../../src/routes/api/actions.js";
import { turnControlRoutes } from "../../src/routes/api/turn-control-routes.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { makeFakeLoadedRuntime, makeFakeLLM } from "./__helpers/fake-llm.js";

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, release: () => resolve() };
}

async function fixture() {
  const store = createMemoryStore();
  const sessionId = crypto.randomUUID();
  const loaded = makeFakeLoadedRuntime({ name: "test-story" });
  const parsed = {
    manifest: loaded.manifest,
    promptTemplate: loaded.promptTemplate,
    rawFrontmatter: {},
  };
  const registry = createPluginRegistry();
  registry.register({
    id: "test-story",
    summary: {
      id: "test-story",
      name: "Story",
      description: "",
      pluginType: "plugin",
      runtimeCount: 1,
    },
    manifest: parsed,
    manifests: [parsed],
    loadedRuntimes: new Map([["test-story", loaded]]),
    status: "registered",
  } as PluginRegistryEntry);
  await store.createSession({
    id: sessionId,
    status: "active",
    phase: "playing",
    completedPlayerTurns: 0,
    metadata: {
      approvalScopeNonce: crypto.randomUUID(),
      sessionIncarnationNonce: crypto.randomUUID(),
    },
    activePlugins: ["test-story"],
    setupRuntimes: {},
    createdAt: new Date().toISOString(),
  });
  const started = gate();
  const finish = gate();
  const fake = makeFakeLLM("The door opens onto a quiet garden.");
  const llm: LLMAdapter = {
    async generate(params) {
      started.release();
      await finish.promise;
      return fake.llm.generate(params);
    },
  };
  const bus = createEventBus(store);
  const lock = createInProcessSessionLock();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("pluginRegistry", registry);
    c.set("llmAdapter", llm);
    c.set("loadRuntimeFn", async () => loaded);
    c.set("resolveModel", () => undefined);
    c.set("eventBus", bus);
    c.set("sessionLock", lock);
    await next();
  });
  app.route("/api/actions", actionRoutes);
  app.route("/api/sessions", turnControlRoutes);
  const post = (payload: Record<string, unknown>, type = "send_message") =>
    app.request("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: crypto.randomUUID(),
        type,
        sessionId,
        payload,
      }),
    });
  const status = async () =>
    (await app.request(`/api/sessions/${sessionId}/execution`)).json();
  return { app, store, sessionId, post, status, started, finish, fake };
}

describe("refreshing a foreground action", () => {
  it("keeps the original model request alive after the SSE reader is cancelled", async () => {
    const f = await fixture();
    const response = await f.post({ content: "Open the door" });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      "execution.started",
    );
    const drain = (async () => {
      while (!(await reader.read()).done) {
        /* keep the live stream flowing */
      }
    })();
    await f.started.promise;
    const running = await f.status();
    expect(running).toMatchObject({ state: "running" });
    await reader.cancel();
    await drain;
    expect(await f.status()).toMatchObject({
      state: "running",
      turnId: running.turnId,
    });
    f.finish.release();
    await expect.poll(async () => (await f.status()).state).toBe("completed");
    expect(f.fake.calls).toHaveLength(1);
    expect((await f.store.getSession(f.sessionId))?.completedPlayerTurns).toBe(
      1,
    );
    expect(
      (await f.store.listMessages(f.sessionId)).some(
        (message) => message.content === "Open the door",
      ),
    ).toBe(true);
    expect(
      (await f.store.listTraceEvents(f.sessionId)).some(
        (event) => event.type === "turn.completed",
      ),
    ).toBe(true);
  });

  it("retains continuation accounting when recovering an opening", async () => {
    const f = await fixture();
    await f.store.addTraceEvent({
      id: "interrupted",
      sessionId: f.sessionId,
      turnId: "old-opening",
      traceId: "old-opening",
      type: "turn.started",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        origin: "continuation",
        recoveryAction: { type: "retry_turn", payload: {} },
      },
    });
    const response = await f.post(
      { recoverFromTurnId: "old-opening" },
      "retry_turn",
    );
    const body = response.text();
    await f.started.promise;
    f.finish.release();
    expect(await body).toContain("execution.completed");
    expect((await f.store.getSession(f.sessionId))?.completedPlayerTurns).toBe(
      0,
    );
    expect((await f.store.listTurnResults(f.sessionId))[0]?.origin).toBe(
      "continuation",
    );
  });

  it("remains running until the post-commit snapshot and trace settle", async () => {
    const f = await fixture();
    const snapshotStarted = gate();
    const snapshotFinish = gate();
    const save = f.store.saveSnapshot.bind(f.store);
    f.store.saveSnapshot = async (snapshot) => {
      snapshotStarted.release();
      await snapshotFinish.promise;
      return save(snapshot);
    };
    const response = await f.post({ content: "Open the door" });
    const body = response.text();
    await f.started.promise;
    f.finish.release();
    await snapshotStarted.promise;
    expect(await f.status()).toMatchObject({ state: "running" });
    snapshotFinish.release();
    await body;
    expect(await f.status()).toMatchObject({ state: "completed" });
  });

  it("executes only one of two recovery requests for the same interrupted turn", async () => {
    const f = await fixture();
    await f.store.addTraceEvent({
      id: "interrupted",
      sessionId: f.sessionId,
      turnId: "old-turn",
      traceId: "old-turn",
      type: "turn.started",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        recoveryAction: {
          type: "send_message",
          payload: { content: "Open the door" },
        },
      },
    });
    const first = await f.post({
      content: "Open the door",
      recoverFromTurnId: "old-turn",
    });
    const firstBody = first.text();
    await f.started.promise;
    const second = await f.post({
      content: "Open the door",
      recoverFromTurnId: "old-turn",
    });
    const secondBody = second.text();
    f.finish.release();
    expect(await firstBody).toContain("execution.completed");
    expect(await secondBody).toContain("no longer available for recovery");
    expect(f.fake.calls).toHaveLength(1);
    expect((await f.store.getSession(f.sessionId))?.completedPlayerTurns).toBe(
      1,
    );
  });
});
