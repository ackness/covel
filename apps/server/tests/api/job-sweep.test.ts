/**
 * Startup crash-recovery sweep for orphaned background jobs.
 *
 * The sweep decides by ownership, not by age: a `pending` row is orphaned iff
 * no live process claims it. These tests pin that distinction, because the
 * obvious-looking age-based variant is what previously reaped jobs that were
 * still legitimately running.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore, type SessionRecord } from "@covel/store";
import {
  makePendingPluginJobValue,
  makeTerminalPluginJobValue,
  sweepStalePendingJobs,
  writePluginJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";

const SESSION_ID = "world-sweep01";
const PLUGIN_ID = "some-plugin";

function makeSession(now: string): SessionRecord {
  return {
    id: SESSION_ID,
    worldId: "world",
    status: "active",
    turnCount: 1,
    preGameCompleted: [],
    activePlugins: [PLUGIN_ID],
    createdAt: now,
    updatedAt: now,
  };
}

async function writeJob(
  store: ReturnType<typeof createMemoryStore>,
  jobId: string,
  startedAt: string,
  status: "pending" | "done",
  /**
   * Overrides the owner stamped by `makePendingPluginJobValue`. Simulates a row
   * left behind by a previous process (any other uuid) or one predating the
   * `owner` field (undefined).
   */
  ownerOverride?: { readonly owner?: string },
): Promise<void> {
  const base = { runtimeId: "some-plugin/runtime", turnId: "t1", startedAt };
  let value =
    status === "pending"
      ? makePendingPluginJobValue(base)
      : makeTerminalPluginJobValue({
          ...base,
          status: "done",
          completedAt: startedAt,
        });
  if (ownerOverride) {
    const { owner: _live, ...rest } = value as Record<string, unknown>;
    value = (
      ownerOverride.owner !== undefined
        ? { ...rest, owner: ownerOverride.owner }
        : rest
    ) as typeof value;
  }
  await writePluginJob(store, {
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    jobId,
    startedAt,
    value,
  });
}

async function readJob(
  store: ReturnType<typeof createMemoryStore>,
  jobId: string,
): Promise<Record<string, unknown>> {
  const row = await store.getPluginData(SESSION_ID, PLUGIN_ID, "_jobs", jobId);
  return (row?.value ?? {}) as Record<string, unknown>;
}

describe("sweepStalePendingJobs", () => {
  it("fails pending jobs left by a dead process and leaves terminal ones untouched", async () => {
    const store = createMemoryStore();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const olderIso = new Date(now - 20 * 60_000).toISOString();
    await store.createSession(makeSession(nowIso));

    await writeJob(store, "dead-owner", olderIso, "pending", {
      owner: "1e7b0f4c-0000-4000-8000-deadbeef0001",
    });
    await writeJob(store, "old-done", olderIso, "done");

    const swept = await sweepStalePendingJobs(store, { now });
    expect(swept).toBe(1);

    const orphan = await readJob(store, "dead-owner");
    expect(orphan.status).toBe("failed");
    expect(orphan.error).toMatch(/orphaned/);

    expect((await readJob(store, "old-done")).status).toBe("done");
  });

  it("keeps a pending job owned by the live process no matter how old it is", async () => {
    const store = createMemoryStore();
    const now = Date.now();
    await store.createSession(makeSession(new Date(now).toISOString()));

    // An hour-old job still owned by this process is a long-running job, not a
    // corpse — the age-based sweep this replaced would have killed it. Image
    // generation legitimately runs for minutes (background-gen: timeoutMs 6min).
    const hourAgo = new Date(now - 60 * 60_000).toISOString();
    await writeJob(store, "long-running", hourAgo, "pending");

    await expect(sweepStalePendingJobs(store, { now })).resolves.toBe(0);
    expect((await readJob(store, "long-running")).status).toBe("pending");
  });

  it("treats a row written before the owner field existed as orphaned", async () => {
    const store = createMemoryStore();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await store.createSession(makeSession(nowIso));

    // No `owner` means some earlier process wrote it — this process certainly
    // did not, so there is no executor.
    await writeJob(store, "legacy-row", nowIso, "pending", {});

    await expect(sweepStalePendingJobs(store, { now })).resolves.toBe(1);
    expect((await readJob(store, "legacy-row")).status).toBe("failed");
  });

  it("carries trigger context onto the terminal row so the job can be retried", async () => {
    const store = createMemoryStore();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await store.createSession(makeSession(nowIso));

    const triggerEvent = {
      topic: "scene-stage.generate.requested",
      data: { sceneId: "classroom", variant: "day" },
    };
    await writePluginJob(store, {
      sessionId: SESSION_ID,
      pluginId: PLUGIN_ID,
      jobId: "with-context",
      startedAt: nowIso,
      value: {
        ...makePendingPluginJobValue({
          runtimeId: "some-plugin/runtime",
          turnId: "t1",
          startedAt: nowIso,
          triggerEvent,
        }),
        owner: "1e7b0f4c-0000-4000-8000-deadbeef0002",
      },
    });

    await sweepStalePendingJobs(store, { now });

    const row = await readJob(store, "with-context");
    expect(row.status).toBe("failed");
    // `reason` separates "the process died" from "the job itself failed".
    expect(row.reason).toBe("orphaned");
    expect(row.triggerEvent).toEqual(triggerEvent);
  });

  it("returns 0 on an empty store", async () => {
    const store = createMemoryStore();
    await expect(sweepStalePendingJobs(store)).resolves.toBe(0);
  });
});
