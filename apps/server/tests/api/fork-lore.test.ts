import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionContextSnapshot } from "@covel/context";
import {
  createMemoryStore,
  createSqliteStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
  type SnapshotRecord,
} from "@covel/store";
import {
  makeSession,
  makeSnapshot,
  makeSnapshotPayload,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";
import {
  hashSessionOwnerToken,
  SESSION_APPROVAL_SCOPE_KEY,
  SESSION_INCARNATION_KEY,
  SESSION_OWNER_TOKEN_HASH_KEY,
} from "../../src/routes/api/session/session-guard.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";

const parentMetadata = {
  [SESSION_OWNER_TOKEN_HASH_KEY]: hashSessionOwnerToken(
    "synthetic-parent-owner",
  ),
  [SESSION_APPROVAL_SCOPE_KEY]: "synthetic-parent-approval",
  [SESSION_INCARNATION_KEY]: "synthetic-parent-incarnation",
  unrelatedMetadata: "parent-only",
};

describe.each(["memory", "sqlite"])("fork lore on %s", (backend) => {
  let store: DataStore;
  let app: Hono;

  beforeEach(async () => {
    store =
      backend === "sqlite"
        ? createSqliteStore(":memory:")
        : createMemoryStore();
    await store.upsertWorld(makeWorld({ id: "world-1", lore: "World lore" }));
    await store.createSession(
      makeSession({ id: "parent", metadata: parentMetadata }),
    );
    const routes = new Hono<{
      Variables: { store: DataStore; sessionLock: SessionLock };
    }>();
    const sessionLock = createInProcessSessionLock();
    routes.use("*", async (context, next) => {
      context.set("store", store);
      context.set("sessionLock", sessionLock);
      await next();
    });
    routes.route("/api/sessions", snapshotRoutes);
    app = routes;
  });

  afterEach(async () => {
    await store.close();
  });

  async function capture(): Promise<SnapshotRecord> {
    const response = await app.request("/api/sessions/parent/snapshots", {
      method: "POST",
    });
    expect(response.status).toBe(201);
    return response.json();
  }

  async function fork(snapshot: SnapshotRecord) {
    const response = await app.request(
      `/api/sessions/${snapshot.sessionId}/fork`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromSnapshotId: snapshot.id }),
      },
    );
    expect(response.status).toBe(201);
    return response.json() as Promise<{
      sessionId: string;
      forkSnapshotId: string;
      ownerToken: string;
    }>;
  }

  async function contextLore(sessionId: string) {
    const context = await buildSessionContextSnapshot(store, sessionId, {
      locale: "en-US",
      turnNumber: 0,
      worldId: "world-1",
    });
    return context.world.lore;
  }

  it.each([
    { label: "custom", loreOverride: "Captured session lore" },
    { label: "empty", loreOverride: "" },
    { label: "long world document", loreOverride: "x".repeat(500_001) },
  ])(
    "preserves $label lore through parent edits, checkpoint transfer and repeated forks",
    async ({ loreOverride }) => {
      await store.updateSession("parent", {
        metadata: { ...parentMetadata, loreOverride },
      });
      const snapshot = await capture();
      expect(snapshot.payload.session).toMatchObject({ loreOverride });
      expect(snapshot.payload.session).not.toHaveProperty("metadata");

      await store.updateSession("parent", {
        metadata: { ...parentMetadata, loreOverride: "Later parent lore" },
      });
      await store.upsertWorld(
        makeWorld({ id: "world-1", lore: "Later world" }),
      );
      const child = await fork(snapshot);
      expect(await contextLore(child.sessionId)).toBe(loreOverride);

      const checkpoint = await exportSessionCheckpoint(store, child.sessionId, {
        revision: 1,
        actionId: "fork-lore-transfer",
      });
      await replaceSessionFromCheckpoint(store, checkpoint);
      expect(await contextLore(child.sessionId)).toBe(loreOverride);
      const childSnapshot = (await store.getSnapshot(child.forkSnapshotId))!;
      expect(childSnapshot.payload.session).toMatchObject({ loreOverride });
      const childSession = (await store.getSession(child.sessionId))!;
      await store.updateSession(child.sessionId, {
        metadata: {
          ...childSession.metadata,
          loreOverride: "Later child lore",
        },
      });
      const grandchild = await fork(childSnapshot);
      expect(await contextLore(grandchild.sessionId)).toBe(loreOverride);
      expect(await contextLore("parent")).toBe("Later parent lore");
      expect(await store.getSnapshot(snapshot.id)).toEqual(snapshot);
    },
  );

  it("restores a persisted lore field while minting independent child authority", async () => {
    const payload = makeSnapshotPayload();
    const snapshot = makeSnapshot({
      sessionId: "parent",
      payload: {
        ...payload,
        session: { ...payload.session, loreOverride: "Persisted lore" },
      },
    });
    await store.saveSnapshot(snapshot);
    const child = await fork(snapshot);
    const childSession = (await store.getSession(child.sessionId))!;
    expect(childSession.metadata?.loreOverride).toBe("Persisted lore");
    expect(childSession.metadata?.[SESSION_OWNER_TOKEN_HASH_KEY]).toBe(
      hashSessionOwnerToken(child.ownerToken),
    );
    for (const key of [
      SESSION_OWNER_TOKEN_HASH_KEY,
      SESSION_APPROVAL_SCOPE_KEY,
      SESSION_INCARNATION_KEY,
    ] as const) {
      expect(childSession.metadata?.[key]).toEqual(expect.any(String));
      expect(childSession.metadata?.[key]).not.toBe(parentMetadata[key]);
    }
    expect(childSession.metadata).not.toHaveProperty("unrelatedMetadata");
  });

  it("keeps world fallback when the captured session has no override", async () => {
    const snapshot = await capture();
    expect(snapshot.payload.session).not.toHaveProperty("loreOverride");
    await store.updateSession("parent", {
      metadata: { ...parentMetadata, loreOverride: "Later parent lore" },
    });
    const child = await fork(snapshot);
    expect(
      (await store.getSession(child.sessionId))?.metadata,
    ).not.toHaveProperty("loreOverride");
    expect(await contextLore(child.sessionId)).toBe("World lore");
  });

  it("accepts older v3 snapshots without inferring past lore from the live parent", async () => {
    const snapshot = makeSnapshot({ sessionId: "parent" });
    await store.saveSnapshot(snapshot);
    await store.updateSession("parent", {
      metadata: { ...parentMetadata, loreOverride: "Uncaptured parent lore" },
    });
    const child = await fork(snapshot);
    expect(await contextLore(child.sessionId)).toBe("World lore");
  });
});
