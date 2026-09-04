import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createEventBus } from "@covel/events";
import { createMemoryStore } from "@covel/store";

import { createInProcessSessionLock } from "../../src/lib/session-lock.js";
import {
  createRuntimeJob,
  getRuntimeJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";
import type { StagedRuntimeJobPayload } from "../../src/routes/api/plugin-rpc/runtime-job-worker.js";
import { runtimeJobRoutes } from "../../src/routes/api/runtime-jobs.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../../src/routes/api/session/session-guard.js";

describe("runtime job control routes", () => {
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
      activePlugins: ["media"],
      metadata: {
        approvalScopeNonce: crypto.randomUUID(),
        sessionIncarnationNonce: crypto.randomUUID(),
      },
      createdAt: now,
      updatedAt: now,
    });
    const session = (await store.getSession("runtime-job-session"))!;
    const payload: StagedRuntimeJobPayload = {
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
        sourceExecutionStartedAt: now,
        pluginVersion: "1.0.0",
        upstreamResults: [],
      },
    };
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
