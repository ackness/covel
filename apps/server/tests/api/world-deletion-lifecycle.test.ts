import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createHookPipeline } from "@covel/runtime";
import {
  createMemoryMediaStore,
  createMemoryStore,
  createSqliteStore,
  exportSessionCheckpoint,
  type DataStore,
} from "@covel/store";
import {
  makeMessage,
  makeSession,
  makeSnapshot,
  makeWorld,
} from "../../../../packages/store/src/contract/test-fixtures.js";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionRoutes } from "../../src/routes/api/session.js";
import { worldRoutes } from "../../src/routes/api/worlds.js";
import { snapshotRoutes } from "../../src/routes/api/snapshots.js";
import { createBrowserWorkspaceRoutes } from "../../src/routes/api/browser-workspace.js";
import {
  isWorldDeleting,
  readWorldDeletion,
} from "../../src/world-lifecycle.js";

describe.each(["memory", "sqlite"])(
  "world deletion lifecycle on %s",
  (backend) => {
    let store: DataStore;
    let app: Hono;
    let hookPipeline: ReturnType<typeof createHookPipeline>;
    let mediaStore: ReturnType<typeof createMemoryMediaStore>;
    let clearBrowserWorkspace: ReturnType<typeof vi.fn>;
    let sessionLock: ReturnType<typeof createInProcessSessionLock>;

    beforeEach(async () => {
      store =
        backend === "sqlite"
          ? createSqliteStore(":memory:")
          : createMemoryStore();
      const registry = createPluginRegistry();
      const eventBus = createEventBus();
      sessionLock = createInProcessSessionLock();
      hookPipeline = createHookPipeline();
      mediaStore = createMemoryMediaStore();
      clearBrowserWorkspace = vi.fn();
      app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("storeBackend", backend === "sqlite" ? "sqlite" : "memory");
        c.set("pluginRegistry", registry);
        c.set("eventBus", eventBus);
        c.set("sessionLock", sessionLock);
        c.set("hookPipeline", hookPipeline);
        c.set("mediaStore", mediaStore);
        c.set("clearBrowserWorkspace", clearBrowserWorkspace);
        await next();
      });
      app.route("/api/worlds", worldRoutes);
      app.route("/api/sessions", sessionRoutes);
      app.route("/api/sessions", snapshotRoutes);
      app.route("/api/sessions", createBrowserWorkspaceRoutes());
      await store.upsertWorld(makeWorld({ id: "alpha" }));
      await store.upsertWorld(makeWorld({ id: "beta" }));
      for (const id of ["alpha-one", "alpha-two", "beta-one"]) {
        await store.createSession(
          makeSession({
            id,
            worldId: id.split("-")[0],
            metadata: { sessionIncarnationNonce: crypto.randomUUID() },
          }),
        );
        await store.addMessage(
          makeMessage({ id: `${id}-message`, sessionId: id }),
        );
      }
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      await store.close();
    });

    it("deletes every owned session through lifecycle cleanup and preserves other worlds", async () => {
      const end = vi.fn().mockResolvedValue({ action: "continue" });
      hookPipeline.register({
        id: "observe-deletion",
        event: "SessionEnd",
        handler: end,
      });
      const release = vi.spyOn(mediaStore, "releaseSession");
      const response = await app.request("/api/worlds/alpha", {
        method: "DELETE",
      });
      expect(response.status).toBe(200);
      expect(await store.getWorld("alpha")).toBeNull();
      for (const id of ["alpha-one", "alpha-two"]) {
        expect(await store.getSession(id)).toBeNull();
        expect(await store.listMessages(id)).toEqual([]);
        expect(release).toHaveBeenCalledWith(id);
        expect(clearBrowserWorkspace).toHaveBeenCalledWith(id);
      }
      expect(end.mock.calls.map((call) => call[1].sessionId).sort()).toEqual([
        "alpha-one",
        "alpha-two",
      ]);
      expect(await store.getWorld("beta")).not.toBeNull();
      expect(await store.getSession("beta-one")).not.toBeNull();
      expect(await store.listMessages("beta-one")).toHaveLength(1);
    });

    it("rejects session creation against a missing world", async () => {
      const response = await app.request("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "orphan", worldId: "missing", plugins: [] }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "world_not_found" });
      expect(await store.getSession("orphan")).toBeNull();
    });

    function requestJson(url: string, method: string, body: unknown) {
      return app.request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("blocks world writes, creation, fork and checkpoint moves while hooks run without holding the world lock", async () => {
      const snapshots = new Map<string, string>();
      for (const id of ["alpha-one", "alpha-two"]) {
        const snapshot = makeSnapshot({ sessionId: id });
        await store.saveSnapshot(snapshot);
        snapshots.set(id, snapshot.id);
      }
      const entered = Promise.withResolvers<string>();
      const release = Promise.withResolvers<void>();
      let first = true;
      hookPipeline.register({
        id: "wait-once",
        event: "SessionEnd",
        async handler(context) {
          if (first) {
            first = false;
            entered.resolve(context.sessionId);
            await release.promise;
          }
          return { action: "continue" };
        },
      });
      const pending = app.request("/api/worlds/alpha", { method: "DELETE" });
      try {
        const deleting = await entered.promise;
        const other = deleting === "alpha-one" ? "alpha-two" : "alpha-one";
        const requests: [string, string, unknown][] = [
          [
            "/api/worlds/alpha",
            "PATCH",
            { name: "Late edit", metadata: { worldDeletion: null } },
          ],
          ["/api/worlds/alpha/dimensions/import", "POST", { dimensions: {} }],
          [
            "/api/sessions",
            "POST",
            { id: "late-session", worldId: "alpha", plugins: [] },
          ],
          [
            `/api/sessions/${other}/fork`,
            "POST",
            { fromSnapshotId: snapshots.get(other) },
          ],
        ];
        if (backend === "memory") {
          const checkpoint = await exportSessionCheckpoint(store, other, {
            revision: 1,
            actionId: "move-away",
          });
          requests.push([
            `/api/sessions/${other}/browser-checkpoint`,
            "PUT",
            {
              checkpoint: {
                ...checkpoint,
                session: { ...checkpoint.session, worldId: "beta" },
                world: await store.getWorld("beta"),
              },
            },
          ]);
        }
        for (const [url, method, body] of requests) {
          const response = await requestJson(url, method, body);
          expect([url, response.status]).toEqual([url, 409]);
          expect(await response.json()).toMatchObject({
            code: "world_deleting",
          });
        }
        expect(
          (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
        ).toBe(409);
        expect(
          (
            await requestJson("/api/worlds/beta", "PATCH", {
              name: "Independent edit",
            })
          ).status,
        ).toBe(200);
        expect(await store.getSession("late-session")).toBeNull();
        expect((await store.getSession(other))?.worldId).toBe("alpha");
      } finally {
        release.resolve();
        expect((await pending).status).toBe(200);
      }
    });

    it("marks the world before waiting for an active session writer and deletes that writer's final data", async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const marked = Promise.withResolvers<void>();
      const upsert = store.upsertWorld.bind(store);
      vi.spyOn(store, "upsertWorld").mockImplementation(async (world) => {
        await upsert(world);
        if (isWorldDeleting(world)) marked.resolve();
      });
      const writer = sessionLock.withLock("alpha-one", async () => {
        entered.resolve();
        await release.promise;
        await store.addMessage(
          makeMessage({ sessionId: "alpha-one", id: "final-write" }),
        );
      });
      await entered.promise;
      const pending = app.request("/api/worlds/alpha", { method: "DELETE" });
      try {
        await marked.promise;
        expect(await store.getSession("alpha-one")).not.toBeNull();
        expect(
          (await requestJson("/api/worlds/alpha", "PATCH", { name: "Late" }))
            .status,
        ).toBe(409);
      } finally {
        release.resolve();
        await writer;
        expect((await pending).status).toBe(200);
      }
      expect(await store.listMessages("alpha-one")).toEqual([]);
    });

    it("preserves a same-id session recreated in another world after enumeration", async () => {
      const list = store.listSessions.bind(store);
      vi.spyOn(store, "listSessions").mockImplementationOnce(async () => {
        const captured = await list();
        expect(
          (await app.request("/api/sessions/alpha-one", { method: "DELETE" }))
            .status,
        ).toBe(200);
        expect(
          (
            await requestJson("/api/sessions", "POST", {
              id: "alpha-one",
              worldId: "beta",
              plugins: [],
            })
          ).status,
        ).toBe(201);
        return captured;
      });

      const response = await app.request("/api/worlds/alpha", {
        method: "DELETE",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "session_incarnation_changed",
      });
      expect((await store.getSession("alpha-one"))?.worldId).toBe("beta");
      expect(
        readWorldDeletion((await store.getWorld("alpha"))!)?.retryable,
      ).toBe(true);
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(200);
      expect((await store.getSession("alpha-one"))?.worldId).toBe("beta");
      expect(await store.getWorld("alpha")).toBeNull();
    });

    it("keeps failed deletion retryable and does not repeat a completed SessionEnd hook", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const end = vi.fn().mockResolvedValue({ action: "continue" });
      hookPipeline.register({
        id: "retry-observer",
        event: "SessionEnd",
        handler: end,
      });
      vi.spyOn(store, "deleteSession").mockRejectedValueOnce(
        new Error("Synthetic delete failure"),
      );
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(500);
      expect(
        readWorldDeletion((await store.getWorld("alpha"))!)?.retryable,
      ).toBe(true);
      expect(end).toHaveBeenCalledOnce();
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(200);
      expect(end).toHaveBeenCalledTimes(2);
      expect(await store.getWorld("alpha")).toBeNull();
      expect(await store.getSession("alpha-one")).toBeNull();
      expect(await store.getSession("alpha-two")).toBeNull();
    });

    it("treats a lost world-delete acknowledgement after commit as success", async () => {
      const remove = store.deleteWorld.bind(store);
      vi.spyOn(store, "deleteWorld").mockImplementationOnce(async (id) => {
        await remove(id);
        throw new Error("Synthetic lost acknowledgement");
      });
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(200);
      expect(await store.getWorld("alpha")).toBeNull();
      expect(await store.getSession("alpha-one")).toBeNull();
    });

    it("makes a lost acknowledgement of the initial deletion marker retryable", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const upsert = store.upsertWorld.bind(store);
      vi.spyOn(store, "upsertWorld").mockImplementationOnce(async (world) => {
        await upsert(world);
        throw new Error("Synthetic lost marker acknowledgement");
      });
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(500);
      expect(
        readWorldDeletion((await store.getWorld("alpha"))!)?.retryable,
      ).toBe(true);
      expect(await store.getSession("alpha-one")).not.toBeNull();
      expect(
        (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
      ).toBe(200);
    });

    it.each(["expired", "malformed"])(
      "allows an authorized retry of a %s deletion marker",
      async (kind) => {
        const world = (await store.getWorld("alpha"))!;
        await store.upsertWorld({
          ...world,
          metadata: {
            ...world.metadata,
            worldDeletion:
              kind === "expired"
                ? {
                    nonce: "old-operation",
                    startedAt: "2020-01-01T00:00:00.000Z",
                  }
                : { nonce: "incomplete-operation" },
          },
        });
        expect(
          (await app.request("/api/worlds/alpha", { method: "DELETE" })).status,
        ).toBe(200);
        expect(await store.getSession("alpha-one")).toBeNull();
        expect(await store.getWorld("alpha")).toBeNull();
      },
    );

    it("rejects oversized hook settings before marking or deleting any data", async () => {
      const before = await store.getWorld("alpha");
      const response = await app.request("/api/worlds/alpha", {
        method: "DELETE",
        headers: { "X-Plugin-User-Settings": "x".repeat(9_000) },
      });
      expect(response.status).toBe(431);
      expect(await store.getWorld("alpha")).toEqual(before);
      expect(await store.getSession("alpha-one")).not.toBeNull();
    });

    it("does not accept deletion control from world CRUD or checkpoint metadata", async () => {
      const forged = { nonce: "forged", startedAt: new Date().toISOString() };
      for (const [url, method, body] of [
        [
          "/api/worlds",
          "POST",
          {
            id: "forged-world",
            name: "New",
            metadata: { worldDeletion: forged },
          },
        ],
        ["/api/worlds/alpha", "PATCH", { metadata: { worldDeletion: forged } }],
      ] as const) {
        expect((await requestJson(url, method, body)).ok).toBe(true);
      }
      if (backend === "memory") {
        const checkpoint = await exportSessionCheckpoint(store, "alpha-one", {
          revision: 1,
          actionId: "forged-control",
        });
        const response = await requestJson(
          "/api/sessions/alpha-one/browser-checkpoint",
          "PUT",
          {
            checkpoint: {
              ...checkpoint,
              world: {
                ...checkpoint.world,
                metadata: { worldDeletion: forged },
              },
            },
          },
        );
        expect(response.status).toBe(200);
      }
      expect(isWorldDeleting((await store.getWorld("alpha"))!)).toBe(false);
      expect(isWorldDeleting((await store.getWorld("forged-world"))!)).toBe(
        false,
      );
    });
  },
);
