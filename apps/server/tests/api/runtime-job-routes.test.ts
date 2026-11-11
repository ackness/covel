import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store/memory";
import { readRuntimeEnv } from "@covel/shared";
import type { SessionRecord } from "@covel/store";
import { deriveHostProfile } from "../../src/host-profile.js";

import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createRuntimeJob,
  getRuntimeJob,
  listRuntimeJobs,
  transitionRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import type { StagedRuntimeJobPayload } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { runtimeJobRoutes } from "../../src/routes/api/runtime-jobs.js";
import {
  hashSessionOwnerToken,
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";

function stagedPayload(session: SessionRecord): StagedRuntimeJobPayload {
  return {
    schemaVersion: 1,
    expectedSessionIncarnation: sessionIncarnationIdentity(session),
    expectedApprovalScope: sessionApprovalScope(session, "media"),
    locale: "zh-CN",
    descriptor: {
      jobId: "source-job",
      runtimeId: "media/leaf",
      pluginId: "media",
      sourceTurnId: "source-turn",
      sourceExecutionId: "source-execution",
      turnDigest: {
        turnId: "source-turn",
        playerMessage: "",
        actions: [],
        lastPlayerInput: null,
        narrativeText: "",
        toolCallSummaries: [],
        runtimeResults: [],
      },
      sourceExecutionStartedAt: session.createdAt,
      pluginVersion: "1.0.0",
      upstreamResults: [],
    },
  };
}

describe("runtime job control routes", () => {
  it.each([
    ["cancel", "owner", 401],
    ["retry", "owner", 401],
    ["cancel", "incarnation", 409],
    ["retry", "incarnation", 409],
  ] as const)(
    "refuses %s when the %s changes before acquiring the lock",
    async (operation, change, expectedStatus) => {
      const store = createMemoryStore();
      const now = new Date().toISOString();
      const session: SessionRecord = {
        id: "recreated-job-session",
        status: "active",
        locale: "en-US",
        phase: "playing",
        completedPlayerTurns: 1,
        setupRuntimes: {},
        seats: [],
        activePlugins: ["media"],
        metadata: {
          ownerTokenHash: hashSessionOwnerToken("original-owner"),
          approvalScopeNonce: crypto.randomUUID(),
          sessionIncarnationNonce: crypto.randomUUID(),
        },
        createdAt: now,
        updatedAt: now,
      };
      await store.createSession(session);
      const lock = createInProcessSessionLock();
      vi.spyOn(lock, "withLock").mockImplementation(async (_id, run) => {
        // A delete/recreate that won the lock after the request's first read.
        await store.deleteSession(session.id);
        const replacement: SessionRecord = {
          ...session,
          metadata: {
            ...session.metadata,
            ownerTokenHash: hashSessionOwnerToken(
              change === "owner" ? "replacement-owner" : "original-owner",
            ),
            sessionIncarnationNonce: crypto.randomUUID(),
          },
        };
        await store.createSession(replacement);
        await createRuntimeJob(store, {
          jobId: "source-job",
          sessionId: session.id,
          pluginId: "media",
          runtimeId: "media/leaf",
          origin: { activation: "stage", sourceTurnId: "source-turn" },
          payload: stagedPayload(replacement),
        });
        if (operation === "retry")
          await transitionRuntimeJob(store, {
            sessionId: session.id,
            pluginId: "media",
            jobId: "source-job",
            from: ["queued"],
            to: "cancelled",
          });
        return run();
      });
      const profile = deriveHostProfile(
        readRuntimeEnv({ NODE_ENV: "production", DEPLOYMENT_TIER: "self" }),
        { storeBackend: "memory" },
      );
      const wake = vi.fn();
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("store", store);
        c.set("hostProfile", profile);
        c.set("eventBus", createEventBus(store));
        c.set("sessionLock", lock);
        c.set("runtimeJobWorker", { wake, close: vi.fn(), activeCount: 0 });
        await next();
      });
      app.route("/api/sessions", runtimeJobRoutes);
      try {
        const response = await app.request(
          `/api/sessions/${session.id}/runtime-jobs/source-job/${operation}`,
          {
            method: "POST",
            headers: { Authorization: "Bearer original-owner" },
          },
        );
        expect(response.status).toBe(expectedStatus);
        if (change === "incarnation")
          expect(await response.json()).toMatchObject({
            code: "session_incarnation_changed",
          });
        expect(
          await listRuntimeJobs(store, { sessionId: session.id }),
        ).toMatchObject([
          {
            jobId: "source-job",
            status: operation === "retry" ? "cancelled" : "queued",
          },
        ]);
        expect(wake).not.toHaveBeenCalled();
      } finally {
        await store.close();
      }
    },
  );

  it("lists redacted jobs and supports explicit cancel/retry", async () => {
    const store = createMemoryStore();
    const now = new Date().toISOString();
    await store.createSession({
      id: "runtime-job-session",
      status: "active",
      locale: "zh-CN",
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
      activePlugins: ["media"],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const session = (await store.getSession("runtime-job-session"))!;
    const payload = stagedPayload(session);
    await createRuntimeJob(store, {
      jobId: "source-job",
      sessionId: session.id,
      pluginId: "media",
      runtimeId: "media/leaf",
      origin: { activation: "stage", sourceTurnId: "source-turn" },
      payload,
      maxQueueMs: 30_000,
      maxExecutionMs: 90_000,
    });

    const eventBus = createEventBus(store);
    const runtimeJobWorker = { wake: vi.fn(), close: vi.fn(), activeCount: 0 };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("store", store);
      c.set("eventBus", eventBus);
      c.set("sessionLock", createInProcessSessionLock());
      c.set("runtimeJobWorker", runtimeJobWorker);
      await next();
    });
    app.route("/api/sessions", runtimeJobRoutes);

    const listed = await app.request(
      "/api/sessions/runtime-job-session/runtime-jobs",
    );
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]).not.toHaveProperty("payload");

    const cancelled = await app.request(
      "/api/sessions/runtime-job-session/runtime-jobs/source-job/cancel",
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
    await expect(
      getRuntimeJob(store, {
        sessionId: session.id,
        pluginId: "media",
        jobId: "source-job",
      }),
    ).resolves.toMatchObject({ status: "cancelled" });

    const retried = await app.request(
      "/api/sessions/runtime-job-session/runtime-jobs/source-job/retry",
      { method: "POST" },
    );
    expect(retried.status).toBe(202);
    const retriedBody = (await retried.json()) as {
      jobId: string;
      status: string;
    };
    expect(retriedBody).toMatchObject({ status: "queued" });
    expect(retriedBody.jobId).not.toBe("source-job");
    expect(runtimeJobWorker.wake).toHaveBeenCalledOnce();
    await expect(
      store.listJobStatus(session.id, { jobId: retriedBody.jobId }),
    ).resolves.toMatchObject([{ state: "queued", sequence: 0 }]);
  });
});
