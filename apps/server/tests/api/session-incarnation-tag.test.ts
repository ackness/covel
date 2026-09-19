import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
} from "@covel/store";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createEventBus } from "@covel/events";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { publicSessionIncarnation } from "../../src/routes/api/session/session-guard.js";

describe.each(["memory", "sqlite"])(
  "public session incarnation on %s",
  (backend) => {
    let store: DataStore;
    let app: Hono;
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      store =
        backend === "sqlite"
          ? createSqliteStore(":memory:")
          : createMemoryStore();
      const registry = createPluginRegistry();
      const lock = createInProcessSessionLock();
      const bus = createEventBus();
      app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("storeBackend", backend);
        c.set("pluginRegistry", registry);
        c.set("sessionLock", lock);
        c.set("eventBus", bus);
        await next();
      });
      app.route("/api/sessions", sessionRoutes);
    });
    afterEach(async () => {
      vi.useRealTimers();
      await store.close();
    });

    it("rejects missing identity instead of deriving authority from unrelated fields", () => {
      expect(() =>
        publicSessionIncarnation({
          id: "invalid-identity",
          status: "active",
          phase: "playing",
          completedPlayerTurns: 0,
          setupRuntimes: {},
          activePlugins: [],
          locale: "en-US",
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
          metadata: { ownerTokenHash: "synthetic-owner-hash" },
        }),
      ).toThrow("missing its persisted incarnation");
    });

    it("publishes a stable equality tag without exposing private authority", async () => {
      const created = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "same-id",
          plugins: [],
          incarnation: "forged",
        }),
      });
      expect(created.status).toBe(201);
      const initial = await created.json();
      expect(initial.incarnation).toMatch(/^[a-f0-9]{64}$/);
      const persisted = (await store.getSession("same-id"))!;
      expect(initial.incarnation).not.toBe(
        persisted.metadata?.sessionIncarnationNonce,
      );
      expect(initial.incarnation).not.toBe(persisted.metadata?.ownerTokenHash);
      expect(initial.metadata).not.toHaveProperty("sessionIncarnationNonce");
      expect(initial.metadata).not.toHaveProperty("ownerTokenHash");
      const patch = await app.request("/api/sessions/same-id", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused" }),
      });
      expect((await patch.json()).incarnation).toBe(initial.incarnation);
      expect(
        (await (await app.request("/api/sessions/same-id")).json()).incarnation,
      ).toBe(initial.incarnation);
      expect(
        (await (await app.request("/api/sessions")).json()).items[0]
          .incarnation,
      ).toBe(initial.incarnation);
      expect(
        (await app.request("/api/sessions/same-id", { method: "DELETE" }))
          .status,
      ).toBe(200);
      const replacement = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "same-id", plugins: [] }),
      });
      const next = await replacement.json();
      expect(replacement.status).toBe(201);
      expect(next.createdAt).toBe(initial.createdAt);
      expect(next.incarnation).not.toBe(initial.incarnation);
    });
  },
);
