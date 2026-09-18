import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import {
  createMemoryStore,
  createSqliteStore,
  type DataStore,
  type SessionRecord,
} from "@covel/store";
import {
  RuntimeJobQueueFullError,
  claimNextRuntimeJob,
  claimRuntimeJob,
  createRuntimeJob,
  getRuntimeJob,
  recoverExpiredRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  createRuntimeJobWorker,
  makeRuntimeJobStatusRecord,
  type RuntimeJobExecutionControl,
} from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";

const ENQUEUED_AT = "2026-09-03T00:00:00.000Z";

function session(id: string): SessionRecord {
  return {
    id,
    worldId: "world",
    status: "active",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: ["mimo-tts"],
    metadata: {},
    createdAt: ENQUEUED_AT,
    updatedAt: ENQUEUED_AT,
  };
}

function job(
  sessionId = "session-a",
  jobId = "job-a",
  overrides: Partial<Parameters<typeof createRuntimeJob>[1]> = {},
): Parameters<typeof createRuntimeJob>[1] {
  return {
    jobId,
    sessionId,
    pluginId: "mimo-tts",
    runtimeId: "mimo-tts/auto-narrate",
    origin: {
      activation: "stage",
      sourceTurnId: "source-turn",
      sourceExecutionId: "source-execution",
    },
    payload: { inputs: [{ id: "narrative", value: "hello" }] },
    enqueuedAt: ENQUEUED_AT,
    ...overrides,
  };
}

describe.each([
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("durable runtime jobs (%s)", (_name, createStore) => {
  let store: DataStore;

  beforeEach(async () => {
    store = createStore();
    await store.createSession(session("session-a"));
    await store.createSession(session("session-b"));
  });

  afterEach(async () => {
    await store.close();
  });

  it("persists the immutable execution snapshot and enforces idempotent identity", async () => {
    const created = await createRuntimeJob(
      store,
      job("session-a", "job-a", { maxExecutionMs: 90_000 }),
    );
    expect(created).toMatchObject({
      status: "queued",
      attempt: 0,
      maxExecutionMs: 90_000,
      origin: { sourceTurnId: "source-turn" },
      payload: { inputs: [{ value: "hello" }] },
    });

    const duplicate = await createRuntimeJob(
      store,
      job("session-a", "job-a", { payload: { inputs: ["different"] } }),
    );
    expect(duplicate).toEqual(created);
  });

  it("runs the durable lifecycle through the commit barrier and publishes status", async () => {
    const created = await createRuntimeJob(store, job());
    await store.appendJobStatus(makeRuntimeJobStatusRecord(created, 0));
    const eventBus = createEventBus(store);
    const events: string[] = [];
    eventBus.onEmit((event) => events.push(event.type));
    const execute = vi.fn(async (_job, control) => {
      await control.beforeCommit({
        backgroundTurnId: "background-turn",
        backgroundExecutionId: "background-execution",
      });
      return { result: { ok: true } };
    });
    const worker = createRuntimeJobWorker({ store, eventBus, execute });

    worker.wake();
    await vi.waitFor(async () => {
      await expect(
        getRuntimeJob(store, {
          sessionId: "session-a",
          pluginId: "mimo-tts",
          jobId: "job-a",
        }),
      ).resolves.toMatchObject({
        status: "succeeded",
        backgroundTurnId: "background-turn",
        backgroundExecutionId: "background-execution",
        result: { ok: true },
      });
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(
      (await store.listJobStatus("session-a", { jobId: "job-a" })).map(
        (record) => record.state,
      ),
    ).toEqual(["queued", "running", "running", "progress", "succeeded"]);
    expect(events).toContain("job-status.updated");
    worker.close();
  });

  it("times out without allowing a late execution to commit", async () => {
    await createRuntimeJob(
      store,
      job("session-a", "slow-job", { maxExecutionMs: 10 }),
    );
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = vi.fn();
    const eventBus = createEventBus(store);
    const worker = createRuntimeJobWorker({
      store,
      eventBus,
      execute: async (_runtimeJob, control) => {
        await blocked;
        await control.beforeCommit({
          backgroundTurnId: "late-turn",
          backgroundExecutionId: "late-execution",
        });
        committed();
        return {};
      },
    });

    worker.wake();
    await vi.waitFor(async () => {
      await expect(
        getRuntimeJob(store, {
          sessionId: "session-a",
          pluginId: "mimo-tts",
          jobId: "slow-job",
        }),
      ).resolves.toMatchObject({
        status: "timed_out",
        reason: "execution-deadline-exceeded",
      });
    });
    release?.();
    await vi.waitFor(() => expect(worker.activeCount).toBe(0));
    expect(committed).not.toHaveBeenCalled();
    worker.close();
  });

  it("cancels uncommitted work on close and waits for the runner to release resources", async () => {
    await createRuntimeJob(store, job());
    await createRuntimeJob(store, job("session-a", "queued-after-close"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let control!: RuntimeJobExecutionControl;
    const execute = vi.fn(async (_job, next: RuntimeJobExecutionControl) => {
      control = next;
      await blocked;
      await control.assertCurrent();
      return {};
    });
    const eventBus = createEventBus(store);
    const worker = createRuntimeJobWorker({
      store,
      eventBus,
      execute,
      concurrency: 1,
    });
    worker.wake();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());

    const closing = worker.close();
    expect(worker.close()).toBe(closing);
    expect(control.signal.aborted).toBe(true);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(worker.activeCount).toBe(0));
    expect(closed).toBe(false);
    release();
    await closing;
    worker.wake();
    expect(execute).toHaveBeenCalledOnce();
    await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
      status: "cancelled",
      reason: "worker-shutdown",
    });
    await expect(
      getRuntimeJob(store, job("session-a", "queued-after-close")),
    ).resolves.toMatchObject({ status: "queued" });
    const read = vi.spyOn(store, "getPluginData");
    await expect(control.assertCurrent()).rejects.toThrow("shutting down");
    await expect(
      control.beforeCommit({
        backgroundTurnId: "late",
        backgroundExecutionId: "late",
      }),
    ).rejects.toThrow("shutting down");
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
    await eventBus.close();
  });

  it("lets a job already inside the commit barrier finish before close resolves", async () => {
    await createRuntimeJob(store, job());
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(),
      execute: async (_job, control) => {
        await control.beforeCommit({
          backgroundTurnId: "commit-turn",
          backgroundExecutionId: "commit-execution",
        });
        signal = control.signal;
        await blocked;
        return { result: "committed" };
      },
    });
    worker.wake();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const closing = worker.close();
    expect(signal!.aborted).toBe(false);
    expect(worker.activeCount).toBe(1);
    release();
    await closing;
    await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
      status: "succeeded",
      result: "committed",
    });
    expect(worker.activeCount).toBe(0);
  });

  it("releases the concurrency slot when claimed-job progress persistence fails", async () => {
    await createRuntimeJob(store, job());
    await createRuntimeJob(store, job("session-a", "job-b"));
    const append = vi
      .spyOn(store, "appendJobStatus")
      .mockRejectedValueOnce(new Error("temporary progress write failure"));
    const execute = vi.fn(async (_job, control: RuntimeJobExecutionControl) => {
      await control.beforeCommit({
        backgroundTurnId: "turn-b",
        backgroundExecutionId: "execution-b",
      });
      return {};
    });
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(),
      execute,
      concurrency: 1,
    });
    worker.wake();
    await vi.waitFor(async () => {
      await expect(
        getRuntimeJob(store, job("session-a", "job-b")),
      ).resolves.toMatchObject({ status: "succeeded" });
    });
    await worker.close();
    expect(execute).toHaveBeenCalledOnce();
    expect(worker.activeCount).toBe(0);
    await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
      status: "failed",
    });
    append.mockRestore();
  });

  it("publishes a terminal status when queued work expires before claim", async () => {
    await createRuntimeJob(
      store,
      job("session-a", "expired-before-claim", { maxQueueMs: 1 }),
    );
    const execute = vi.fn();
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(store),
      execute,
    });

    worker.wake();
    await vi.waitFor(async () => {
      const rows = await store.listJobStatus("session-a", {
        jobId: "expired-before-claim",
      });
      expect(rows.at(-1)).toMatchObject({
        state: "failed",
        data: { durableStatus: "timed_out" },
      });
    });
    expect(execute).not.toHaveBeenCalled();
    worker.close();
  });

  it("does not overlap detached jobs for the same session runtime", async () => {
    await createRuntimeJob(store, job("session-a", "serial-a"));
    await createRuntimeJob(store, job("session-a", "serial-b"));
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: string[] = [];
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(store),
      concurrency: 2,
      execute: async (runtimeJob, control) => {
        started.push(runtimeJob.jobId);
        if (runtimeJob.jobId === "serial-a") await firstBlocked;
        await control.beforeCommit({
          backgroundTurnId: `${runtimeJob.jobId}-turn`,
          backgroundExecutionId: `${runtimeJob.jobId}-execution`,
        });
        return {};
      },
    });

    worker.wake();
    await vi.waitFor(() => expect(started).toEqual(["serial-a"]));
    releaseFirst?.();
    await vi.waitFor(() => expect(started).toEqual(["serial-a", "serial-b"]));
    await vi.waitFor(() => expect(worker.activeCount).toBe(0));
    worker.close();
  });

  it("allows only one concurrent worker to claim a queued job", async () => {
    await createRuntimeJob(store, job());
    const claims = await Promise.all([
      claimRuntimeJob(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "job-a",
        ownerId: "worker-a",
        leaseMs: 30_000,
        now: "2026-09-03T00:00:01.000Z",
      }),
      claimRuntimeJob(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "job-a",
        ownerId: "worker-b",
        leaseMs: 30_000,
        now: "2026-09-03T00:00:01.000Z",
      }),
    ]);

    expect(claims.filter(Boolean)).toHaveLength(1);
    const stored = await getRuntimeJob(store, {
      sessionId: "session-a",
      pluginId: "mimo-tts",
      jobId: "job-a",
    });
    expect(stored).toMatchObject({ status: "claimed", attempt: 1 });
    expect(["worker-a", "worker-b"]).toContain(stored?.ownerId);
  });

  it("serializes repeated wakes while a claim is pending and cancels that claim on close", async () => {
    await createRuntimeJob(store, job());
    const sessions = await store.listSessions();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi
      .spyOn(store, "listSessions")
      .mockImplementationOnce(async () => {
        await blocked;
        return sessions;
      });
    const execute = vi.fn();
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(),
      execute,
      concurrency: 1,
    });
    worker.wake();
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    worker.wake();
    worker.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledOnce();
    const closing = worker.close();
    release();
    await closing;
    expect(execute).not.toHaveBeenCalled();
    expect(worker.activeCount).toBe(0);
    await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
      status: "cancelled",
      reason: "worker-shutdown",
    });
    list.mockRestore();
  });

  it("renews leases and rejects transitions from another owner", async () => {
    await createRuntimeJob(store, job());
    await claimRuntimeJob(store, {
      sessionId: "session-a",
      pluginId: "mimo-tts",
      jobId: "job-a",
      ownerId: "worker-a",
      leaseMs: 1_000,
      now: "2026-09-03T00:00:01.000Z",
    });

    await expect(
      renewRuntimeJobLease(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "job-a",
        ownerId: "worker-a",
        leaseMs: 10_000,
        now: "2026-09-03T00:00:01.500Z",
      }),
    ).resolves.toMatchObject({
      leaseExpiresAt: "2026-09-03T00:00:11.500Z",
    });
    await expect(
      transitionRuntimeJob(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "job-a",
        ownerId: "worker-b",
        from: ["claimed"],
        to: "running",
      }),
    ).resolves.toBeNull();
  });

  it("terminalises queue deadlines and expired leases without replay", async () => {
    await createRuntimeJob(
      store,
      job("session-a", "queued-expired", { maxQueueMs: 1_000 }),
    );
    await createRuntimeJob(store, job("session-a", "lease-expired"));
    await claimRuntimeJob(store, {
      sessionId: "session-a",
      pluginId: "mimo-tts",
      jobId: "lease-expired",
      ownerId: "dead-worker",
      leaseMs: 1_000,
      now: ENQUEUED_AT,
    });

    await expect(
      recoverExpiredRuntimeJobs(store, {
        now: "2026-09-03T00:00:02.000Z",
      }),
    ).resolves.toEqual({ timedOut: 1, orphaned: 1 });
    await expect(
      getRuntimeJob(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "queued-expired",
      }),
    ).resolves.toMatchObject({ status: "timed_out" });
    await expect(
      getRuntimeJob(store, {
        sessionId: "session-a",
        pluginId: "mimo-tts",
        jobId: "lease-expired",
      }),
    ).resolves.toMatchObject({ status: "orphaned", attempt: 1 });
  });

  it("bounds queued work per session and rotates claims across sessions", async () => {
    await createRuntimeJob(
      store,
      job("session-a", "a-1", { maxQueuedPerSession: 1 }),
    );
    await expect(
      createRuntimeJob(
        store,
        job("session-a", "a-2", { maxQueuedPerSession: 1 }),
      ),
    ).rejects.toBeInstanceOf(RuntimeJobQueueFullError);
    await createRuntimeJob(store, job("session-b", "b-1"));

    const first = await claimNextRuntimeJob(store, {
      ownerId: "worker",
      leaseMs: 30_000,
    });
    expect(first?.job.sessionId).toBe("session-a");
    const second = await claimNextRuntimeJob(store, {
      ownerId: "worker",
      leaseMs: 30_000,
      afterSessionId: first?.nextSessionCursor,
    });
    expect(second?.job.sessionId).toBe("session-b");
  });
});
