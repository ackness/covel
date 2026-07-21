/**
 * Working Memory REST API route tests.
 *
 * Tests the PUT/GET/DELETE round-trip for /api/sessions/:id/working-memory/:scope/:key
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  MAX_WORKING_MEMORY_ENTRIES,
  MAX_WORKING_MEMORY_VALUE_CHARS,
} from "@covel/shared";
import { createMemoryStore, type DataStore } from "@covel/store";
import { workingMemoryRoutes } from "../../src/routes/api/working-memory.js";

function createTestApp(store: DataStore): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    await next();
  });
  app.route("/api/sessions", workingMemoryRoutes);
  return app;
}

describe("Working Memory API routes", () => {
  let store: DataStore;
  let app: Hono;
  const SESSION_ID = "wm-route-sess";

  beforeEach(async () => {
    store = createMemoryStore();
    await store.createSession({
      id: SESSION_ID,
      worldId: "world-1",
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      locale: "en",
      activePlugins: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    app = createTestApp(store);
  });

  afterEach(async () => {
    await store.close();
  });

  describe("PUT → GET → DELETE round-trip", () => {
    it("PUT creates a working memory entry", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/player/prefs`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: { theme: "dark" } }),
        },
      );
      expect(res.status).toBe(200);
      const body = await res.json<Record<string, unknown>>();
      expect(body.success).toBe(true);
      expect(body.scope).toBe("player");
      expect(body.key).toBe("prefs");
    });

    it("GET returns all entries for a session", async () => {
      await store.upsertWorkingMemory({
        id: "wm-1",
        sessionId: SESSION_ID,
        scope: "player",
        key: "prefs",
        value: { theme: "dark" },
        updatedAt: new Date().toISOString(),
      });
      await store.upsertWorkingMemory({
        id: "wm-2",
        sessionId: SESSION_ID,
        scope: "story",
        key: "questLog",
        value: [],
        updatedAt: new Date().toISOString(),
      });

      const res = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory`,
      );
      expect(res.status).toBe(200);
      const body = await res.json<{
        entries: Array<Record<string, unknown>>;
      }>();
      expect(body.entries).toHaveLength(2);
    });

    it("DELETE removes the targeted entry", async () => {
      await store.upsertWorkingMemory({
        id: "wm-del",
        sessionId: SESSION_ID,
        scope: "player",
        key: "temp",
        value: "to-be-deleted",
        updatedAt: new Date().toISOString(),
      });

      const deleteRes = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/player/temp`,
        { method: "DELETE" },
      );
      expect(deleteRes.status).toBe(200);

      const entry = await store.getWorkingMemory(SESSION_ID, "player", "temp");
      expect(entry).toBeNull();
    });

    it("PUT + GET full round-trip", async () => {
      // PUT
      await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/shared/goal`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "find the artifact" }),
        },
      );

      // GET list
      const listRes = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory`,
      );
      const body = await listRes.json<{
        entries: Array<{ scope: string; key: string; value: unknown }>;
      }>();
      const entry = body.entries.find(
        (e) => e.key === "goal" && e.scope === "shared",
      );
      expect(entry).toBeDefined();
      expect(entry!.value).toBe("find the artifact");
    });
  });

  describe("Validation", () => {
    it("PUT with invalid scope returns 400", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/invalid/key`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: 1 }),
        },
      );
      expect(res.status).toBe(400);
    });

    it("PUT rejects a value over the serialized-size cap", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/player/huge`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            value: "x".repeat(MAX_WORKING_MEMORY_VALUE_CHARS + 1),
          }),
        },
      );
      expect(res.status).toBe(413);
      expect(
        await store.getWorkingMemory(SESSION_ID, "player", "huge"),
      ).toBeNull();
    });

    it("PUT enforces the entry-count quota with the commit-handler semantics", async () => {
      // Fill to one below the cap: the write that lands exactly at the limit
      // must still pass (same off-by-one as the working_memory.set commit).
      for (let i = 0; i < MAX_WORKING_MEMORY_ENTRIES - 1; i++) {
        await store.upsertWorkingMemory({
          id: `wm-fill-${i}`,
          sessionId: SESSION_ID,
          scope: "story",
          key: `fill-${i}`,
          value: i,
          updatedAt: new Date().toISOString(),
        });
      }

      const atLimit = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/story/last-slot`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "fits" }),
        },
      );
      expect(atLimit.status).toBe(200);

      // Session is now at capacity: a new key is refused…
      const overflow = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/story/one-too-many`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "rejected" }),
        },
      );
      expect(overflow.status).toBe(409);
      expect(
        await store.getWorkingMemory(SESSION_ID, "story", "one-too-many"),
      ).toBeNull();

      // …but updating an existing key still lands.
      const update = await app.request(
        `/api/sessions/${SESSION_ID}/working-memory/story/last-slot`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: "updated" }),
        },
      );
      expect(update.status).toBe(200);
      const entry = await store.getWorkingMemory(
        SESSION_ID,
        "story",
        "last-slot",
      );
      expect(entry?.value).toBe("updated");
    });

    it("PUT for unknown session returns 404", async () => {
      const res = await app.request(
        "/api/sessions/nonexistent-session/working-memory/player/key",
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: 1 }),
        },
      );
      expect(res.status).toBe(404);
    });
  });
});
