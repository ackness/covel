/**
 * Setup-runtime control routes: retry / waive a blocked setup runtime.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import type { SetupRuntimeState } from "@covel/shared";
import { setupRuntimeControlRoutes } from "../../src/routes/api/setup-runtime-control.js";

const BLOCKED: SetupRuntimeState = {
  state: "blocked",
  pluginVersion: "1.0.0",
  generation: 1,
  attempts: 2,
  reason: "setup exhausted its retry budget",
  blockedAt: new Date().toISOString(),
};

async function makeApp(
  setupRuntimes: Record<string, SetupRuntimeState>,
): Promise<{ app: Hono; store: DataStore }> {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    worldId: "w",
    status: "active",
    turnCount: 0,
    activePlugins: ["plug"],
    preGameCompleted: [],
    phase: "setup",
    completedPlayerTurns: 0,
    setupRuntimes,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store" as never, store as never);
    await next();
  });
  app.route("/api/sessions", setupRuntimeControlRoutes);
  return { app, store };
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("POST /setup/:runtimeId/retry", () => {
  it("moves a blocked runtime to pending, bumps generation, resets attempts", async () => {
    const { app, store } = await makeApp({ "plug/setup": BLOCKED });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/retry");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { state: SetupRuntimeState };
    expect(json.state).toMatchObject({
      state: "pending",
      generation: 2,
      attempts: 0,
    });
    const mirror = (await store.getSession("s"))!.setupRuntimes!["plug/setup"];
    expect(mirror).toMatchObject({ state: "pending", generation: 2 });
  });

  it("is idempotent on an already-pending runtime (no generation double-bump)", async () => {
    const pending: SetupRuntimeState = {
      state: "pending",
      pluginVersion: "1.0.0",
      generation: 2,
      attempts: 0,
    };
    const { app } = await makeApp({ "plug/setup": pending });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/retry");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { state: SetupRuntimeState };
    expect(json.state).toMatchObject({ state: "pending", generation: 2 });
  });

  it("409s when the runtime is not blocked (done)", async () => {
    const done: SetupRuntimeState = {
      state: "done",
      resolution: "completed",
      generation: 1,
      attempts: 1,
      completedAt: new Date().toISOString(),
      pluginVersion: "1.0.0",
    };
    const { app } = await makeApp({ "plug/setup": done });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/retry");
    expect(res.status).toBe(409);
  });

  it("404s on an unknown session", async () => {
    const { app } = await makeApp({ "plug/setup": BLOCKED });
    const res = await post(app, "/api/sessions/nope/setup/plug%2Fsetup/retry");
    expect(res.status).toBe(404);
  });
});

describe("POST /setup/:runtimeId/waive", () => {
  it("marks a blocked runtime done{waived} with confirm:true", async () => {
    const { app, store } = await makeApp({ "plug/setup": BLOCKED });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/waive", {
      confirm: true,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { state: SetupRuntimeState };
    expect(json.state).toMatchObject({ state: "done", resolution: "waived" });
    const mirror = (await store.getSession("s"))!.setupRuntimes!["plug/setup"];
    expect(mirror.state).toBe("done");
    // The waived runtime enters the legacy preGameCompleted set (gate satisfied).
    expect((await store.getSession("s"))!.preGameCompleted).toContain(
      "plug/setup",
    );
  });

  it("400s without { confirm: true }", async () => {
    const { app } = await makeApp({ "plug/setup": BLOCKED });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/waive", {});
    expect(res.status).toBe(400);
  });

  it("is idempotent on an already-waived runtime", async () => {
    const waived: SetupRuntimeState = {
      state: "done",
      resolution: "waived",
      generation: 1,
      attempts: 2,
      completedAt: new Date().toISOString(),
      pluginVersion: "1.0.0",
      warning: "degraded",
    };
    const { app } = await makeApp({ "plug/setup": waived });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/waive", {
      confirm: true,
    });
    expect(res.status).toBe(200);
  });

  it("409s when the runtime is not blocked (pending)", async () => {
    const pending: SetupRuntimeState = {
      state: "pending",
      pluginVersion: "1.0.0",
      generation: 1,
      attempts: 0,
    };
    const { app } = await makeApp({ "plug/setup": pending });
    const res = await post(app, "/api/sessions/s/setup/plug%2Fsetup/waive", {
      confirm: true,
    });
    expect(res.status).toBe(409);
  });
});
