import { afterAll, describe, expect, it, vi } from "vitest";
import { createPgStore } from "@covel/store/postgres";
import { createIsolatedPgDatabase } from "./pg-test-db.js";
import { presentationFixture } from "../helpers/presentation-runtime-fixture.js";
import { enqueueDeferredRuntimeJobs } from "../../src/routes/api/plugin-rpc/runtime-job-enqueue.js";

let database: Awaited<ReturnType<typeof createIsolatedPgDatabase>> | undefined;
try {
  database = await createIsolatedPgDatabase(
    process.env.DATABASE_URL ??
      "postgresql://covel:covel_dev@localhost:5432/covel",
    "covel_presentation_pg",
  );
} catch (cause) {
  if (process.env.COVEL_REQUIRE_PG_TESTS === "1")
    throw new Error("PostgreSQL is required for presentation tests", { cause });
}
afterAll(() => database?.cleanup());

describe.skipIf(!database)("PostgreSQL presentation transactions", () => {
  it("atomically bounds concurrent dispatch and preserves spend after a later commit rollback", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const f = await presentationFixture({
      store,
      handler: async (ctx) => {
        const responses = await Promise.allSettled(
          ["one", "two", "three"].map((prompt) =>
            ctx.gateway!.generateText({ prompt }),
          ),
        );
        if (responses.some((result) => result.status === "fulfilled"))
          await ctx.pluginData!.set("display", "current", {
            title: "Generated display",
          });
        return { outcome: "success", value: {} };
      },
    });
    const transact = store.withTransaction.bind(store);
    try {
      const first = await f.source();
      expect(first.outcome.status).toBe("committed");
      const failure = vi
        .spyOn(store, "withTransaction")
        .mockImplementation((work) =>
          transact((tx) =>
            work({
              ...tx,
              compareAndSetPluginData: async (row, expected) => {
                if (
                  row.namespace === "_runtime_jobs" &&
                  (row.value as { status?: string }).status === "succeeded"
                )
                  throw new Error("Injected final bookkeeping failure");
                return tx.compareAndSetPluginData(row, expected);
              },
            }),
          ),
        );
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(2));
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("failed"),
      );
      failure.mockRestore();
      expect(
        await store.getPluginData(
          f.sessionId,
          f.presentation.pluginId,
          "display",
          "current",
        ),
      ).toBeNull();
      expect(await store.listMessages(f.sessionId)).toHaveLength(1);
      const ledger = await store.listPluginData(
        f.sessionId,
        "__kernel:presentation",
        "_presentation_budget",
      );
      expect(ledger.map((row) => row.value)).toEqual([
        expect.objectContaining({ used: { calls: 2, generations: 0 } }),
      ]);
      const original = first.descriptors[0]!;
      await store.withTransaction((tx) =>
        enqueueDeferredRuntimeJobs(tx, {
          sessionId: f.sessionId,
          session: f.session,
          activeRuntimes: f.manifests,
          descriptors: [{ ...original, jobId: crypto.randomUUID() }],
          locale: "en-US",
        }),
      );
      f.worker.wake();
      await vi.waitFor(async () =>
        expect((await f.jobs()).some((job) => job.status === "succeeded")).toBe(
          true,
        ),
      );
      expect(f.calls).toHaveLength(2);
    } finally {
      vi.restoreAllMocks();
      await f.close();
      await store.close();
    }
  });

  it("lets a newer override win after worker execution and before its commit", async () => {
    const store = await createPgStore(database!.url, { freshSchema: true });
    const f = await presentationFixture({ store });
    try {
      expect((await f.source()).outcome.status).toBe("committed");
      f.worker.wake();
      await vi.waitFor(() => expect(f.calls).toHaveLength(1));
      const now = new Date().toISOString();
      await f.lock.withLock(f.sessionId, () =>
        store.setPluginData({
          id: crypto.randomUUID(),
          sessionId: f.sessionId,
          pluginId: f.presentation.pluginId,
          namespace: "display",
          key: "current",
          value: { title: "New override" },
          createdAt: now,
          updatedAt: now,
        }),
      );
      f.release();
      await vi.waitFor(async () =>
        expect((await f.jobs())[0]?.status).toBe("succeeded"),
      );
      expect(
        (
          await store.getPluginData(
            f.sessionId,
            f.presentation.pluginId,
            "display",
            "current",
          )
        )?.value,
      ).toEqual({ title: "New override" });
      expect(
        (await store.listTraceEvents(f.sessionId)).find(
          (trace) => trace.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({ reason: "superseded" });
      expect(
        await store.queryTurnResults(f.sessionId, { commitStatus: "pending" }),
      ).toHaveLength(0);
    } finally {
      await f.close();
      await store.close();
    }
  });
});
