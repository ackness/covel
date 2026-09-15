import { beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  createMemoryMediaStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
  type MediaStore,
  type SnapshotRecord,
} from "@covel/store";
import { buildSessionSnapshot } from "@covel/runtime";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

const at = "2026-09-01T00:00:00.000Z";
let store: DataStore;
let mediaStore: MediaStore;
let app: Hono;
beforeEach(async () => {
  store = createMemoryStore();
  mediaStore = createMemoryMediaStore();
  await store.createSession({
    id: "parent",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    locale: "en-US",
    activePlugins: [],
    createdAt: at,
    updatedAt: at,
  });
  await store.appendTurnMessage({
    id: "model-message",
    sessionId: "parent",
    turnId: "turn",
    sourceType: "runtime",
    role: "assistant",
    content: "Synthetic model history",
    order: 0,
    createdAt: at,
  });
  const routes = new Hono<{
    Variables: {
      store: DataStore;
      mediaStore: MediaStore;
      sessionLock: SessionLock;
    };
  }>();
  routes.use("*", async (c, next) => {
    c.set("store", store);
    c.set("mediaStore", mediaStore);
    c.set("sessionLock", lock);
    await next();
  });
  const lock = createInProcessSessionLock();
  routes.route("/api/sessions", snapshotRoutes);
  app = routes;
});

async function add(
  id: string,
  createdAt = at,
  metadata: unknown = { kind: "story", turnId: "turn" },
  sessionId = "parent",
) {
  await store.addMessage({
    id,
    sessionId,
    role: "assistant",
    content: id,
    metadata,
    createdAt,
  });
}
async function capture(): Promise<SnapshotRecord> {
  const response = await app.request("/api/sessions/parent/snapshots", {
    method: "POST",
  });
  expect(response.status).toBe(201);
  return response.json();
}
function fork(snapshot: SnapshotRecord) {
  return app.request(`/api/sessions/${snapshot.sessionId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fromSnapshotId: snapshot.id }),
  });
}
async function successfulFork(snapshot: SnapshotRecord) {
  const response = await fork(snapshot);
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    sessionId: string;
    forkSnapshotId: string;
  }>;
}

it("preserves ordered chat history and excludes later same-millisecond messages across repeated forks", async () => {
  await add("old", "2026-08-31T00:00:00.000Z");
  // Insert out of id order to exercise the UI's timestamp/id ordering.
  await add("z-story");
  await add("b-story");
  const snapshot = await capture();
  await add("a-later");
  await add("later", "2026-09-02T00:00:00.000Z");
  const child = await successfulFork(snapshot);
  const restored = await buildSessionSnapshot(store, child.sessionId);
  expect(restored.messages.map((message) => message.content)).toEqual([
    "old",
    "b-story",
    "z-story",
  ]);
  expect(restored.messages[1]).toMatchObject({ kind: "story", turnId: "turn" });
  expect(await store.listTurnMessages(child.sessionId)).toHaveLength(1);
  expect(
    restored.messages.every(
      (message) => !["old", "b-story", "z-story"].includes(message.id),
    ),
  ).toBe(true);
  const childSnapshot = (await store.getSnapshot(child.forkSnapshotId))!;
  await add("child-later", at, undefined, child.sessionId);
  const grandchild = await successfulFork(childSnapshot);
  expect(
    (await buildSessionSnapshot(store, grandchild.sessionId)).messages.map(
      (message) => message.content,
    ),
  ).toEqual(["old", "b-story", "z-story"]);
  expect(await store.listMessages("parent")).toHaveLength(5);
});

it("captures the full newest timestamp group across pages and preserves it through browser checkpoints", async () => {
  for (let i = 0; i < 201; i++)
    await add(`message-${String(i).padStart(3, "0")}`);
  const snapshot = await capture();
  expect(snapshot.payload.displayMessagesBoundary?.ids).toHaveLength(201);
  const checkpoint = await exportSessionCheckpoint(store, "parent", {
    revision: 1,
    actionId: "export",
  });
  const restoredStore = createMemoryStore();
  await replaceSessionFromCheckpoint(restoredStore, checkpoint);
  store = restoredStore;
  const child = await successfulFork(snapshot);
  expect(await store.listMessages(child.sessionId)).toHaveLength(201);
});

it("keeps an explicitly empty chat boundary empty after the parent gains messages", async () => {
  const snapshot = await capture();
  expect(snapshot.payload.displayMessagesBoundary).toBeNull();
  await add("later");
  const child = await successfulFork(snapshot);
  expect((await buildSessionSnapshot(store, child.sessionId)).messages).toEqual(
    [],
  );
});

it("uses the snapshot timestamp for legacy v3 chat history", async () => {
  await add("old");
  const snapshot = await capture();
  const legacy = {
    ...snapshot,
    payload: { ...snapshot.payload, displayMessagesBoundary: undefined },
  };
  await store.saveSnapshot(legacy);
  await add("future", "2099-01-01T00:00:00.000Z");
  const child = await successfulFork(legacy);
  expect(
    (await buildSessionSnapshot(store, child.sessionId)).messages.map(
      (message) => message.content,
    ),
  ).toEqual(["old"]);
});

it("rejects an unavailable chat boundary without leaving a partial child", async () => {
  await add("present");
  const snapshot = await capture();
  await store.saveSnapshot({
    ...snapshot,
    payload: {
      ...snapshot.payload,
      displayMessagesBoundary: { createdAt: at, ids: ["missing"] },
    },
  });
  const response = await fork(snapshot);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "cursor_missing" });
  expect(await store.listSessions()).toHaveLength(1);
});

it("keeps chat-only media readable after deleting the parent", async () => {
  const ref = await mediaStore.put(new Uint8Array([1, 2, 3]), "image/png");
  await mediaStore.recordOwnership(ref.id, "parent");
  await add("image", at, { kind: "ui-block", block: { image: ref } });
  const child = await successfulFork(await capture());
  await store.deleteSession("parent");
  await mediaStore.releaseSession("parent");
  expect(await mediaStore.isReferencedBy(ref.id, child.sessionId)).toBe(true);
  expect(
    (await buildSessionSnapshot(store, child.sessionId)).messages[0]?.block,
  ).toEqual({ image: ref });
});

it.each(["missing", "reference-write"])(
  "rolls back chat history when media is %s",
  async (failure) => {
    const ref =
      failure === "missing"
        ? { id: "d".repeat(64), mime: "image/png", size: 3 }
        : await mediaStore.put(new Uint8Array([1, 2, 3]), "image/png");
    await add("image", at, { block: { ref } });
    if (failure === "reference-write") {
      await mediaStore.recordOwnership(ref.id, "parent");
      vi.spyOn(mediaStore, "addRef").mockRejectedValue(
        new Error("Synthetic ref failure"),
      );
    }
    const response = await fork(await capture());
    expect(response.status).toBe(failure === "missing" ? 409 : 500);
    expect(await store.listSessions()).toHaveLength(1);
    expect(await mediaStore.listRefs()).toEqual([]);
  },
);

it.each(["chat", "state", "export"])(
  "does not grant access to foreign media referenced by %s",
  async (source) => {
    const ref = await mediaStore.put(new Uint8Array([9, 8, 7]), "image/png");
    await mediaStore.recordOwnership(ref.id, "another-session");
    if (source === "chat") await add("image", at, { block: { ref } });
    if (source === "state")
      await store.setPluginData({
        id: "data",
        sessionId: "parent",
        pluginId: "fixture",
        namespace: "image",
        key: "image",
        value: { ref },
        createdAt: at,
        updatedAt: at,
      });
    if (source === "export")
      await store.appendRuntimeExport({
        sessionId: "parent",
        producerPluginId: "fixture",
        producerRuntimeId: "fixture",
        recordAs: "image",
        revision: 1,
        pluginVersion: "1.0.0",
        schemaDigest: "synthetic-digest",
        resultId: "synthetic-result",
        value: { ref },
        committedAt: at,
      });
    const snapshot = await capture();
    const response = await fork(snapshot);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "media_reference_forbidden",
    });
    expect(await store.listSessions()).toHaveLength(1);
    expect(await mediaStore.listRefs()).toEqual([]);
    // A parent with an explicit inherited grant can pass that access onward.
    await mediaStore.addRef(ref.id, "parent");
    const child = await successfulFork(snapshot);
    expect(await mediaStore.isReferencedBy(ref.id, child.sessionId)).toBe(true);
  },
);
