import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { createPgStore, type DataStore } from "@covel/store";
import { createPgAdvisorySessionLock } from "../../src/lib/pg-session-lock.js";
import {
  claimRuntimeJob,
  createRuntimeJob,
  getRuntimeJob,
  recoverExpiredRuntimeJobs,
  renewRuntimeJobLease,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import {
  createIsolatedPgDatabase,
  type IsolatedPgDatabase,
} from "./pg-test-db.js";

const baseUrl =
  process.env.DATABASE_URL ??
  "postgresql://covel:covel_dev@localhost:5432/covel";
let database: IsolatedPgDatabase | undefined;
try {
  database = await createIsolatedPgDatabase(
    baseUrl,
    "covel_continuous_jobs_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1") {
    throw new Error("PostgreSQL is required for durable job recovery tests", {
      cause,
    });
  }
}

describe.skipIf(!database)(
  "runtime job recovery across PostgreSQL connections",
  () => {
    let ownerStore: DataStore;
    let recoveryStore: DataStore;
    let ownerPool: ReturnType<typeof postgres>;
    let recoveryPool: ReturnType<typeof postgres>;
    let ownerLock: ReturnType<typeof createPgAdvisorySessionLock>;
    let recoveryLock: ReturnType<typeof createPgAdvisorySessionLock>;

    beforeAll(async () => {
      ownerStore = await createPgStore(database!.url, { freshSchema: true });
      recoveryStore = await createPgStore(database!.url);
      ownerPool = postgres(database!.url, { max: 1 });
      recoveryPool = postgres(database!.url, { max: 1 });
      ownerLock = createPgAdvisorySessionLock(ownerPool);
      recoveryLock = createPgAdvisorySessionLock(recoveryPool);
      const warm = await recoveryPool.reserve();
      warm.release();
    });

    afterAll(async () => {
      await Promise.all([
        ownerStore?.close(),
        recoveryStore?.close(),
        ownerPool?.end(),
        recoveryPool?.end(),
      ]);
      await database?.cleanup();
    }, 30_000);

    async function seed(committing: boolean) {
      const sessionId = crypto.randomUUID();
      const now = new Date().toISOString();
      await ownerStore.createSession({
        id: sessionId,
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
      const key = { sessionId, pluginId: "pg-probe", jobId: "job" };
      await createRuntimeJob(ownerStore, {
        ...key,
        runtimeId: "pg-probe/leaf",
        origin: { activation: "stage", sourceTurnId: "source" },
        payload: {},
      });
      await claimRuntimeJob(ownerStore, {
        ...key,
        ownerId: "owner",
        leaseMs: 1_000,
        now: new Date(Date.now() - 2_000).toISOString(),
      });
      await transitionRuntimeJob(ownerStore, {
        ...key,
        ownerId: "owner",
        from: ["claimed"],
        to: "running",
      });
      if (committing)
        await transitionRuntimeJob(ownerStore, {
          ...key,
          ownerId: "owner",
          from: ["running"],
          to: "committing",
        });
      return key;
    }

    it.each(["abandoned", "succeeded"] as const)(
      "protects a live expired commit and reconciles its %s outcome after release",
      async (outcome) => {
        const key = await seed(true);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const owner = ownerLock.withLock(key.sessionId, async () => {
          entered.resolve();
          await release.promise;
          if (outcome === "succeeded") {
            await ownerStore.withTransaction(async (tx) => {
              await tx.setPluginData({
                id: `${key.sessionId}:domain`,
                sessionId: key.sessionId,
                pluginId: key.pluginId,
                namespace: "tracks",
                key: "result",
                value: { committed: true },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              });
              expect(
                await transitionRuntimeJob(tx, {
                  ...key,
                  ownerId: "owner",
                  from: ["committing"],
                  to: "succeeded",
                }),
              ).not.toBeNull();
            });
          }
        });
        try {
          await entered.promise;
          await recoverExpiredRuntimeJobs(recoveryStore, {
            tryWithCommitLock: recoveryLock.tryWithLock!.bind(recoveryLock),
          });
          await expect(
            getRuntimeJob(recoveryStore, key),
          ).resolves.toMatchObject({ status: "committing" });
          release.resolve();
          await owner;
          await recoverExpiredRuntimeJobs(recoveryStore, {
            tryWithCommitLock: recoveryLock.tryWithLock!.bind(recoveryLock),
          });
          await expect(
            getRuntimeJob(recoveryStore, key),
          ).resolves.toMatchObject({
            status: outcome === "succeeded" ? "succeeded" : "orphaned",
          });
          if (outcome === "succeeded") {
            await expect(
              recoveryStore.getPluginData(
                key.sessionId,
                key.pluginId,
                "tracks",
                "result",
              ),
            ).resolves.toMatchObject({ value: { committed: true } });
          }
        } finally {
          release.resolve();
          await owner;
        }
      },
    );

    it("does not orphan a lease renewed by another connection after the scan", async () => {
      const key = await seed(false);
      const list = recoveryStore.listPluginDataSessionScope.bind(recoveryStore);
      const intercepted = vi
        .spyOn(recoveryStore, "listPluginDataSessionScope")
        .mockImplementation(async (sessionId) => {
          const rows = await list(sessionId);
          if (sessionId === key.sessionId) {
            await renewRuntimeJobLease(ownerStore, {
              ...key,
              ownerId: "owner",
              leaseMs: 30_000,
            });
          }
          return rows;
        });
      try {
        await recoverExpiredRuntimeJobs(recoveryStore, {
          tryWithCommitLock: recoveryLock.tryWithLock!.bind(recoveryLock),
        });
        await expect(getRuntimeJob(recoveryStore, key)).resolves.toMatchObject({
          status: "running",
        });
      } finally {
        intercepted.mockRestore();
      }
    });
  },
);
