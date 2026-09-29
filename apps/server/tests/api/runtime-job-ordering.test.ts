import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DataStore } from "@covel/store";
import { createMemoryStore } from "@covel/store/memory";
import { createSqliteStore } from "@covel/store/sqlite";
import { createEventBus } from "@covel/events";
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createRuntimeJobWorker,
  type RuntimeJobExecutor,
} from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import {
  claimNextRuntimeJob,
  claimRuntimeJob,
  createRuntimeJob,
  getRuntimeJob,
  listSettlingRuntimeJobs,
  RuntimeJobSupersededError,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";

const timestamp = "2026-09-27T00:00:00.000Z";
const job = (jobId: string) => ({
  sessionId: "session",
  pluginId: "plugin",
  runtimeId: "plugin/runtime",
  jobId,
  origin: { activation: "stage" as const, sourceTurnId: jobId },
  payload: {},
  enqueuedAt: timestamp,
});

describe.each([
  ["memory", () => createMemoryStore()],
  ["sqlite", () => createSqliteStore(":memory:")],
] as const)("runtime job FIFO (%s)", (_name, createStore) => {
  let store: DataStore;
  beforeEach(async () => {
    store = createStore();
    await store.createSession({
      id: "session",
      worldId: "world",
      status: "active",
      locale: "en-US",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      activePlugins: ["plugin"],
      metadata: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });
  afterEach(async () => {
    await store.close();
  });

  it("uses persistent enqueue order for equal timestamps and allows only the head to be claimed", async () => {
    const first = await createRuntimeJob(store, job("z-first"));
    const second = await createRuntimeJob(store, job("a-second"));
    expect(first.sequence).toBeLessThan(second.sequence);
    await expect(
      claimRuntimeJob(store, {
        ...job("a-second"),
        ownerId: "worker",
        leaseMs: 1000,
      }),
    ).resolves.toBeNull();
    const claims = await Promise.all([
      claimNextRuntimeJob(store, { ownerId: "one", leaseMs: 1000 }),
      claimNextRuntimeJob(store, { ownerId: "two", leaseMs: 1000 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.find(Boolean)?.job.jobId).toBe("z-first");
    await expect(
      claimNextRuntimeJob(store, { ownerId: "other", leaseMs: 1000 }),
    ).resolves.toBeNull();
    await transitionRuntimeJob(store, {
      ...job("z-first"),
      from: ["claimed"],
      to: "failed",
    });
    await expect(
      claimNextRuntimeJob(store, { ownerId: "other", leaseMs: 1000 }),
    ).resolves.toMatchObject({ job: { jobId: "a-second" } });
  });

  it("leaves missing credentials queued and does not let its successor overtake", async () => {
    await createRuntimeJob(store, job("head"));
    await createRuntimeJob(store, job("tail"));
    await expect(
      claimNextRuntimeJob(store, {
        ownerId: "worker",
        leaseMs: 1000,
        canClaim: (candidate) => candidate.jobId !== "head",
      }),
    ).resolves.toBeNull();
    await expect(getRuntimeJob(store, job("head"))).resolves.toMatchObject({
      status: "queued",
      attempt: 0,
    });
    await expect(
      claimNextRuntimeJob(store, {
        ownerId: "worker",
        leaseMs: 1000,
        canClaim: () => true,
      }),
    ).resolves.toMatchObject({ job: { jobId: "head" } });
  });

  it("rolls enqueue order back with a failed source transaction", async () => {
    await expect(
      store.withTransaction(async (tx) => {
        await createRuntimeJob(tx, job("rolled-back"));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await expect(getRuntimeJob(store, job("rolled-back"))).resolves.toBeNull();
    expect((await createRuntimeJob(store, job("survivor"))).sequence).toBe(1);
  });

  it("rejects an old settling retry after a newer source execution was enqueued", async () => {
    await createRuntimeJob(store, {
      ...job("old"),
      settle: "before-next-execution",
    });
    await transitionRuntimeJob(store, {
      ...job("old"),
      from: ["queued"],
      to: "failed",
    });
    await createRuntimeJob(store, {
      ...job("new"),
      settle: "before-next-execution",
    });
    await expect(
      createRuntimeJob(store, {
        ...job("retry"),
        settle: "before-next-execution",
        retryOfJobId: "old",
      }),
    ).rejects.toBeInstanceOf(RuntimeJobSupersededError);
  });

  it("waits only for nonterminal settling jobs", async () => {
    await createRuntimeJob(store, job("ordinary"));
    await createRuntimeJob(store, {
      ...job("settling"),
      settle: "before-next-execution",
      maxSettleWaitMs: 123,
    });
    await expect(
      listSettlingRuntimeJobs(store, "session"),
    ).resolves.toMatchObject([{ jobId: "settling", maxSettleWaitMs: 123 }]);
    await transitionRuntimeJob(store, {
      ...job("settling"),
      from: ["queued"],
      to: "cancelled",
    });
    await expect(listSettlingRuntimeJobs(store, "session")).resolves.toEqual(
      [],
    );
  });
  it("captures an eligible executor before claim and keeps unavailable work queued", async () => {
    await createRuntimeJob(store, job("credential-job"));
    let selected: RuntimeJobExecutor | undefined;
    const executed = vi.fn();
    const prepareExecution = vi.fn(() => {
      const captured = selected;
      selected = undefined;
      return captured;
    });
    const lock = createInProcessSessionLock();
    const fallback = vi.fn(async () => {
      throw new Error("uncaptured fallback");
    });
    const worker = createRuntimeJobWorker({
      store,
      eventBus: createEventBus(),
      tryWithCommitLock: lock.tryWithLock,
      execute: fallback,
      prepareExecution,
    });
    try {
      worker.wake();
      await vi.waitFor(() => expect(prepareExecution).toHaveBeenCalled());
      await expect(
        getRuntimeJob(store, job("credential-job")),
      ).resolves.toMatchObject({ status: "queued", attempt: 0 });
      selected = async (_job, control) => {
        executed();
        await control.beforeCommit({
          backgroundTurnId: "background",
          backgroundExecutionId: "execution",
        });
        await store.withTransaction((tx) => control.completeInTx(tx));
      };
      worker.wake();
      await vi.waitFor(async () => {
        expect(await getRuntimeJob(store, job("credential-job"))).toMatchObject(
          { status: "succeeded" },
        );
      });
      expect(executed).toHaveBeenCalledOnce();
      expect(fallback).not.toHaveBeenCalled();
      expect(selected).toBeUndefined();
    } finally {
      await worker.close();
    }
  });
});
