import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@covel/events";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { type DataStore, type SessionRecord } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import {
  RuntimeJobQueueFullError,
  claimNextRuntimeJob,
  claimRuntimeJob,
  createRuntimeJob,
  getRuntimeJob,
  listRuntimeJobs,
  listSettlingRuntimeJobs,
  pruneTerminalRuntimeJobs,
  recoverExpiredRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  RuntimeJobNoLongerCurrentError,
  appendRuntimeJobStatus,
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
    locale: "en-US",
    phase: "playing",
    completedPlayerTurns: 1,
    setupRuntimes: {},
    activePlugins: ["mimo-tts"],
    metadata: {},
    createdAt: ENQUEUED_AT,
    updatedAt: ENQUEUED_AT,
  };
}

/**
 * Make the worker's status projection fail. The projection writes its row
 * inside a store transaction, so the failure is injected on that transaction.
 */
function failStatusProjection(
  store: DataStore,
  shouldFail: (row: Parameters<DataStore["appendJobStatus"]>[0]) => boolean,
) {
  const withTransaction = store.withTransaction.bind(store);
  return vi.spyOn(store, "withTransaction").mockImplementation((fn) =>
    withTransaction((tx) =>
      fn(
        new Proxy(tx, {
          get(target, property) {
            const value = Reflect.get(target, property, target);
            if (property !== "appendJobStatus") return value;
            return async (row: Parameters<DataStore["appendJobStatus"]>[0]) => {
              if (shouldFail(row))
                throw new Error("synthetic projection failure");
              return target.appendJobStatus(row);
            };
          },
        }),
      ),
    ),
  );
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

async function writeAtomicTrack(
  store: Pick<DataStore, "setPluginData">,
): Promise<void> {
  await store.setPluginData({
    id: "atomic-domain-row",
    sessionId: "session-a",
    pluginId: "mimo-tts",
    namespace: "tracks",
    key: "atomic",
    value: { generated: true },
    createdAt: ENQUEUED_AT,
    updatedAt: ENQUEUED_AT,
  });
}

describe.each([
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("durable runtime jobs (%s)", (_name, createStore) => {
  let store: DataStore;
  let tryWithCommitLock: ReturnType<
    typeof createInProcessSessionLock
  >["tryWithLock"];

  beforeEach(async () => {
    store = createStore();
    const lock = createInProcessSessionLock();
    tryWithCommitLock = lock.tryWithLock.bind(lock);
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
      await store.withTransaction((tx) =>
        control.completeInTx(tx, { ok: true }),
      );
    });
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus,
      execute,
    });

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

  it("claims only from the woken session between maintenance passes", async () => {
    const listSessions = vi.spyOn(store, "listSessions");
    const executed: string[] = [];
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus: createEventBus(store),
      execute: async (claimed, control) => {
        executed.push(claimed.jobId);
        await control.beforeCommit({
          backgroundTurnId: `turn-${claimed.jobId}`,
          backgroundExecutionId: `execution-${claimed.jobId}`,
        });
        await store.withTransaction((tx) => control.completeInTx(tx, {}));
      },
    });
    const status = (sessionId: string, jobId: string) =>
      getRuntimeJob(store, { sessionId, pluginId: "mimo-tts", jobId }).then(
        (found) => found?.status,
      );

    // Startup runs a maintenance pass that scans every session.
    worker.wake();
    await vi.waitFor(() => expect(listSessions).toHaveBeenCalledTimes(3));

    await createRuntimeJob(store, job("session-b", "b-1"));
    await createRuntimeJob(store, job("session-a", "a-1"));
    worker.wake("session-a");
    await vi.waitFor(async () =>
      expect(await status("session-a", "a-1")).toBe("succeeded"),
    );
    expect(await status("session-b", "b-1")).toBe("queued");
    expect(listSessions).toHaveBeenCalledTimes(3);

    // A wake without a session falls back to a full scan.
    worker.wake();
    await vi.waitFor(async () =>
      expect(await status("session-b", "b-1")).toBe("succeeded"),
    );
    expect(executed).toEqual(["a-1", "b-1"]);
    await worker.close();
  });

  it.each(["execution-failed", "SYNTHETIC_PRIVATE_REASON"])(
    "publishes safe SSE diagnostics for reason %s while preserving job identities",
    async (reason) => {
      await createRuntimeJob(store, job());
      const failure = new Error("Authorization: Bearer SYNTHETIC_NEVER_VALID");
      const failed = await transitionRuntimeJob(store, {
        ...job(),
        from: ["queued"],
        to: "failed",
        reason,
        error: failure.message,
      });
      const eventBus = createEventBus();
      try {
        expect(failed).not.toBeNull();
        await appendRuntimeJobStatus(store, eventBus, failed!);
        const events = eventBus.getEventsAfter("session-a", 0).events;
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "job-status.updated",
          sessionId: "session-a",
          payload: {
            sessionId: "session-a",
            progressScopeId: "job-a",
            pluginId: "mimo-tts",
            runtimeId: "mimo-tts/auto-narrate",
            jobId: "job-a",
            state: "failed",
            message: "Runtime job execution failed.",
            data: {
              originTurnId: "source-turn",
              durableStatus: "failed",
              error: "Runtime job execution failed.",
            },
          },
        });
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain(failure.message);
        expect(serialized).not.toContain("SYNTHETIC_PRIVATE_REASON");
        expect(events[0]!.payload.data).toEqual({
          originTurnId: "source-turn",
          durableStatus: "failed",
          error: "Runtime job execution failed.",
          ...(reason === "execution-failed" ? { reason } : {}),
        });
        expect(
          (await store.listJobStatus("session-a", { jobId: "job-a" }))[0],
        ).toEqual(events[0]!.payload);
        await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
          reason,
          error: failure.message,
        });
      } finally {
        await eventBus.close();
      }
    },
  );

  it("persists success with domain writes before the executor returns", async () => {
    await createRuntimeJob(store, job());
    const committed = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const eventBus = createEventBus();
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus,
      execute: async (_job, control) => {
        await control.beforeCommit({
          backgroundTurnId: "atomic-turn",
          backgroundExecutionId: "atomic-execution",
        });
        await store.withTransaction(async (tx) => {
          await writeAtomicTrack(tx);
          await control.completeInTx(tx, { generated: true });
        });
        committed.resolve();
        await finish.promise;
      },
    });
    try {
      worker.wake();
      await committed.promise;
      await expect(
        store.getPluginData("session-a", "mimo-tts", "tracks", "atomic"),
      ).resolves.toMatchObject({ value: { generated: true } });
      await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
        status: "succeeded",
        result: { generated: true },
      });
      await expect(
        recoverExpiredRuntimeJobs(store, {
          tryWithCommitLock,
          now: "2099-01-01T00:00:00.000Z",
        }),
      ).resolves.toEqual({ timedOut: 0, orphaned: 0 });
      expect(
        (await store.listJobStatus("session-a", { jobId: "job-a" })).at(-1)
          ?.state,
      ).toBe("progress");
      const replay = vi.fn(async () => {});
      const replacement = createRuntimeJobWorker({
        tryWithCommitLock,
        store,
        eventBus,
        execute: replay,
      });
      try {
        replacement.wake();
        await vi.waitFor(async () => {
          expect(
            (await store.listJobStatus("session-a", { jobId: "job-a" })).at(-1)
              ?.state,
          ).toBe("succeeded");
        });
        expect(replay).not.toHaveBeenCalled();
      } finally {
        await replacement.close();
      }
    } finally {
      finish.resolve();
      await worker.close();
      await eventBus.close();
    }
  });

  it.each(["rollback", "lease-loss", "no-barrier"] as const)(
    "rolls domain writes back when completion fails due to %s",
    async (failure) => {
      await createRuntimeJob(store, job());
      const eventBus = createEventBus();
      const worker = createRuntimeJobWorker({
        tryWithCommitLock,
        store,
        eventBus,
        execute: async (_job, control) => {
          if (failure !== "no-barrier") {
            await control.beforeCommit({
              backgroundTurnId: "atomic-turn",
              backgroundExecutionId: "atomic-execution",
            });
          }
          if (failure === "lease-loss") {
            await recoverExpiredRuntimeJobs(store, {
              tryWithCommitLock,
              now: "2099-01-01T00:00:00.000Z",
            });
          }
          await store.withTransaction(async (tx) => {
            await writeAtomicTrack(tx);
            await control.completeInTx(tx, { generated: true });
            if (failure === "rollback")
              throw new Error("synthetic transaction rollback");
          });
        },
      });
      try {
        worker.wake();
        await vi.waitFor(async () => {
          await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
            status:
              failure === "rollback"
                ? "failed"
                : failure === "lease-loss"
                  ? "orphaned"
                  : "stale",
          });
        });
        await worker.close();
        await expect(
          store.getPluginData("session-a", "mimo-tts", "tracks", "atomic"),
        ).resolves.toBeNull();
        expect(
          (await store.listJobStatus("session-a", { jobId: "job-a" })).some(
            (row) => row.state === "succeeded",
          ),
        ).toBe(false);
        if (failure === "rollback") {
          await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
            error: "synthetic transaction rollback",
          });
        }
      } finally {
        await worker.close();
        await eventBus.close();
      }
    },
  );

  it.each(["pre-execution", "commit-barrier"] as const)(
    "records a distinct durable reason when a stale rejection happens %s",
    async (phase) => {
      await createRuntimeJob(store, job());
      const eventBus = createEventBus();
      const worker = createRuntimeJobWorker({
        tryWithCommitLock,
        store,
        eventBus,
        execute: async (_job, control) => {
          if (phase === "pre-execution") {
            // Mirrors the bootstrap pre-checks that run before any provider
            // call or commit attempt.
            throw new RuntimeJobNoLongerCurrentError();
          }
          // Cross the commit barrier, then lose currency while the job is
          // still committing (lease-loss abort / in-lock revalidation).
          await control.beforeCommit({
            backgroundTurnId: "atomic-turn",
            backgroundExecutionId: "atomic-execution",
          });
          throw new RuntimeJobNoLongerCurrentError();
        },
      });
      try {
        worker.wake();
        await vi.waitFor(async () => {
          await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
            status: "stale",
            reason:
              phase === "pre-execution"
                ? "pre-execution-rejected"
                : "commit-barrier-rejected",
          });
        });
      } finally {
        await worker.close();
        await eventBus.close();
      }
    },
  );

  it.each(["executor", "projection"] as const)(
    "keeps committed success when post-commit %s work fails",
    async (failure) => {
      await createRuntimeJob(store, job());
      const eventBus = createEventBus();
      let rejected = false;
      const intercepted = failStatusProjection(store, (row) => {
        if (failure !== "projection" || row.state !== "succeeded" || rejected)
          return false;
        rejected = true;
        return true;
      });
      const execute = vi.fn(
        async (_job, control: RuntimeJobExecutionControl) => {
          await control.beforeCommit({
            backgroundTurnId: "atomic-turn",
            backgroundExecutionId: "atomic-execution",
          });
          await store.withTransaction(async (tx) => {
            await writeAtomicTrack(tx);
            await control.completeInTx(tx, { generated: true });
          });
          if (failure === "executor")
            throw new Error("synthetic post-commit failure");
        },
      );
      const worker = createRuntimeJobWorker({
        tryWithCommitLock,
        store,
        eventBus,
        execute,
      });
      try {
        worker.wake();
        await vi.waitFor(async () => {
          expect(
            (await store.listJobStatus("session-a", { jobId: "job-a" })).at(-1)
              ?.state,
          ).toBe("succeeded");
        });
        await worker.close();
        expect(execute).toHaveBeenCalledOnce();
        await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
          status: "succeeded",
          result: { generated: true },
        });
        await expect(
          store.getPluginData("session-a", "mimo-tts", "tracks", "atomic"),
        ).resolves.toMatchObject({ value: { generated: true } });
        expect(rejected).toBe(failure === "projection");
      } finally {
        await worker.close();
        intercepted.mockRestore();
        await eventBus.close();
      }
    },
  );

  it("fails an executor that returns without completing its transaction", async () => {
    await createRuntimeJob(store, job());
    const eventBus = createEventBus();
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus,
      execute: async (_job, control) => {
        await control.beforeCommit({
          backgroundTurnId: "missing-turn",
          backgroundExecutionId: "missing-execution",
        });
      },
    });
    try {
      worker.wake();
      await vi.waitFor(async () => {
        await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
          status: "failed",
          error: "runtime job returned without a committed result",
        });
      });
    } finally {
      await worker.close();
      await eventBus.close();
    }
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
      tryWithCommitLock,
      store,
      eventBus,
      execute: async (_runtimeJob, control) => {
        await blocked;
        await control.beforeCommit({
          backgroundTurnId: "late-turn",
          backgroundExecutionId: "late-execution",
        });
        await store.withTransaction((tx) => control.completeInTx(tx));
        committed();
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
    });
    const eventBus = createEventBus(store);
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
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
      tryWithCommitLock,
      store,
      eventBus: createEventBus(),
      execute: async (_job, control) => {
        await control.beforeCommit({
          backgroundTurnId: "commit-turn",
          backgroundExecutionId: "commit-execution",
        });
        signal = control.signal;
        await blocked;
        await store.withTransaction((tx) =>
          control.completeInTx(tx, "committed"),
        );
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
    let failed = false;
    const append = failStatusProjection(store, () => {
      if (failed) return false;
      failed = true;
      return true;
    });
    const execute = vi.fn(async (_job, control: RuntimeJobExecutionControl) => {
      await control.beforeCommit({
        backgroundTurnId: "turn-b",
        backgroundExecutionId: "execution-b",
      });
      await store.withTransaction((tx) => control.completeInTx(tx));
    });
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
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
      tryWithCommitLock,
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
      tryWithCommitLock,
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
        await store.withTransaction((tx) => control.completeInTx(tx));
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
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = vi.fn(async () => {
      await blocked;
    });
    const transact = store.withTransaction.bind(store);
    const intercepted = vi
      .spyOn(store, "withTransaction")
      .mockImplementation((fn) =>
        transact((tx) =>
          fn({
            ...tx,
            compareAndSetPluginData: async (record, revision) => {
              if ((record.value as { status?: string }).status === "claimed")
                await claim();
              return tx.compareAndSetPluginData(record, revision);
            },
          }),
        ),
      );
    const execute = vi.fn();
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus: createEventBus(),
      execute,
      concurrency: 1,
    });
    worker.wake();
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    worker.wake();
    worker.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claim).toHaveBeenCalledOnce();
    const closing = worker.close();
    release();
    await closing;
    expect(execute).not.toHaveBeenCalled();
    expect(worker.activeCount).toBe(0);
    await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
      status: "cancelled",
      reason: "worker-shutdown",
    });
    intercepted.mockRestore();
  });

  it("waits for an in-flight renewal before crossing the commit barrier", async () => {
    await createRuntimeJob(store, job());
    const renewal = Promise.withResolvers<void>();
    const execution = Promise.withResolvers<void>();
    let initialLease: string | undefined;
    let renewing = false;
    const swap = store.compareAndSetPluginData.bind(store);
    const intercepted = vi
      .spyOn(store, "compareAndSetPluginData")
      .mockImplementation(async (record, revision) => {
        const value = record.value as Record<string, unknown>;
        if (
          value.status === "running" &&
          initialLease &&
          value.leaseExpiresAt !== initialLease
        ) {
          renewing = true;
          await renewal.promise;
        }
        if (value.status === "committing") await renewal.promise;
        return swap(record, revision);
      });
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus: createEventBus(),
      leaseMs: 90,
      execute: async (claimed, control) => {
        initialLease = claimed.leaseExpiresAt;
        await execution.promise;
        await control.beforeCommit({
          backgroundTurnId: "background-turn",
          backgroundExecutionId: "background-execution",
        });
        await store.withTransaction((tx) => control.completeInTx(tx));
      },
    });
    try {
      worker.wake();
      await vi.waitFor(() => expect(renewing).toBe(true));
      execution.resolve();
      // Let the commit attempt reach storage while the renewal CAS is pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
      renewal.resolve();
      await vi.waitFor(async () => {
        await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
          status: "succeeded",
        });
      });
    } finally {
      execution.resolve();
      renewal.resolve();
      await worker.close();
      intercepted.mockRestore();
    }
  });

  it("claims valid work behind an expired queue head without another wake", async () => {
    await createRuntimeJob(
      store,
      job("session-a", "a-expired", { maxQueueMs: 1 }),
    );
    await createRuntimeJob(store, job("session-a", "b-valid"));

    await expect(
      claimNextRuntimeJob(store, { ownerId: "worker", leaseMs: 30_000 }),
    ).resolves.toMatchObject({ job: { jobId: "b-valid", status: "claimed" } });
    await expect(
      getRuntimeJob(store, job("session-a", "a-expired")),
    ).resolves.toMatchObject({ status: "timed_out" });
  });

  it("does not orphan a job renewed after the recovery scan", async () => {
    await createRuntimeJob(store, job());
    await claimRuntimeJob(store, {
      ...job(),
      ownerId: "worker",
      leaseMs: 1_000,
      now: ENQUEUED_AT,
    });
    const list = store.listPluginDataByNamespace.bind(store);
    const intercepted = vi
      .spyOn(store, "listPluginDataByNamespace")
      .mockImplementationOnce(async (sessionId, namespace) => {
        const rows = await list(sessionId, namespace);
        await renewRuntimeJobLease(store, {
          ...job(),
          ownerId: "worker",
          leaseMs: 10_000,
          now: "2026-09-03T00:00:01.500Z",
        });
        return rows;
      });
    try {
      await expect(
        recoverExpiredRuntimeJobs(store, {
          tryWithCommitLock,
          now: "2026-09-03T00:00:02.000Z",
        }),
      ).resolves.toEqual({ timedOut: 0, orphaned: 0 });
      await expect(getRuntimeJob(store, job())).resolves.toMatchObject({
        status: "claimed",
        leaseExpiresAt: "2026-09-03T00:00:11.500Z",
      });
    } finally {
      intercepted.mockRestore();
    }
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
    await createRuntimeJob(
      store,
      job("session-a", "lease-expired", {
        runtimeId: "mimo-tts/other-runtime",
      }),
    );
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
        tryWithCommitLock,
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

  it("reads session jobs without loading other plugin data", async () => {
    await store.setPluginData({
      id: "unrelated-row",
      sessionId: "session-a",
      pluginId: "codex",
      namespace: "entries",
      key: "large",
      value: { text: "x".repeat(10_000) },
      createdAt: ENQUEUED_AT,
      updatedAt: ENQUEUED_AT,
    });
    await createRuntimeJob(
      store,
      job("session-a", "settling", {
        settle: "before-next-execution",
        maxSettleWaitMs: 1000,
      }),
    );
    const sessionScope = vi.spyOn(store, "listPluginDataSessionScope");

    const jobs = await listRuntimeJobs(store, { sessionId: "session-a" });
    const settling = await listSettlingRuntimeJobs(store, "session-a");
    const claimed = await claimNextRuntimeJob(store, {
      ownerId: "worker",
      leaseMs: 30_000,
    });

    expect(jobs.map((row) => row.jobId)).toEqual(["settling"]);
    expect(settling.map((row) => row.jobId)).toEqual(["settling"]);
    expect(claimed?.job.jobId).toBe("settling");
    expect(sessionScope).not.toHaveBeenCalled();
  });

  it("keeps only the newest terminal jobs per runtime", async () => {
    for (const id of ["old-1", "old-2", "new-1"]) {
      const created = await createRuntimeJob(store, job("session-a", id));
      await store.appendJobStatus(makeRuntimeJobStatusRecord(created, 0));
      await transitionRuntimeJob(store, {
        ...job("session-a", id),
        from: ["queued"],
        to: "failed",
      });
    }
    await createRuntimeJob(store, job("session-a", "pending"));

    const remaining = await pruneTerminalRuntimeJobs(
      store,
      "session-a",
      await listRuntimeJobs(store, { sessionId: "session-a" }),
      1,
    );

    expect(remaining.map((row) => row.jobId)).toEqual(["new-1", "pending"]);
    expect(
      (await listRuntimeJobs(store, { sessionId: "session-a" })).map(
        (row) => row.jobId,
      ),
    ).toEqual(["new-1", "pending"]);
    expect(
      (await store.listJobStatus("session-a")).map((row) => row.jobId),
    ).toEqual(["new-1"]);
  });

  it("prunes terminal history during worker maintenance", async () => {
    for (let index = 0; index < 22; index += 1) {
      const id = `done-${String(index).padStart(2, "0")}`;
      await createRuntimeJob(store, job("session-a", id));
      await transitionRuntimeJob(store, {
        ...job("session-a", id),
        from: ["queued"],
        to: "cancelled",
      });
    }
    const worker = createRuntimeJobWorker({
      tryWithCommitLock,
      store,
      eventBus: createEventBus(store),
      execute: vi.fn(),
    });

    worker.wake();
    await vi.waitFor(async () => {
      const remaining = await listRuntimeJobs(store, {
        sessionId: "session-a",
      });
      expect(remaining).toHaveLength(20);
      expect(remaining[0]!.jobId).toBe("done-02");
    });
    await worker.close();
  });
});
