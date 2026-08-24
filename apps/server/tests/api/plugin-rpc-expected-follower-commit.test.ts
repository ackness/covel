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
import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import { sessionApprovalScope } from "../../src/routes/api/session/session-guard.js";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("expected-background-follower commit gate", () => {
  it("fails the job and schedules no follower when the runtime's proposals did not commit", async () => {
    const store: DataStore = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      activePlugins: [PLUGIN_ID],
      createdAt: now,
      updatedAt: now,
    });
    const session = await store.getSession(SESSION_ID);
    if (!session) throw new Error("expected session");
    const runner = createPluginRpcJobRunner({
      store,
      sessionId: SESSION_ID,
      sessionLock: createInProcessSessionLock(),
      approvalScopes: new Map([
        [PLUGIN_ID, sessionApprovalScope(session, PLUGIN_ID)],
      ]),
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
    expect(parent).toBeDefined();
    const parentValue = parent!.value as { status?: string; error?: string };
    expect(parentValue.status).toBe("failed");
    expect(String(parentValue.error)).toContain("proposal(s) failed to commit");
    // No follower job was scheduled — the parent is the only row.
    expect(rows).toHaveLength(1);
  });

  it("does not recreate terminal job state in a reused session id", async () => {
    const store: DataStore = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      turnCount: 1,
      preGameCompleted: [],
      activePlugins: [PLUGIN_ID],
      metadata: { approvalScopeNonce: "old-incarnation" },
      createdAt: now,
      updatedAt: now,
    });
    const oldSession = await store.getSession(SESSION_ID);
    if (!oldSession) throw new Error("expected session");
    const started = deferred();
    const finish = deferred();
    const runner = createPluginRpcJobRunner({
      store,
      sessionId: SESSION_ID,
      sessionLock: createInProcessSessionLock(),
      approvalScopes: new Map([
        [PLUGIN_ID, sessionApprovalScope(oldSession, PLUGIN_ID)],
      ]),
      runManualTurn: async () => {
        started.resolve();
        await finish.promise;
        return summaryWithFailedCommit();
      },
      runDeferredFollowerTurn: async () => {
        throw new Error("unused");
      },
      hasActiveRuntime: () => true,
    });

    await runner.enqueueBackgroundRuntime({
      pluginId: PLUGIN_ID,
      runtimeId: RUNTIME_ID,
      turnId: "turn-old-incarnation",
    });
    await started.promise;
    await store.deleteSession(SESSION_ID);
    await store.createSession({
      id: SESSION_ID,
      worldId: null,
      status: "active",
      turnCount: 0,
      preGameCompleted: [],
      activePlugins: [PLUGIN_ID],
      metadata: { approvalScopeNonce: "new-incarnation" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    finish.resolve();
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(await store.listPluginData(SESSION_ID, PLUGIN_ID, "_jobs")).toEqual(
      [],
    );
  });
});
