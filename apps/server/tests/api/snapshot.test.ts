/**
 * Tests for the snapshot / fork API routes (S4-T2).
 *
 * POST   /api/sessions/:id/snapshot   — create manual snapshot
 * GET    /api/sessions/:id/snapshots  — list snapshots
 * POST   /api/sessions/:id/fork       — create new session from snapshot
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createMemoryMediaStore,
  createMemoryStore,
  type DataStore,
  type MediaStore,
  type SnapshotPayloadV1,
} from "@covel/store";
import { createEventBus, type EventBus } from "@covel/events";
import type { SubscriptionEvent } from "@covel/shared";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import {
  hashSessionOwnerToken,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "../../src/routes/api/session/session-guard.js";

// ── Helpers ──────────────────────────────────────────────────────

function createTestApp(
  store: DataStore,
  eventBus?: EventBus,
  mediaStore?: MediaStore,
  sessionLock: SessionLock = createInProcessSessionLock(),
) {
  const app = new Hono<{
    Variables: {
      store: DataStore;
      sessionLock: SessionLock;
      eventBus?: EventBus;
      mediaStore?: MediaStore;
    };
  }>();
  app.use("*", async (c, next) => {
    c.set("store", store);
    c.set("sessionLock", sessionLock);
    if (eventBus) c.set("eventBus", eventBus);
    if (mediaStore) c.set("mediaStore", mediaStore);
    await next();
  });
  app.route("/api/sessions", snapshotRoutes);
  return app;
}

/** Capture every event emitted on the bus during the test. */
function collectEvents(eventBus: EventBus): SubscriptionEvent[] {
  const captured: SubscriptionEvent[] = [];
  eventBus.onEmit((event) => {
    captured.push(event);
  });
  return captured;
}

async function createSession(
  store: DataStore,
  id = "sess-1",
  worldId = "test-world",
) {
  await store.createSession({
    id,
    worldId,
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    locale: "zh-CN",
    activePlugins: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function seedSessionData(store: DataStore, sessionId: string) {
  // Add a character, a plugin-data entry, a working-memory entry, a turn message,
  // and a turn result so the snapshot payload has something to serialize.
  const now = new Date().toISOString();
  await store.upsertCharacter({
    id: `${sessionId}-hero`,
    sessionId,
    name: "Hero",
    type: "player",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });

  await store.setPluginData({
    id: `${sessionId}-pd-1`,
    sessionId,
    pluginId: "test-plugin",
    namespace: "ns",
    key: "k",
    value: { a: 1 },
    createdAt: now,
    updatedAt: now,
  });

  await store.upsertWorkingMemory({
    id: `${sessionId}-wm-1`,
    sessionId,
    key: "mood",
    scope: "player",
    value: "curious",
    updatedAt: now,
  });

  await store.appendTurnMessage({
    id: `${sessionId}-tm-1`,
    sessionId,
    turnId: "turn-1",
    sourceType: "runtime",
    role: "assistant",
    content: "The story begins.",
    order: 0,
    createdAt: now,
  });

  await store.saveTurnResult({
    id: `${sessionId}-tr-1`,
    sessionId,
    turnId: "turn-1",
    runtimeResults: [{ pluginId: "test-plugin", runtimeId: "test-plugin" }],
    durationMs: 50,
    createdAt: now,
  });
}

// ── Tests ─────────────────────────────────────────────────────────

describe("Snapshot routes", () => {
  let store: DataStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await createSession(store);
    await seedSessionData(store, "sess-1");
  });

  // ── POST /snapshot ──────────────────────────────────────────

  describe("POST /api/sessions/:id/snapshot", () => {
    it("returns 404 when session does not exist", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/nonexistent/snapshot", {
        method: "POST",
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "session_not_found",
      );
    });

    it("returns 201 with a manual snapshot", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/sess-1/snapshot", {
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;
      expect(snapshot.kind).toBe("manual");
      expect(snapshot.sessionId).toBe("sess-1");
      expect(snapshot.id).toMatch(/./); // non-empty string

      const payload = snapshot.payload as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(2);
      expect(payload.session).toEqual({
        status: "active",
        turnCount: 1,
        preGameCompleted: [],
        locale: "zh-CN",
        activePlugins: [],
      });
      // Characters / plugin data / working memory were seeded — must appear in payload.
      expect((payload.characters as unknown[]).length).toBe(1);
      expect((payload.pluginData as unknown[]).length).toBeGreaterThanOrEqual(
        1,
      );
      expect((payload.workingMemory as unknown[]).length).toBe(1);
      expect(payload.messagesCursor).toBe("sess-1-tm-1");
    });

    it("persists manual snapshot in store after creation", async () => {
      const app = createTestApp(store);
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });
      const list = await store.listSnapshots("sess-1");
      expect(list).toHaveLength(1);
      expect(list[0].kind).toBe("manual");
    });

    it("waits for the session lock before reading and saving the snapshot", async () => {
      const sessionLock = createInProcessSessionLock();
      const app = createTestApp(store, undefined, undefined, sessionLock);
      let release!: () => void;
      const blocker = sessionLock.withLock(
        "sess-1",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      await Promise.resolve();
      const request = app.request("/api/sessions/sess-1/snapshot", {
        method: "POST",
      });
      await Promise.resolve();
      expect(await store.listSnapshots("sess-1")).toHaveLength(0);

      release();
      await blocker;
      expect((await request).status).toBe(201);
      expect(await store.listSnapshots("sess-1")).toHaveLength(1);
    });

    it("emits state.snapshot.created on the event bus (S4-T5)", async () => {
      const eventBus = createEventBus();
      const captured = collectEvents(eventBus);
      const app = createTestApp(store, eventBus);

      const res = await app.request("/api/sessions/sess-1/snapshot", {
        method: "POST",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const snapshot = body.snapshot as Record<string, unknown>;

      const snapshotEvents = captured.filter(
        (m) => m.type === "state.snapshot.created",
      );
      expect(snapshotEvents).toHaveLength(1);
      const evt = snapshotEvents[0]!;
      expect(evt.topic).toBe("session");
      expect(evt.sessionId).toBe("sess-1");
      const payload = evt.payload as Record<string, unknown>;
      expect(payload["kind"]).toBe("manual");
      expect(payload["snapshotId"]).toBe(snapshot.id);
      expect(typeof payload["turnId"]).toBe("string");
    });
  });

  // ── GET /snapshots ──────────────────────────────────────────

  describe("GET /api/sessions/:id/snapshots", () => {
    it("returns 404 when session does not exist", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/nonexistent/snapshots");
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "session_not_found",
      );
    });

    it("returns empty list for a session with no snapshots", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/sess-1/snapshots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.snapshots).toEqual([]);
    });

    it("returns all snapshots for a session", async () => {
      const app = createTestApp(store);
      // Create two manual snapshots
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });

      const res = await app.request("/api/sessions/sess-1/snapshots");
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect((body.snapshots as unknown[]).length).toBe(2);
    });

    it("does not include snapshots from other sessions", async () => {
      await createSession(store, "sess-other");
      await seedSessionData(store, "sess-other");
      const app = createTestApp(store);
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });
      await app.request("/api/sessions/sess-other/snapshot", {
        method: "POST",
      });

      const res = await app.request("/api/sessions/sess-1/snapshots");
      const body = (await res.json()) as Record<string, unknown>;
      const snapshots = body.snapshots as Array<Record<string, unknown>>;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.sessionId).toBe("sess-1");
    });

    it("returns metadata only — no payload, with payloadSize (audit R-04)", async () => {
      const app = createTestApp(store);
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });

      const res = await app.request("/api/sessions/sess-1/snapshots");
      const body = (await res.json()) as {
        snapshots: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
      expect(body.snapshots).toHaveLength(1);
      const meta = body.snapshots[0]!;
      expect(meta.payload).toBeUndefined();
      expect(typeof meta.id).toBe("string");
      expect(typeof meta.turnId).toBe("string");
      expect(meta.kind).toBe("manual");
      expect(typeof meta.createdAt).toBe("string");
      expect(typeof meta.payloadSize).toBe("number");
      expect(meta.payloadSize as number).toBeGreaterThan(0);
      expect(body.nextCursor).toBeNull();
    });

    it("keyset-paginates with limit + before cursor", async () => {
      const app = createTestApp(store);
      for (let i = 0; i < 3; i++) {
        await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });
      }

      type Page = {
        snapshots: Array<{ id: string }>;
        nextCursor: { createdAt: string; id: string } | null;
      };

      // Newest window; oldest-first inside the page.
      const page1 = (await (
        await app.request("/api/sessions/sess-1/snapshots?limit=2")
      ).json()) as Page;
      expect(page1.snapshots).toHaveLength(2);
      // The next cursor is the oldest returned row's (createdAt, id) position.
      expect(page1.nextCursor).not.toBeNull();
      expect(typeof page1.nextCursor!.createdAt).toBe("string");
      expect(page1.nextCursor!.id).toBe(page1.snapshots[0]!.id);

      const page2 = (await (
        await app.request(
          `/api/sessions/sess-1/snapshots?limit=2` +
            `&before_created_at=${encodeURIComponent(page1.nextCursor!.createdAt)}` +
            `&before_id=${page1.nextCursor!.id}`,
        )
      ).json()) as Page;
      expect(page2.snapshots).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const ids = [...page1.snapshots, ...page2.snapshots].map((s) => s.id);
      expect(new Set(ids).size).toBe(3);
    });

    it("ignores an incomplete cursor (only one half supplied)", async () => {
      const app = createTestApp(store);
      await app.request("/api/sessions/sess-1/snapshot", { method: "POST" });
      // A cursor needs BOTH halves; a lone before_id is dropped → newest window.
      const res = await app.request(
        "/api/sessions/sess-1/snapshots?before_id=nope",
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { snapshots: unknown[] };
      expect(body.snapshots).toHaveLength(1);
    });
  });

  // ── GET /snapshots/:snapshotId ──────────────────────────────

  describe("GET /api/sessions/:id/snapshots/:snapshotId", () => {
    it("returns the full snapshot payload on demand", async () => {
      const app = createTestApp(store);
      const created = (await (
        await app.request("/api/sessions/sess-1/snapshot", { method: "POST" })
      ).json()) as { snapshot: { id: string } };

      const res = await app.request(
        `/api/sessions/sess-1/snapshots/${created.snapshot.id}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        snapshot: { id: string; payload: Record<string, unknown> };
      };
      expect(body.snapshot.id).toBe(created.snapshot.id);
      expect(body.snapshot.payload).toBeDefined();
      expect(body.snapshot.payload.schemaVersion).toBe(2);
    });

    it("returns 404 for an unknown snapshot or one from another session", async () => {
      await createSession(store, "sess-other-payload");
      await seedSessionData(store, "sess-other-payload");
      const app = createTestApp(store);
      const created = (await (
        await app.request("/api/sessions/sess-other-payload/snapshot", {
          method: "POST",
        })
      ).json()) as { snapshot: { id: string } };

      const missing = await app.request(
        "/api/sessions/sess-1/snapshots/unknown-id",
      );
      expect(missing.status).toBe(404);

      const crossSession = await app.request(
        `/api/sessions/sess-1/snapshots/${created.snapshot.id}`,
      );
      expect(crossSession.status).toBe(404);
    });
  });

  // ── POST /fork ──────────────────────────────────────────────

  describe("POST /api/sessions/:id/fork", () => {
    async function createParentSnapshot(
      store: DataStore,
      app: ReturnType<typeof createTestApp>,
    ) {
      const res = await app.request("/api/sessions/sess-1/snapshot", {
        method: "POST",
      });
      const body = (await res.json()) as Record<string, unknown>;
      return (body.snapshot as Record<string, unknown>).id as string;
    }

    it("returns 400 when fromSnapshotId is missing", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 on invalid JSON body", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when parent session does not exist", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/nonexistent/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: "snap-x" }),
      });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code?: string }).code).toBe(
        "session_not_found",
      );
    });

    it("returns 404 when snapshot does not exist", async () => {
      const app = createTestApp(store);
      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: "nonexistent" }),
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when snapshot belongs to a different session", async () => {
      await createSession(store, "sess-other", "test-world");
      await seedSessionData(store, "sess-other");
      const app = createTestApp(store);
      const otherSnapId = await createParentSnapshot(store, app).then(
        async () => {
          const r = await app.request("/api/sessions/sess-other/snapshot", {
            method: "POST",
          });
          const b = (await r.json()) as Record<string, unknown>;
          return (b.snapshot as Record<string, unknown>).id as string;
        },
      );

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: otherSnapId }),
      });
      expect(res.status).toBe(404);
    });

    it("creates a new session with copied characters", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      expect(childId).toMatch(/^test-world-/);
      expect(body.parentSessionId).toBe("sess-1");
      expect(body.fromSnapshotId).toBe(snapId);

      // Child session exists
      const child = await store.getSession(childId);
      expect(child).not.toBeNull();
      expect(child!.worldId).toBe("test-world");

      // Characters were copied with count preserved
      const parentChars = await store.listCharacters("sess-1");
      const childChars = await store.listCharacters(childId);
      expect(childChars).toHaveLength(parentChars.length);
      expect(childChars[0]!.name).toBe("Hero");
      expect(childChars[0]!.sessionId).toBe(childId);
    });

    it("restores lifecycle and runtime configuration from the snapshot", async () => {
      await store.updateSession("sess-1", {
        status: "paused",
        turnCount: 0,
        preGameCompleted: ["setup/schema"],
        locale: "en-US",
        activePlugins: ["setup", "narrator"],
        presetId: "slow-burn",
        runtimeModelOverrides: { narrator: "balance" },
      });
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      await store.updateSession("sess-1", {
        status: "ended",
        turnCount: 42,
        preGameCompleted: ["other/runtime"],
        locale: "ja-JP",
        activePlugins: ["other"],
        presetId: "action",
        runtimeModelOverrides: { narrator: "fast" },
      });

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const childId = ((await res.json()) as { sessionId: string }).sessionId;
      expect(await store.getSession(childId)).toMatchObject({
        status: "paused",
        turnCount: 0,
        preGameCompleted: ["setup/schema"],
        locale: "en-US",
        activePlugins: ["setup", "narrator"],
        presetId: "slow-burn",
        runtimeModelOverrides: { narrator: "balance" },
      });
    });

    it("upgrades legacy V1 snapshots on read using the parent's current lifecycle", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);
      const stored = await store.getSnapshot(snapId);
      expect(stored?.payload.schemaVersion).toBe(2);
      const { session: _session, ...legacyPayload } = stored!
        .payload as Extract<typeof stored.payload, { schemaVersion: 2 }>;
      await store.saveSnapshot({
        ...stored!,
        payload: {
          ...legacyPayload,
          schemaVersion: 1,
        } satisfies SnapshotPayloadV1,
      });
      await store.updateSession("sess-1", {
        status: "paused",
        turnCount: 9,
        preGameCompleted: ["legacy/current"],
        locale: "en-US",
        activePlugins: ["legacy-plugin"],
        presetId: "legacy-current",
        runtimeModelOverrides: { narrator: "fast" },
      });

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const childId = ((await res.json()) as { sessionId: string }).sessionId;
      // V1 payloads predate lifecycle capture, so the fork degrades to the
      // parent session's CURRENT lifecycle fields (the pre-V2 behavior).
      expect(await store.getSession(childId)).toMatchObject({
        status: "paused",
        turnCount: 9,
        preGameCompleted: ["legacy/current"],
        locale: "en-US",
        activePlugins: ["legacy-plugin"],
        presetId: "legacy-current",
        runtimeModelOverrides: { narrator: "fast" },
      });
    });

    it("clamps a snapshot captured on an ended session to a resumable paused fork", async () => {
      const app = createTestApp(store);
      await store.updateSession("sess-1", { status: "ended" });
      const snapId = await createParentSnapshot(store, app);
      const stored = await store.getSnapshot(snapId);
      expect(stored?.payload).toMatchObject({
        schemaVersion: 2,
        session: { status: "ended" },
      });

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const childId = ((await res.json()) as { sessionId: string }).sessionId;
      // 'ended' is terminal with no un-end API — a fork exists to keep
      // playing, so it lands as 'paused' (resumable via resumeSession).
      expect((await store.getSession(childId))?.status).toBe("paused");
    });

    it("waits for the parent session lock before reading the fork source", async () => {
      const sessionLock = createInProcessSessionLock();
      const app = createTestApp(store, undefined, undefined, sessionLock);
      const snapId = await createParentSnapshot(store, app);
      let release!: () => void;
      const blocker = sessionLock.withLock(
        "sess-1",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );

      await Promise.resolve();
      const request = app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      await Promise.resolve();
      expect(await store.listSessions()).toHaveLength(1);

      release();
      await blocker;
      expect((await request).status).toBe(201);
      expect(await store.listSessions()).toHaveLength(2);
    });

    it("copies plugin data and working memory to the child session", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      const childPluginData = await store.listPluginData(
        childId,
        "test-plugin",
      );
      expect(childPluginData.length).toBeGreaterThanOrEqual(1);
      expect(childPluginData[0]!.value).toEqual({ a: 1 });

      const childWm = await store.listWorkingMemory(childId);
      expect(childWm).toHaveLength(1);
      expect(childWm[0]!.key).toBe("mood");
    });

    it("copies session-scoped lorebook entries to the child session", async () => {
      await store.upsertLorebookEntries([
        {
          id: "sess-1-lore-1",
          sessionId: "sess-1",
          pluginId: "test-plugin",
          keys: ["mist"],
          content: "The mist hides ancient ruins.",
          strategy: "selective",
          position: "before_char",
          insertionOrder: 0,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const childId = ((await res.json()) as { sessionId: string }).sessionId;

      const childLore = await store.listSessionLorebookEntries(childId);
      expect(childLore).toHaveLength(1);
      expect(childLore[0]!.content).toBe("The mist hides ancient ruins.");
      expect(childLore[0]!.sessionId).toBe(childId);
    });

    it("remaps character-mirror plugin-data to the child's re-minted character ids", async () => {
      // The mirror namespace keys a row by the character id and stores
      // value.id = same id; characters are re-minted on fork, so both must move.
      await store.setPluginData({
        id: "sess-1-charmirror",
        sessionId: "sess-1",
        pluginId: "character-blueprint",
        namespace: "characters",
        key: "sess-1-hero",
        value: { id: "sess-1-hero", name: "Hero" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const childId = ((await res.json()) as { sessionId: string }).sessionId;

      const childChar = (await store.listCharacters(childId))[0]!;
      const mirror = await store.listPluginData(
        childId,
        "character-blueprint",
        "characters",
      );
      expect(mirror).toHaveLength(1);
      expect(mirror[0]!.key).toBe(childChar.id);
      expect((mirror[0]!.value as { id: string }).id).toBe(childChar.id);
      expect(mirror[0]!.key).not.toBe("sess-1-hero");
    });

    it("copies media_refs for inherited MediaRefs on fork", async () => {
      const mediaStore = createMemoryMediaStore();
      const ref = await mediaStore.put(new Uint8Array([1, 2, 3]), "image/png", {
        prompt: "fork me",
      });
      await mediaStore.recordOwnership(ref.id, "sess-1", "test-plugin");
      await store.setPluginData({
        id: "sess-1-pd-media",
        sessionId: "sess-1",
        pluginId: "test-plugin",
        namespace: "images",
        key: "img-1",
        value: { status: "done", ref },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const app = createTestApp(store, undefined, mediaStore);
      const snapId = await createParentSnapshot(store, app);
      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });

      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      expect(await mediaStore.isReferencedBy(ref.id, childId)).toBe(true);
    });

    it("copies turn messages up to the snapshot cursor", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      // Append an extra message AFTER the snapshot so we can verify the
      // cursor bound actually trims extra parent messages.
      await store.appendTurnMessage({
        id: "sess-1-tm-2",
        sessionId: "sess-1",
        turnId: "turn-2",
        sourceType: "runtime",
        role: "assistant",
        content: "Post-snapshot content.",
        order: 1,
        createdAt: new Date().toISOString(),
      });

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      const childMessages = await store.listTurnMessages(childId);
      expect(childMessages).toHaveLength(1);
      expect(childMessages[0]!.content).toBe("The story begins.");
    });

    it("emits state.snapshot.created (kind=fork) and session.forked on fork (S4-T5)", async () => {
      const eventBus = createEventBus();
      const captured = collectEvents(eventBus);
      const app = createTestApp(store, eventBus);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      const forkSnapshotId = body.forkSnapshotId as string;

      // Two events should be visible against the child session: the
      // snapshot.created (kind=fork) and session.forked.
      const childEvents = captured.filter((m) => m.sessionId === childId);
      const snapshotEvent = childEvents.find(
        (m) => m.type === "state.snapshot.created",
      );
      const forkedEvent = childEvents.find((m) => m.type === "session.forked");
      expect(snapshotEvent).toBeDefined();
      expect(forkedEvent).toBeDefined();

      const snapshotPayload = snapshotEvent!.payload as Record<string, unknown>;
      expect(snapshotPayload["kind"]).toBe("fork");
      expect(snapshotPayload["snapshotId"]).toBe(forkSnapshotId);
      expect(snapshotPayload["parentSnapshotId"]).toBe(snapId);
    });

    it("records a fork snapshot on the child", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;
      expect(body.forkSnapshotId).toMatch(/./);

      const childSnapshots = await store.listSnapshots(childId);
      expect(childSnapshots).toHaveLength(1);
      expect(childSnapshots[0]!.kind).toBe("fork");
      expect(childSnapshots[0]!.parentId).toBe(snapId);
    });

    // Audit 2026-04-20 finding 7.1 — cursor-miss must surface as 409.
    it("returns 409 cursor_missing when payload.messagesCursor no longer exists in parent", async () => {
      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      // Corrupt the stored snapshot: rewrite its cursor to a phantom id that
      // is not present in the parent's turn_messages. Simulates compactor /
      // GC removing the cursor row after the snapshot was taken.
      const stored = await store.getSnapshot(snapId);
      expect(stored).not.toBeNull();
      await store.saveSnapshot({
        ...stored!,
        payload: {
          ...stored!.payload,
          messagesCursor: "phantom-tm-id-not-in-parent",
        },
      });

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("cursor_missing");

      // Transaction must have rolled back — no child session created.
      const sessions = await store.listSessions();
      const childSessions = sessions.filter((s) => s.id !== "sess-1");
      expect(childSessions).toHaveLength(0);
    });

    // Audit 2026-04-20 finding 7.3 — unresolved suspensions must travel with fork.
    it("copies unresolved suspensions to the child session with a fresh id", async () => {
      const now = new Date().toISOString();
      await store.saveSuspension({
        id: "susp-orig",
        sessionId: "sess-1",
        turnId: "turn-1",
        runtimeId: "test-plugin",
        pluginId: "test-plugin",
        reason: "Need more info",
        resumeSchema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
        pendingContinuation: {
          messages: [{ role: "system", content: "sys" }],
          toolCallsSoFar: [],
          pendingProposals: [],
          suspendToolCallId: "tc-1",
        },
        createdAt: now,
      });

      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      // Parent suspension is unchanged.
      const parentSuspensions = await store.listSuspensions("sess-1");
      expect(parentSuspensions).toHaveLength(1);
      expect(parentSuspensions[0]!.id).toBe("susp-orig");

      // Child has a copy with a new id and the rebound sessionId.
      const childSuspensions = await store.listSuspensions(childId);
      expect(childSuspensions).toHaveLength(1);
      expect(childSuspensions[0]!.id).not.toBe("susp-orig");
      expect(childSuspensions[0]!.sessionId).toBe(childId);
      expect(childSuspensions[0]!.reason).toBe("Need more info");
      expect(childSuspensions[0]!.resolvedAt).toBeUndefined();
    });

    // Audit 2026-04-20 finding 7.3 — resolved suspensions must NOT travel.
    it("excludes already-resolved suspensions from the fork", async () => {
      const now = new Date().toISOString();
      await store.saveSuspension({
        id: "susp-resolved",
        sessionId: "sess-1",
        turnId: "turn-1",
        runtimeId: "test-plugin",
        pluginId: "test-plugin",
        reason: "Already handled",
        resumeSchema: {},
        pendingContinuation: {
          messages: [],
          toolCallsSoFar: [],
          pendingProposals: [],
        },
        createdAt: now,
      });
      await store.markSuspensionResolved("susp-resolved");

      const app = createTestApp(store);
      const snapId = await createParentSnapshot(store, app);

      const res = await app.request("/api/sessions/sess-1/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapId }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Record<string, unknown>;
      const childId = body.sessionId as string;

      // Snapshot's payload.suspensions excluded the resolved one, so the
      // child session starts with zero.
      const childSuspensions = await store.listSuspensions(childId);
      expect(childSuspensions).toHaveLength(0);
    });

    it("mints an independent child owner token on hosted tiers", async () => {
      const previousTier = process.env.DEPLOYMENT_TIER;
      const previousOperator = process.env.COVEL_DESKTOP_REST_TOKEN;
      process.env.DEPLOYMENT_TIER = "demo";
      process.env.COVEL_DESKTOP_REST_TOKEN = "operator-secret";
      const parentToken = "parent-owner-token";
      await store.updateSession("sess-1", {
        metadata: {
          [SESSION_OWNER_TOKEN_HASH_KEY]: hashSessionOwnerToken(parentToken),
        },
      });

      try {
        const app = createTestApp(store);
        const snapshotRes = await app.request("/api/sessions/sess-1/snapshot", {
          method: "POST",
          headers: { "X-Session-Token": parentToken },
        });
        expect(snapshotRes.status).toBe(201);
        const snapshotBody = (await snapshotRes.json()) as {
          snapshot: { id: string };
        };

        const forkRes = await app.request("/api/sessions/sess-1/fork", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Session-Token": parentToken,
          },
          body: JSON.stringify({ fromSnapshotId: snapshotBody.snapshot.id }),
        });
        expect(forkRes.status).toBe(201);
        const fork = (await forkRes.json()) as {
          sessionId: string;
          ownerToken?: string;
        };
        expect(fork.ownerToken).toBeTypeOf("string");
        expect(fork.ownerToken).not.toBe(parentToken);

        const child = await store.getSession(fork.sessionId);
        expect(child?.metadata?.[SESSION_OWNER_TOKEN_HASH_KEY]).toBe(
          hashSessionOwnerToken(fork.ownerToken!),
        );
        expect(JSON.stringify(child)).not.toContain(fork.ownerToken);

        expect(
          (await app.request(`/api/sessions/${fork.sessionId}/snapshots`))
            .status,
        ).toBe(401);
        expect(
          (
            await app.request(`/api/sessions/${fork.sessionId}/snapshots`, {
              headers: { "X-Session-Token": parentToken },
            })
          ).status,
        ).toBe(401);
        expect(
          (
            await app.request(`/api/sessions/${fork.sessionId}/snapshots`, {
              headers: { "X-Session-Token": fork.ownerToken! },
            })
          ).status,
        ).toBe(200);
      } finally {
        if (previousTier === undefined) delete process.env.DEPLOYMENT_TIER;
        else process.env.DEPLOYMENT_TIER = previousTier;
        if (previousOperator === undefined)
          delete process.env.COVEL_DESKTOP_REST_TOKEN;
        else process.env.COVEL_DESKTOP_REST_TOKEN = previousOperator;
      }
    });
  });
});

// ── Post-commit auto snapshot ───────────────────────────────────

describe("Auto snapshot", () => {
  let store: DataStore;

  beforeEach(async () => {
    store = createMemoryStore();
    await createSession(store, "sess-auto");
    await seedSessionData(store, "sess-auto");
  });

  it("produces a kind=auto snapshot after turn persistence", async () => {
    const { executeTurn, saveAutoSnapshot } = await import("@covel/runtime");

    await executeTurn(
      { sessionId: "sess-auto", turnId: "turn-auto-1", playerMessage: "hi" },
      [],
      {
        loadRuntime: async () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: {
          generate: async () => ({
            content: "",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
        } as any,
        store,
      },
    );
    await saveAutoSnapshot({
      store,
      sessionId: "sess-auto",
      turnId: "turn-auto-1",
    });

    const snapshots = await store.listSnapshots("sess-auto");
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    const auto = snapshots.find((s) => s.kind === "auto");
    expect(auto).toBeDefined();
    expect(auto!.turnId).toBe("turn-auto-1");
  });

  it("emits state.snapshot.created (kind=auto) on the event bus (S4-T5)", async () => {
    const { executeTurn, saveAutoSnapshot } = await import("@covel/runtime");
    const eventBus = createEventBus();
    const captured = collectEvents(eventBus);

    await executeTurn(
      { sessionId: "sess-auto", turnId: "turn-auto-2", playerMessage: "hi" },
      [],
      {
        loadRuntime: async () => undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        llm: {
          generate: async () => ({
            content: "",
            toolCalls: [],
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
        } as any,
        store,
        eventBus,
      },
    );
    await saveAutoSnapshot({
      store,
      sessionId: "sess-auto",
      turnId: "turn-auto-2",
      eventBus,
    });

    const snapshotEvents = captured.filter(
      (m) => m.type === "state.snapshot.created",
    );
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);
    const evt = snapshotEvents[0]!;
    expect(evt.topic).toBe("session");
    expect(evt.sessionId).toBe("sess-auto");
    const payload = evt.payload as Record<string, unknown>;
    expect(payload["kind"]).toBe("auto");
    expect(payload["turnId"]).toBe("turn-auto-2");
    expect(typeof payload["snapshotId"]).toBe("string");
  });
});
