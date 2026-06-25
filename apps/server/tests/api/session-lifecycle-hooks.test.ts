/**
 * SessionStart / SessionEnd hook wiring tests.
 *
 * Verifies the session-lifecycle hooks fire from the session routes:
 * - SessionStart on POST /api/sessions (after create + plugin activation)
 * - SessionEnd on PATCH status→ended and on DELETE
 */

import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { createStateManager } from "@covel/state";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { createHookPipeline } from "@covel/runtime";
import { sessionRoutes } from "../../src/routes/api/session.js";

function build() {
  const store = createMemoryStore();
  const hookPipeline = createHookPipeline();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("stateManager", createStateManager(store));
    c.set("pluginRegistry", createPluginRegistry());
    c.set("hookPipeline", hookPipeline);
    await next();
  });
  app.route("/api/sessions", sessionRoutes);
  return { app, hookPipeline };
}

async function createSession(app: Hono): Promise<string> {
  const res = await app.request("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ worldId: "cloudmere", locale: "en-US" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id: string };
  return body.id;
}

describe("Session lifecycle hooks", () => {
  it("fires SessionStart on session creation with sessionId + worldId", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionStart:0",
      event: "SessionStart",
      handler,
    });

    const id = await createSession(app);

    expect(handler).toHaveBeenCalledTimes(1);
    const [, payload] = handler.mock.calls[0];
    expect(payload).toMatchObject({ sessionId: id, worldId: "cloudmere" });
  });

  it("fires SessionEnd on transition to ended (and not twice)", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:0",
      event: "SessionEnd",
      handler,
    });

    const id = await createSession(app);

    const patch = async (status: string) =>
      app.request(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

    // Pause first — no SessionEnd.
    await patch("paused");
    expect(handler).not.toHaveBeenCalled();

    // Transition to ended — one SessionEnd.
    await patch("ended");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      reason: "ended",
    });

    // Re-patching an already-ended session does not fire again.
    await patch("ended");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("fires SessionEnd with reason 'deleted' on DELETE", async () => {
    const { app, hookPipeline } = build();
    const handler = vi.fn().mockResolvedValue({ action: "continue" });
    hookPipeline.register({
      id: "test:SessionEnd:del",
      event: "SessionEnd",
      handler,
    });

    const id = await createSession(app);
    await app.request(`/api/sessions/${id}`, { method: "DELETE" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({
      sessionId: id,
      reason: "deleted",
    });
  });
});
