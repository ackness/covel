/**
 * Lorebook REST API route tests.
 *
 * Tests the framework-owned session lorebook viewer endpoints:
 *   GET    /api/sessions/:id/lorebook
 *   POST   /api/sessions/:id/lorebook
 *   PUT    /api/sessions/:id/lorebook/:entryId
 *   PATCH  /api/sessions/:id/lorebook/:entryId  (toggle enabled)
 *   DELETE /api/sessions/:id/lorebook/:entryId
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  type DataStore,
  type LorebookEntryRecord,
} from "@covel/store";
import { lorebookRoutes } from "../../src/routes/api/lorebook.js";

function createTestApp(store: DataStore): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("store", store);
    await next();
  });
  app.route("/api/sessions", lorebookRoutes);
  return app;
}

function makeEntry(
  sessionId: string,
  id: string,
  overrides: Partial<LorebookEntryRecord> = {},
): LorebookEntryRecord {
  const now = new Date().toISOString();
  return {
    id,
    sessionId,
    pluginId: "test-plugin",
    keys: [],
    content: `content for ${id}`,
    strategy: "constant",
    position: "before-memory",
    insertionOrder: 100,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("Lorebook API routes", () => {
  const SESSION_ID = "lorebook-route-sess";
  let store: DataStore;
  let app: Hono;

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

  describe("GET /api/sessions/:id/lorebook", () => {
    it("returns empty list when no entries exist", async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook`);
      expect(res.status).toBe(200);
      const body = await res.json<{ entries: LorebookEntryRecord[] }>();
      expect(body.entries).toEqual([]);
    });

    it("returns all session-scoped entries sorted by insertionOrder", async () => {
      await store.upsertLorebookEntries([
        makeEntry(SESSION_ID, "b", { insertionOrder: 200 }),
        makeEntry(SESSION_ID, "a", { insertionOrder: 100 }),
      ]);

      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook`);
      expect(res.status).toBe(200);
      const body = await res.json<{ entries: LorebookEntryRecord[] }>();
      expect(body.entries).toHaveLength(2);
      expect(body.entries[0].id).toBe("a");
      expect(body.entries[1].id).toBe("b");
    });

    it("returns 404 when session does not exist", async () => {
      const res = await app.request("/api/sessions/nope/lorebook");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/sessions/:id/lorebook", () => {
    it("creates a session lorebook entry", async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "manual-rule",
          content: "Manual rule content",
          keys: ["manual"],
          strategy: "selective",
          position: "before_plugin",
          insertionOrder: 12,
          extra: { coordinate: { position: "before_plugin" } },
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json<{ entry: LorebookEntryRecord }>();
      expect(body.entry).toMatchObject({
        id: "manual-rule",
        sessionId: SESSION_ID,
        pluginId: "manual-lorebook",
        content: "Manual rule content",
        keys: ["manual"],
        strategy: "selective",
        position: "before_plugin",
        insertionOrder: 12,
        enabled: true,
        extra: { coordinate: { position: "before_plugin" } },
      });

      const entries = await store.listSessionLorebookEntries(SESSION_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe("manual-rule");
    });

    it("returns 400 for invalid create body", async () => {
      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "../bad", content: "" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("PUT /api/sessions/:id/lorebook/:entryId", () => {
    it("updates a session lorebook entry while preserving stable fields", async () => {
      await store.upsertLorebookEntries([
        makeEntry(SESSION_ID, "e1", {
          pluginId: "owner-plugin",
          keys: ["old"],
          content: "old content",
          strategy: "selective",
          position: "after_plugin",
          insertionOrder: 9,
          enabled: false,
        }),
      ]);

      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook/e1`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: "new content",
          keys: ["new"],
          position: "at_depth",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json<{ entry: LorebookEntryRecord }>();
      expect(body.entry).toMatchObject({
        id: "e1",
        pluginId: "owner-plugin",
        content: "new content",
        keys: ["new"],
        strategy: "selective",
        position: "at_depth",
        insertionOrder: 9,
        enabled: false,
      });
    });
  });

  describe("PATCH /api/sessions/:id/lorebook/:entryId", () => {
    it("toggles enabled flag", async () => {
      await store.upsertLorebookEntries([
        makeEntry(SESSION_ID, "e1", { enabled: true }),
      ]);

      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook/e1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(200);

      const entries = await store.listSessionLorebookEntries(SESSION_ID);
      expect(entries).toHaveLength(1);
      expect(entries[0].enabled).toBe(false);
    });

    it("preserves all other fields when toggling enabled", async () => {
      await store.upsertLorebookEntries([
        makeEntry(SESSION_ID, "e1", {
          enabled: true,
          content: "original content",
          insertionOrder: 42,
        }),
      ]);

      await app.request(`/api/sessions/${SESSION_ID}/lorebook/e1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });

      const entries = await store.listSessionLorebookEntries(SESSION_ID);
      expect(entries[0].content).toBe("original content");
      expect(entries[0].insertionOrder).toBe(42);
    });

    it("returns 400 on missing enabled field", async () => {
      await store.upsertLorebookEntries([makeEntry(SESSION_ID, "e1")]);
      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook/e1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when entry does not exist", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/lorebook/nope`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when session does not exist", async () => {
      const res = await app.request("/api/sessions/nope/lorebook/e1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/sessions/:id/lorebook/:entryId", () => {
    it("removes the targeted entry", async () => {
      await store.upsertLorebookEntries([
        makeEntry(SESSION_ID, "e1"),
        makeEntry(SESSION_ID, "e2"),
      ]);

      const res = await app.request(`/api/sessions/${SESSION_ID}/lorebook/e1`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);

      const remaining = await store.listSessionLorebookEntries(SESSION_ID);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("e2");
    });

    it("returns 404 when entry does not exist", async () => {
      const res = await app.request(
        `/api/sessions/${SESSION_ID}/lorebook/nope`,
        {
          method: "DELETE",
        },
      );
      expect(res.status).toBe(404);
    });

    it("returns 404 when session does not exist", async () => {
      const res = await app.request("/api/sessions/nope/lorebook/e1", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
