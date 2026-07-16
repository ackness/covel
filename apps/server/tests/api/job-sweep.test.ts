/**
 * Startup crash-recovery sweep for orphaned background jobs (audit R-10).
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
): Promise<void> {
  const base = { runtimeId: "some-plugin/runtime", turnId: "t1", startedAt };
  await writePluginJob(store, {
    sessionId: SESSION_ID,
    pluginId: PLUGIN_ID,
    jobId,
    startedAt,
    value:
      status === "pending"
        ? makePendingPluginJobValue(base)
        : makeTerminalPluginJobValue({
            ...base,
            status: "done",
            completedAt: startedAt,
          }),
  });
}

describe("sweepStalePendingJobs", () => {
  it("fails stale pending jobs and leaves fresh/terminal jobs untouched", async () => {
    const store = createMemoryStore();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const staleIso = new Date(now - 20 * 60_000).toISOString();
    await store.createSession(makeSession(nowIso));

    await writeJob(store, "stale-pending", staleIso, "pending");
    await writeJob(store, "fresh-pending", nowIso, "pending");
    await writeJob(store, "old-done", staleIso, "done");

    const swept = await sweepStalePendingJobs(store, { now });
    expect(swept).toBe(1);

    const stale = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_jobs",
      "stale-pending",
    );
    expect((stale?.value as { status: string }).status).toBe("failed");
    expect((stale?.value as { error: string }).error).toMatch(/orphaned/);

    const fresh = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_jobs",
      "fresh-pending",
    );
    expect((fresh?.value as { status: string }).status).toBe("pending");

    const done = await store.getPluginData(
      SESSION_ID,
      PLUGIN_ID,
      "_jobs",
      "old-done",
    );
    expect((done?.value as { status: string }).status).toBe("done");
  });

  it("returns 0 on an empty store", async () => {
    const store = createMemoryStore();
    await expect(sweepStalePendingJobs(store)).resolves.toBe(0);
  });
});
