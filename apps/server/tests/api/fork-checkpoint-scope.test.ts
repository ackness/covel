import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  createMemoryStore,
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
} from "@covel/store";
import {
  makeCharacter,
  makeSession,
  makeSnapshot,
  makeSnapshotPayload,
  makeSuspension,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

describe("fork checkpoint scope", () => {
  it("persists a child snapshot whose nested state can be exported as a checkpoint", async () => {
    const store = createMemoryStore();
    const parentId = "parent-session";
    await store.createSession(makeSession({ id: parentId }));
    const parentSuspension = makeSuspension({ sessionId: parentId });
    await store.saveSuspension(parentSuspension);
    const sourceSnapshot = makeSnapshot({
      sessionId: parentId,
      payload: makeSnapshotPayload({
        characters: [makeCharacter({ sessionId: parentId })],
        suspensions: [parentSuspension],
      }),
    });
    await store.saveSnapshot(sourceSnapshot);
    const app = new Hono<{
      Variables: { store: DataStore; sessionLock: SessionLock };
    }>();
    app.use("*", async (context, next) => {
      context.set("store", store);
      context.set("sessionLock", createInProcessSessionLock());
      await next();
    });
    app.route("/api/sessions", snapshotRoutes);

    const response = await app.request(`/api/sessions/${parentId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSnapshotId: sourceSnapshot.id }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      sessionId: string;
      forkSnapshotId: string;
    };
    const childSnapshot = await store.getSnapshot(body.forkSnapshotId);
    expect(childSnapshot?.payload.characters[0]?.sessionId).toBe(
      body.sessionId,
    );
    expect(await store.getSnapshot(sourceSnapshot.id)).toEqual(sourceSnapshot);
    expect(childSnapshot?.payload.suspensions).toEqual(
      await store.listSuspensions(body.sessionId),
    );
    expect(childSnapshot?.payload.suspensions[0]?.id).not.toBe(
      parentSuspension.id,
    );
    const exported = await exportSessionCheckpoint(store, body.sessionId, {
      revision: 1,
      actionId: "fork-checkpoint",
    });
    expect(exported.snapshots[0]?.payload.characters[0]?.sessionId).toBe(
      body.sessionId,
    );
    await replaceSessionFromCheckpoint(store, exported);
    for (const suspension of exported.snapshots[0]!.payload.suspensions) {
      await store.saveSuspension(suspension);
    }
    expect(await store.getSuspension(parentSuspension.id)).toEqual(
      parentSuspension,
    );
    expect(await store.listSuspensions(body.sessionId)).toEqual(
      exported.suspensions,
    );
  });
});
