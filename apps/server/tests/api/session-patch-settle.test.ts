import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createMemoryStore } from "@covel/store/memory";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createEventBus } from "@covel/events";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { createSettledSessionLock } from "../../src/routes/api/plugin-rpc/settled-session-lock.js";
import { sessionRoutes } from "../../src/routes/api/session.js";

describe("session status settle barrier", () => {
  it.each(["paused", "ended"])(
    "lets pending work commit before changing the session to %s",
    async (status) => {
      const store = createMemoryStore();
      const sessionLock = createInProcessSessionLock();
      const now = new Date().toISOString();
      await store.createSession({
        id: "session",
        locale: "en",
        status: "active",
        phase: "playing",
        completedPlayerTurns: 1,
        setupRuntimes: {},
        activePlugins: [],
        metadata: { sessionIncarnationNonce: crypto.randomUUID() },
        createdAt: now,
        updatedAt: now,
      });
      let pending = true;
      const listPendingJobs = vi.fn(async () =>
        pending ? [{ jobId: "memory-extraction" }] : [],
      );
      const settledSessionLock = createSettledSessionLock({
        sessionLock,
        listPendingJobs,
        pollIntervalMs: 1,
      });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("sessionLock", sessionLock);
        c.set("settledSessionLock", settledSessionLock);
        c.set("pluginRegistry", createPluginRegistry());
        c.set("eventBus", createEventBus(store));
        await next();
      });
      app.route("/sessions", sessionRoutes);
      const response = app.request("/sessions/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await vi.waitFor(() => expect(listPendingJobs).toHaveBeenCalled());
      await sessionLock.withLock("session", async () => {
        // A worker needs the session to remain active at its commit boundary.
        expect((await store.getSession("session"))?.status).toBe("active");
        pending = false;
      });
      expect((await response).status).toBe(200);
      expect((await store.getSession("session"))?.status).toBe(status);
    },
  );
});
