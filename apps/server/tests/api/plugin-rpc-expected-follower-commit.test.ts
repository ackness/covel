/**
 * An "expected background follower" job runs the prompt-builder runtime, then
 * schedules the follower it emitted. A runtime can report success while its
 * proposals fail to commit — the job must then settle `failed` and NOT schedule
 * the follower onto rolled-back state, the same rule the plain background-job
 * and follower paths already enforce.
 */

import { describe, expect, it } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import { createPluginRpcJobRunner } from "../../src/routes/api/plugin-rpc/background-jobs.js";
import type { ManualTurnSummary } from "../../src/routes/api/plugin-rpc/runtime-response.js";

const SESSION_ID = "sess-follower-commit";
const PLUGIN_ID = "image";
const RUNTIME_ID = "image/prompt";
const FOLLOWER_RUNTIME = "image/generate";

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("waitFor: predicate did not become true in time");
}

function summaryWithFailedCommit(): ManualTurnSummary {
  return {
    commit: { committed: false, failedProposalCount: 1, snapshotFailed: false },
    turnId: "turn-follower",
    durationMs: 5,
    runtimeResults: [
      {
        runtimeId: RUNTIME_ID,
        pluginId: PLUGIN_ID,
        status: "success",
        durationMs: 5,
        output: { ok: true },
      },
    ],
    deferredFollowers: [
      {
        runtimeId: FOLLOWER_RUNTIME,
        pluginId: PLUGIN_ID,
        triggerEvent: { topic: "image.requested", data: {} },
      },
    ],
  };
}

describe("expected-background-follower commit gate", () => {
  it("fails the job and schedules no follower when the runtime's proposals did not commit", async () => {
    const store: DataStore = createMemoryStore();
    const runner = createPluginRpcJobRunner({
      store,
      sessionId: SESSION_ID,
      runManualTurn: async () => summaryWithFailedCommit(),
      runDeferredFollowerTurn: async () => {
        throw new Error(
          "follower must not run when the parent turn rolled back",
        );
      },
      hasActiveRuntime: () => true,
    });

    const { jobId } = await runner.enqueueExpectedFollowerRuntime({
      pluginId: PLUGIN_ID,
      runtimeId: RUNTIME_ID,
      turnId: "turn-follower",
    });

    await waitFor(async () => {
      const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
      const parent = rows.find((r) => r.key === jobId);
      const status = (parent?.value as { status?: string } | undefined)?.status;
      return status !== undefined && status !== "pending";
    });

    const rows = await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs");
    const parent = rows.find((r) => r.key === jobId);
    expect((parent?.value as { status?: string }).status).toBe("failed");
    expect(String((parent?.value as { error?: string }).error)).toContain(
      "proposal(s) failed to commit",
    );
    // No follower job was scheduled — the parent is the only row.
    expect(rows).toHaveLength(1);
  });
});
