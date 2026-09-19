import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  createMemoryStore,
  createSqliteStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
  type SnapshotRecord,
} from "@covel/store";
import { buildSessionSnapshot } from "@covel/runtime";
import {
  makeSession,
  makeWorld,
  makeStateEntry,
  makeStateSchema,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

describe.each(["memory", "sqlite"])("fork state schemas on %s", (backend) => {
  let store: DataStore;
  let app: Hono;
  beforeEach(async () => {
    store =
      backend === "sqlite"
        ? createSqliteStore(":memory:")
        : createMemoryStore();
    await store.createWorld(makeWorld({ id: "world-1" }));
    await store.createSession(
      makeSession({
        id: "parent",
        metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      }),
    );
    const routes = new Hono<{
      Variables: { store: DataStore; sessionLock: SessionLock };
    }>();
    const sessionLock = createInProcessSessionLock();
    routes.use("*", async (c, next) => {
      c.set("store", store);
      c.set("sessionLock", sessionLock);
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
  function fork(snapshot: SnapshotRecord) {
    return app.request(`/api/sessions/${snapshot.sessionId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSnapshotId: snapshot.id }),
    });
  }
  async function seed() {
    const schema = makeStateSchema({
      sessionId: "parent",
      tableName: "inventory",
      schema: { fields: ["gold"] },
    });
    await store.saveStateSchema(schema);
    await store.upsertStateEntry(
      makeStateEntry({
        sessionId: "parent",
        tableName: "inventory",
        fieldName: "gold",
        value: 10,
      }),
    );
    return schema;
  }
  async function successfulFork(snapshot: SnapshotRecord) {
    const response = await fork(snapshot);
    expect(response.status).toBe(201);
    return response.json() as Promise<{
      sessionId: string;
      forkSnapshotId: string;
    }>;
  }

  it("restores captured schemas after parent changes, including repeated forks and checkpoint transfer", async () => {
    const original = await seed();
    const snapshot = await capture();
    expect(snapshot.payload.stateSchemas).toEqual([original]);
    await store.deleteStateSchema("parent", "inventory");
    await store.saveStateSchema(
      makeStateSchema({ sessionId: "parent", tableName: "future" }),
    );
    const child = await successfulFork(snapshot);
    const schemas = await store.listStateSchemas(child.sessionId);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]).toMatchObject({
      sessionId: child.sessionId,
      tableName: "inventory",
      schema: original.schema,
    });
    expect(schemas[0]!.id).not.toBe(original.id);
    expect(
      (await buildSessionSnapshot(store, child.sessionId)).gameState,
    ).toEqual({ inventory: { gold: 10 } });
    const childSnapshot = (await store.getSnapshot(child.forkSnapshotId))!;
    expect(childSnapshot.payload.stateSchemas).toEqual(schemas);
    const checkpoint = await exportSessionCheckpoint(store, child.sessionId, {
      revision: 1,
      actionId: "export",
    });
    await replaceSessionFromCheckpoint(store, checkpoint);
    await store.deleteStateSchema(child.sessionId, "inventory");
    const grandchild = await successfulFork(childSnapshot);
    expect(
      (await buildSessionSnapshot(store, grandchild.sessionId)).gameState,
    ).toEqual({ inventory: { gold: 10 } });
    expect(
      (await store.listStateSchemas("parent")).map(
        (schema) => schema.tableName,
      ),
    ).toEqual(["future"]);
  });

  it("does not inherit tables added after an empty snapshot", async () => {
    const snapshot = await capture();
    expect(snapshot.payload.stateSchemas).toEqual([]);
    await seed();
    const child = await successfulFork(snapshot);
    expect(await store.listStateSchemas(child.sessionId)).toEqual([]);
  });

  it("rejects entries whose captured table definition is missing", async () => {
    await seed();
    const snapshot = await capture();
    await store.saveSnapshot({
      ...snapshot,
      payload: { ...snapshot.payload, stateSchemas: [] },
    });
    const before = await store.listSessions();
    const response = await fork(snapshot);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "snapshot_schema_missing",
    });
    expect(await store.listSessions()).toEqual(before);
  });
});
