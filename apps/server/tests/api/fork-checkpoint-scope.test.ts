import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  exportSessionCheckpoint,
  replaceSessionFromCheckpoint,
  type DataStore,
} from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import {
  makeCharacter,
  makeSession,
  makeWorld,
  makeSnapshot,
  makeSnapshotPayload,
  makeSuspension,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { createPluginRegistry, parsePluginMd } from "@covel/plugin-loader";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import {
  createInProcessSessionLock,
  type SessionLock,
} from "../../src/lib/session-lock.js";

describe("fork checkpoint scope", () => {
  it("persists a child snapshot whose nested state can be exported as a checkpoint", async () => {
    const store = createMemoryStore();
    await store.createWorld(makeWorld({ id: "world-1" }));
    const parentId = "parent-session";
    await store.createSession(
      makeSession({
        id: parentId,
        metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      }),
    );
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

  it("leaves job and log rows from a legacy snapshot behind", async () => {
    const store = createMemoryStore();
    await store.createWorld(makeWorld({ id: "world-1" }));
    const parentId = "legacy-parent";
    await store.createSession(
      makeSession({
        id: parentId,
        metadata: { sessionIncarnationNonce: crypto.randomUUID() },
      }),
    );
    const row = (namespace: string) => ({
      id: `${parentId}:plugin-1:${namespace}:k`,
      sessionId: parentId,
      pluginId: "plugin-1",
      namespace,
      key: "k",
      value: { namespace },
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    const sourceSnapshot = makeSnapshot({
      sessionId: parentId,
      payload: makeSnapshotPayload({
        pluginData: [
          row("notes"),
          row("_jobs"),
          row("_runtime_jobs"),
          row("_runtime_job_control"),
          row("_logs"),
        ],
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
    expect(
      (await store.listPluginDataSessionScope(body.sessionId)).map(
        (record) => record.namespace,
      ),
    ).toEqual(["notes"]);
    expect(
      (await store.getSnapshot(body.forkSnapshotId))?.payload.pluginData.map(
        (record) => record.namespace,
      ),
    ).toEqual(["notes"]);
  });
});

describe("fork with a bound dimension provider", () => {
  const PROVIDER = "dimension-provider";

  /**
   * A parent whose snapshot is bound to `PROVIDER`. A community provider is
   * approved per session, so the child cannot start with it active.
   */
  async function fork(source: "builtin" | "community", withData: boolean) {
    const store = createMemoryStore();
    const parentId = "parent-session";
    const registry = createPluginRegistry();
    registry.register({
      id: PROVIDER,
      rootPath: "",
      source,
      status: "registered",
      manifests: [],
      loadedRuntimes: new Map(),
      summary: {
        id: PROVIDER,
        name: "Dimension Provider",
        description: "",
        pluginType: "core-plugin",
        runtimeCount: 0,
      },
      packageManifest: parsePluginMd(
        `---\nid: ${PROVIDER}\nkind: core\ndescription: Dimension provider\nprovides:\n  - world.dimensions@1\n---\n`,
        `${PROVIDER}/PLUGIN.md`,
      ),
    });
    await store.createWorld(makeWorld({ id: "world-1" }));
    await store.createSession(
      makeSession({
        id: parentId,
        activePlugins: [PROVIDER],
        metadata: {
          _dimensionProviderPluginId: PROVIDER,
          sessionIncarnationNonce: crypto.randomUUID(),
        },
      }),
    );
    const now = new Date().toISOString();
    const row = {
      id: "dimension-row",
      sessionId: parentId,
      pluginId: PROVIDER,
      namespace: "_dimensions",
      key: "weather",
      value: {
        definition: {
          name: "Weather",
          schema: { type: "string" },
          initialValue: "sunny",
        },
        value: "sunny",
        version: 1,
      },
      createdAt: now,
      updatedAt: now,
    };
    const sourceSnapshot = makeSnapshot({
      sessionId: parentId,
      payload: makeSnapshotPayload({
        pluginData: withData ? [row] : [],
        session: {
          status: "active",
          phase: "playing",
          locale: "en-US",
          activePlugins: [PROVIDER],
          completedPlayerTurns: 1,
          setupRuntimes: {},
          dimensionProviderPluginId: PROVIDER,
        },
      }),
    });
    await store.saveSnapshot(sourceSnapshot);
    const app = new Hono();
    app.use("*", async (context, next) => {
      context.set("store" as never, store as never);
      context.set(
        "sessionLock" as never,
        createInProcessSessionLock() as never,
      );
      context.set("pluginRegistry" as never, registry as never);
      await next();
    });
    app.route("/api/sessions", snapshotRoutes as never);
    const response = await app.request(`/api/sessions/${parentId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSnapshotId: sourceSnapshot.id }),
    });
    return { store, response, body: await response.json() };
  }

  const exportChild = (store: DataStore, sessionId: string) =>
    exportSessionCheckpoint(store, sessionId, {
      revision: 1,
      actionId: "fork-checkpoint",
    });

  it("keeps a built-in provider bound and active in the child", async () => {
    const { store, response, body } = await fork("builtin", true);
    expect(response.status).toBe(201);
    const child = (await store.getSession(body.sessionId))!;
    expect(child.activePlugins).toEqual([PROVIDER]);
    expect(child.metadata?._dimensionProviderPluginId).toBe(PROVIDER);
    await expect(exportChild(store, body.sessionId)).resolves.toBeDefined();
  });

  it("refuses to fork dimension data whose provider needs the player's approval", async () => {
    const { store, response, body } = await fork("community", true);
    expect(response.status).toBe(409);
    expect(body).toMatchObject({ code: "dimension_provider_required" });
    // No child the session view, snapshots and checkpoints would reject.
    expect((await store.listSessions()).map((session) => session.id)).toEqual([
      "parent-session",
    ]);
  });

  it("starts the child unbound when the provider holds no dimension data", async () => {
    const { store, response, body } = await fork("community", false);
    expect(response.status).toBe(201);
    const child = (await store.getSession(body.sessionId))!;
    expect(child.activePlugins).toEqual([]);
    expect(child.metadata?._dimensionProviderPluginId).toBeUndefined();
    await expect(exportChild(store, body.sessionId)).resolves.toBeDefined();
  });
});
