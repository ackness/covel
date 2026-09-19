import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
} from "@covel/store";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  claimRuntimeJob,
  createRuntimeJob,
  getRuntimeJob,
  recoverExpiredRuntimeJobs,
  transitionRuntimeJob,
  type RuntimeJobStatus,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  createRuntimeJobWorker,
  type RuntimeJobWorker,
} from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";

const SESSION_ID = "continuous-session";
const key = (jobId = "dead-job") => ({
  sessionId: SESSION_ID,
  pluginId: "probe",
  jobId,
});

describe.each([
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("continuous runtime job recovery (%s)", (_backend, createStore) => {
  let store: DataStore;
  let events: ReturnType<typeof createEventBus>;
  let lock: ReturnType<typeof createInProcessSessionLock>;
  let workers: RuntimeJobWorker[];
  let releaseGates: Array<() => void>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    store = createStore();
    events = createEventBus();
    lock = createInProcessSessionLock();
    workers = [];
    releaseGates = [];
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      status: "active",
      locale: "en-US",
      phase: "playing",
      completedPlayerTurns: 0,
      setupRuntimes: {},
      activePlugins: [],
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(async () => {
    const closing = workers.map((worker) => worker.close());
    for (const release of releaseGates) release();
    await Promise.all(closing);
    await events.close();
    await store.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function start(
    overrides: Partial<Parameters<typeof createRuntimeJobWorker>[0]> = {},
  ) {
    const worker = createRuntimeJobWorker({
      store,
      eventBus: events,
      tryWithCommitLock: lock.tryWithLock.bind(lock),
      execute: vi.fn(async () => {}),
      ...overrides,
    });
    workers.push(worker);
    worker.wake();
    return worker;
  }

  async function seed(
    status: RuntimeJobStatus = "claimed",
    jobId = "dead-job",
  ) {
    await createRuntimeJob(store, {
      ...key(jobId),
      runtimeId: `probe/${jobId}`,
      origin: { activation: "stage", sourceTurnId: "source" },
      payload: {},
    });
    if (status === "queued") return;
    await claimRuntimeJob(store, {
      ...key(jobId),
      ownerId: "dead-owner",
      leaseMs: 1_000,
    });
    if (status === "claimed") return;
    await transitionRuntimeJob(store, {
      ...key(jobId),
      from: ["claimed"],
      to: "running",
      ownerId: "dead-owner",
    });
    if (status === "running") return;
    await transitionRuntimeJob(store, {
      ...key(jobId),
      from: ["running"],
      to: "committing",
      ownerId: "dead-owner",
    });
  }

  it.each(["claimed", "running", "committing"] as const)(
    "terminalizes a dead %s owner whose lease expires after startup without replay",
    async (status) => {
      await seed(status);
      await expect(
        recoverExpiredRuntimeJobs(store, {
          tryWithCommitLock: lock.tryWithLock.bind(lock),
        }),
      ).resolves.toEqual({ timedOut: 0, orphaned: 0 });
      const execute = vi.fn(async () => {});
      start({ execute });
      await vi.advanceTimersByTimeAsync(1);
      await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
        status,
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
        status: "orphaned",
        attempt: 1,
      });
      expect(
        (await store.listJobStatus(SESSION_ID, { jobId: "dead-job" })).at(-1),
      ).toMatchObject({
        state: "failed",
        data: { durableStatus: "orphaned" },
      });
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("skips a live committing lock and observes its later atomic success", async () => {
    await seed("committing");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releaseGates.push(() => release.resolve());
    const owner = lock.withLock(SESSION_ID, async () => {
      entered.resolve();
      await release.promise;
      await store.withTransaction(async (tx) => {
        await transitionRuntimeJob(tx, {
          ...key(),
          from: ["committing"],
          to: "succeeded",
          ownerId: "dead-owner",
        });
      });
    });
    await entered.promise;
    start();
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
      status: "committing",
    });
    release.resolve();
    await owner;
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(
      (await store.listJobStatus(SESSION_ID, { jobId: "dead-job" })).at(-1)
        ?.state,
    ).toBe("succeeded");
  });

  it("does not repeat recovery for ordinary wakes before the next deadline", async () => {
    await seed("committing");
    vi.setSystemTime(new Date("2030-01-01T00:00:02.000Z"));
    const probe = vi.fn(async () => ({ acquired: false as const }));
    const worker = start({ tryWithCommitLock: probe });
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledOnce();
    for (let index = 0; index < 3; index++) {
      worker.wake();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("recovers and publishes expired work even while every execution slot is occupied", async () => {
    await seed("running");
    await seed("queued", "live-job");
    const release = Promise.withResolvers<void>();
    releaseGates.push(() => release.resolve());
    const execute = vi.fn(async (_job, control) => {
      await release.promise;
      await control.assertCurrent();
    });
    const worker = start({ execute, concurrency: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(worker.activeCount).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
      status: "orphaned",
    });
    expect(
      (await store.listJobStatus(SESSION_ID, { jobId: "dead-job" })).at(-1)
        ?.state,
    ).toBe("failed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("waits for an in-flight scan on close and never schedules another one", async () => {
    await seed();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releaseGates.push(() => release.resolve());
    const list = store.listPluginDataSessionScope.bind(store);
    const read = vi
      .spyOn(store, "listPluginDataSessionScope")
      .mockImplementationOnce(async (sessionId) => {
        entered.resolve();
        await release.promise;
        return list(sessionId);
      });
    const worker = start();
    await vi.advanceTimersByTimeAsync(1);
    await entered.promise;
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    const calls = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(calls);
  });

  it("keeps an acquired recovery lock owned until close drains its callback", async () => {
    await seed("committing");
    vi.setSystemTime(new Date("2030-01-01T00:00:02.000Z"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    releaseGates.push(() => release.resolve());
    let probes = 0;
    const tryWithCommitLock: Parameters<
      typeof createRuntimeJobWorker
    >[0]["tryWithCommitLock"] = (sessionId, run) =>
      lock.tryWithLock(sessionId, async () => {
        probes++;
        entered.resolve();
        await release.promise;
        return run();
      });
    const worker = start({ tryWithCommitLock });
    await vi.advanceTimersByTimeAsync(1);
    await entered.promise;
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await expect(lock.tryWithLock(SESSION_ID, async () => {})).resolves.toEqual(
      { acquired: false },
    );
    release.resolve();
    await closing;
    await expect(
      lock.tryWithLock(SESSION_ID, async () => {}),
    ).resolves.toMatchObject({ acquired: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(probes).toBe(1);
  });

  it("retries a failed scan with sanitized diagnostics", async () => {
    await seed();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "listPluginDataSessionScope").mockRejectedValueOnce(
      new Error("synthetic-secret-in-store-error"),
    );
    start();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(
      "synthetic-secret-in-store-error",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(getRuntimeJob(store, key())).resolves.toMatchObject({
      status: "orphaned",
    });
  });
});
