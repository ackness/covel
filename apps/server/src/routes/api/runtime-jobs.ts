import { Hono } from "hono";

import { errorBody } from "../../api-error.js";
import {
  createRuntimeJob,
  listRuntimeJobs,
  transitionRuntimeJob,
  type RuntimeJobRecord,
} from "./plugin-rpc/jobs.js";
import {
  appendRuntimeJobStatus,
  makeRuntimeJobStatusRecord,
  parseStagedRuntimeJobPayload,
  publishRuntimeJobStatusEvent,
  type StagedRuntimeJobPayload,
} from "./plugin-rpc/runtime-job-worker.js";
import {
  resolveSessionParam,
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";

export const runtimeJobRoutes = new Hono();

function publicRuntimeJob(
  job: RuntimeJobRecord,
): Omit<RuntimeJobRecord, "payload"> {
  const { payload: _payload, ...visible } = job;
  return visible;
}

async function findJob(
  store: Parameters<typeof listRuntimeJobs>[0],
  sessionId: string,
  jobId: string,
): Promise<RuntimeJobRecord | undefined> {
  return (await listRuntimeJobs(store, { sessionId })).find(
    (job) => job.jobId === jobId,
  );
}

runtimeJobRoutes.get("/:id/runtime-jobs", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const jobs = await listRuntimeJobs(c.get("store"), {
    sessionId: guard.session.id,
  });
  return c.json({ jobs: jobs.map(publicRuntimeJob) });
});

runtimeJobRoutes.post("/:id/runtime-jobs/:jobId/cancel", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const sessionId = guard.session.id;
  const jobId = c.req.param("jobId");
  const eventBus = c.get("eventBus");
  const changed = await c.get("sessionLock").withLock(sessionId, async () => {
    const job = await findJob(c.get("store"), sessionId, jobId);
    if (!job) return undefined;
    return transitionRuntimeJob(c.get("store"), {
      sessionId,
      pluginId: job.pluginId,
      jobId,
      from: ["queued", "claimed", "running"],
      to: "cancelled",
      reason: "cancelled-by-user",
    });
  });
  if (!changed) {
    return c.json(
      errorBody("Runtime job was not found or can no longer be cancelled", {
        code: "runtime_job_not_cancellable",
      }),
      409,
    );
  }
  await appendRuntimeJobStatus(c.get("store"), eventBus, changed);
  return c.json({ job: publicRuntimeJob(changed) });
});

runtimeJobRoutes.post("/:id/runtime-jobs/:jobId/retry", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  if (guard.session.status !== "active") {
    return c.json(
      errorBody(`Session is ${guard.session.status}; retry refused`, {
        code: "session_not_active",
      }),
      409,
    );
  }
  const sessionId = guard.session.id;
  const sourceJobId = c.req.param("jobId");
  const eventBus = c.get("eventBus");
  const created = await c.get("sessionLock").withLock(sessionId, async () => {
    const live = await c.get("store").getSession(sessionId);
    if (!live || live.status !== "active") return undefined;
    const source = await findJob(c.get("store"), sessionId, sourceJobId);
    if (
      !source ||
      !["failed", "timed_out", "cancelled", "stale", "orphaned"].includes(
        source.status,
      )
    ) {
      return undefined;
    }
    const priorPayload = parseStagedRuntimeJobPayload(source.payload);
    if (!priorPayload) return undefined;
    const jobId = crypto.randomUUID();
    const {
      runtimeModelOverrides: _priorRuntimeModelOverrides,
      ...stablePayload
    } = priorPayload;
    const payload: StagedRuntimeJobPayload = {
      ...stablePayload,
      descriptor: { ...priorPayload.descriptor, jobId },
      expectedSessionIncarnation: sessionIncarnationIdentity(live),
      expectedApprovalScope: sessionApprovalScope(live, source.pluginId),
      locale: live.locale,
      ...(live.runtimeModelOverrides
        ? { runtimeModelOverrides: live.runtimeModelOverrides }
        : {}),
    };
    let queuedStatus: ReturnType<typeof makeRuntimeJobStatusRecord> | undefined;
    const job = await c.get("store").withTransaction(async (tx) => {
      const queued = await createRuntimeJob(tx, {
        jobId,
        sessionId,
        pluginId: source.pluginId,
        runtimeId: source.runtimeId,
        origin: source.origin,
        payload,
        ...(source.maxQueueMs !== undefined
          ? { maxQueueMs: source.maxQueueMs }
          : {}),
        ...(source.maxExecutionMs !== undefined
          ? { maxExecutionMs: source.maxExecutionMs }
          : {}),
      });
      queuedStatus = makeRuntimeJobStatusRecord(queued, 0);
      if (!(await tx.appendJobStatus(queuedStatus))) {
        throw new Error(
          `could not append retry status for runtime job ${jobId}`,
        );
      }
      return queued;
    });
    return { job, status: queuedStatus! };
  });
  if (!created) {
    return c.json(
      errorBody("Runtime job was not found or is not retryable", {
        code: "runtime_job_not_retryable",
      }),
      409,
    );
  }
  publishRuntimeJobStatusEvent(eventBus, created.status);
  c.get("runtimeJobWorker")?.wake();
  return c.json({ job: publicRuntimeJob(created.job) }, 202);
});
