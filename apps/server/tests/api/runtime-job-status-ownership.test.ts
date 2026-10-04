/**
 * A job-status row belongs to the session incarnation that admitted its job.
 * The worker's reconciliation reads terminal jobs outside every lock, so a
 * session deleted (or re-created under the same id) in between must not
 * receive the old job's status.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { EventBus } from "@covel/events";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { registerSessionDeleteRoute } from "../../src/routes/api/session/delete-route.js";
import {
  createRuntimeJob,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import { createRuntimeJobWorker } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";

const SESSION_ID = "owned-session";
const at = "2026-10-04T00:00:00.000Z";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

const session = (nonce: string, status: "active" | "ended") => ({
  id: SESSION_ID,
  status,
  phase: "playing" as const,
  locale: "en-US",
  completedPlayerTurns: 1,
  setupRuntimes: {},
  activePlugins: ["probe"],
  metadata: { sessionIncarnationNonce: nonce },
  createdAt: at,
  updatedAt: at,
});

describe.each([
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("runtime job status ownership (%s)", (_backend, createStore) => {
  let store: DataStore;
  afterEach(async () => {
    await store.close();
  });

  /**
   * A failed job with no status row yet — what a crash between the durable
   * transition and its projection leaves behind. `between` runs after the
   * worker has read the job and before it writes the projection.
   */
  async function reconcile(
    between: (
      app: Hono,
      lock: ReturnType<typeof createInProcessSessionLock>,
    ) => Promise<void>,
  ) {
    store = createStore();
    await store.createSession(session("old", "ended"));
    const job = await createRuntimeJob(store, {
      jobId: "old-job",
      sessionId: SESSION_ID,
      pluginId: "probe",
      runtimeId: "probe/background",
      origin: { activation: "stage", sourceTurnId: "source-turn" },
      payload: {
        schemaVersion: 1,
        activation: "manual",
        turnId: "source-turn",
        expectedSessionIncarnation: "incarnation:old",
        expectedApprovalScope: "scope",
        locale: "en-US",
      },
      enqueuedAt: at,
    });
    await transitionRuntimeJob(store, {
      ...job,
      from: ["queued"],
      to: "failed",
      error: "old failure",
    });

    const reached = gate();
    const release = gate();
    const listJobStatus = store.listJobStatus.bind(store);
    let held = false;
    store.listJobStatus = async (...args) => {
      if (!held) {
        held = true;
        reached.open();
        await release.opened;
      }
      return listJobStatus(...args);
    };
    const lock = createInProcessSessionLock();
    const events: unknown[] = [];
    const worker = createRuntimeJobWorker({
      store,
      eventBus: { emit: (event: unknown) => events.push(event) } as EventBus,
      tryWithCommitLock: lock.tryWithLock.bind(lock),
      execute: async () => {
        throw new Error("No execution expected");
      },
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as never);
      c.set("sessionLock" as never, lock as never);
      c.set(
        "pluginRegistry" as never,
        {
          applyPersistedActivations: async (
            _id: string,
            _plugins: string[],
            persist: () => Promise<void>,
          ) => persist(),
        } as never,
      );
      await next();
    });
    const routes = new Hono();
    registerSessionDeleteRoute(routes as never);
    app.route("/api/sessions", routes);

    worker.wake();
    await reached.opened;
    await between(app, lock);
    release.open();
    await worker.close();
    return { rows: await listJobStatus(SESSION_ID), events };
  }

  const deleteSession = async (app: Hono) =>
    expect(
      (await app.request(`/api/sessions/${SESSION_ID}`, { method: "DELETE" }))
        .status,
    ).toBe(200);

  it("projects a terminal job that is still owned by its session", async () => {
    const { rows, events } = await reconcile(async () => {});
    expect(rows.map((row) => [row.jobId, row.state])).toEqual([
      ["old-job", "failed"],
    ]);
    expect(events).toHaveLength(1);
  });

  it("writes nothing for a session deleted while the job was being read", async () => {
    const { rows, events } = await reconcile((app) => deleteSession(app));
    expect(await store.getSession(SESSION_ID)).toBeNull();
    expect(rows).toEqual([]);
    expect(events).toEqual([]);
  });

  it("writes nothing into a session re-created under the same id", async () => {
    const { rows, events } = await reconcile(async (app, lock) => {
      await deleteSession(app);
      await lock.withLock(SESSION_ID, () =>
        store.createSession(session("new", "active")),
      );
    });
    expect(
      (await store.getSession(SESSION_ID))?.metadata?.sessionIncarnationNonce,
    ).toBe("new");
    expect(rows).toEqual([]);
    expect(events).toEqual([]);
  });

  /**
   * A queued job the worker claims. Its first projection is written before
   * any runtime or session lock is taken; the hold sits inside that
   * projection, after its ownership check and before its write.
   */
  async function claim(
    afterDelete: (
      lock: ReturnType<typeof createInProcessSessionLock>,
    ) => Promise<void>,
  ) {
    store = createStore();
    await store.createSession(session("old", "active"));
    await createRuntimeJob(store, {
      jobId: "old-job",
      sessionId: SESSION_ID,
      pluginId: "probe",
      runtimeId: "probe/background",
      origin: { activation: "stage", sourceTurnId: "source-turn" },
      payload: {
        schemaVersion: 1,
        activation: "manual",
        turnId: "source-turn",
        expectedSessionIncarnation: "incarnation:old",
        expectedApprovalScope: "scope",
        locale: "en-US",
      },
      enqueuedAt: at,
    });

    const reached = gate();
    const release = gate();
    const withTransaction = store.withTransaction.bind(store);
    let held = false;
    store.withTransaction = (fn) =>
      withTransaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, property) {
              const value = Reflect.get(target, property, target);
              if (property !== "listJobStatus" || held) return value;
              return async (...args: Parameters<typeof tx.listJobStatus>) => {
                held = true;
                reached.open();
                await release.opened;
                return target.listJobStatus(...args);
              };
            },
          }),
        ),
      );
    const lock = createInProcessSessionLock();
    const events: unknown[] = [];
    const worker = createRuntimeJobWorker({
      store,
      eventBus: { emit: (event: unknown) => events.push(event) } as EventBus,
      tryWithCommitLock: lock.tryWithLock.bind(lock),
      execute: async () => {},
    });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store" as never, store as never);
      c.set("sessionLock" as never, lock as never);
      c.set(
        "pluginRegistry" as never,
        {
          get: () => undefined,
          applyPersistedActivations: async (
            _id: string,
            _plugins: string[],
            persist: () => Promise<void>,
          ) => persist(),
        } as never,
      );
      await next();
    });
    const routes = new Hono();
    registerSessionDeleteRoute(routes as never);
    app.route("/api/sessions", routes);

    worker.wake();
    await reached.opened;
    // The delete cannot overtake the projection it raced with: it waits for
    // that transaction, then removes whatever the transaction wrote.
    const deleting = app.request(`/api/sessions/${SESSION_ID}`, {
      method: "DELETE",
    });
    release.open();
    expect((await deleting).status).toBe(200);
    const eventsAtDelete = events.length;
    await afterDelete(lock);
    await worker.close();
    return {
      rows: await store.listJobStatus(SESSION_ID),
      lateEvents: events.length - eventsAtDelete,
    };
  }

  it("leaves no claimed status behind when the session is deleted during the claim", async () => {
    const { rows, lateEvents } = await claim(async () => {});
    expect(await store.getSession(SESSION_ID)).toBeNull();
    expect(rows).toEqual([]);
    expect(lateEvents).toBe(0);
  });

  it("writes no claimed status into a session re-created during the claim", async () => {
    const { rows, lateEvents } = await claim((lock) =>
      lock.withLock(SESSION_ID, () =>
        store.createSession(session("new", "active")),
      ),
    );
    expect(
      (await store.getSession(SESSION_ID))?.metadata?.sessionIncarnationNonce,
    ).toBe("new");
    expect(rows).toEqual([]);
    expect(lateEvents).toBe(0);
  });
});
