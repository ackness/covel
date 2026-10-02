import { requestJobServices } from "./plugin-rpc/settled-request.js";
import { Hono } from "hono";

import { errorBody, listBody } from "../../api-error.js";
import {
  createRuntimeJob,
  RuntimeJobSupersededError,
  listRuntimeJobs,
  transitionRuntimeJob,
  type RuntimeJobRecord,
} from "./plugin-rpc/jobs.js";
import {
  appendRuntimeJobStatus,
  makeRuntimeJobStatusRecord,
  parseActivatedRuntimeJobPayload,
  parseStagedRuntimeJobPayload,
  publishRuntimeJobStatusEvent,
  runtimeJobIncarnation,
  type ActivatedRuntimeJobPayload,
  type StagedRuntimeJobPayload,
} from "./plugin-rpc/runtime-job-worker.js";
import {
  resolveSessionParam,
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "./session/session-guard.js";
import type { RuntimeJobCredentialKey } from "./plugin-rpc/runtime-job-credentials.js";
import { publicRuntimeJob } from "./plugin-rpc/runtime-job-public.js";

export const runtimeJobRoutes = new Hono();

async function findJob(
  store: Parameters<typeof listRuntimeJobs>[0],
  sessionId: string,
  jobId: string,
): Promise<RuntimeJobRecord | undefined> {
  return (await listRuntimeJobs(store, { sessionId })).find(
    (job) => job.jobId === jobId,
  );
}

/**
 * Rebind a terminal job's frozen input to the live session for a new attempt.
 * A retry is a new execution: staged jobs get a new descriptor id, activated
 * jobs a new turn id.
 */
function retryPayload(
  prior: unknown,
  jobId: string,
  live: Pick<
    StagedRuntimeJobPayload,
    | "expectedSessionIncarnation"
    | "expectedApprovalScope"
    | "locale"
    | "runtimeModelOverrides"
  >,
): StagedRuntimeJobPayload | ActivatedRuntimeJobPayload | undefined {
  const staged = parseStagedRuntimeJobPayload(prior);
  if (staged) {
    const { runtimeModelOverrides: _prior, ...stable } = staged;
    return { ...stable, ...live, descriptor: { ...staged.descriptor, jobId } };
  }
  const activated = parseActivatedRuntimeJobPayload(prior);
  if (!activated) return undefined;
  const { runtimeModelOverrides: _prior, ...stable } = activated;
  return { ...stable, ...live, turnId: crypto.randomUUID() };
}

runtimeJobRoutes.get("/:id/runtime-jobs", async (c) => {
  const guard = await resolveSessionParam(c);
  if (!guard.ok) return guard.response;
  const jobs = await listRuntimeJobs(c.get("store"), {
    sessionId: guard.session.id,
  });
  return c.json(listBody(jobs.map(publicRuntimeJob)));
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
  const cancelledIncarnation = runtimeJobIncarnation(changed.payload);
  if (cancelledIncarnation)
    c.get("runtimeJobCredentials")?.discard({
      jobId,
      sessionId,
      expectedSessionIncarnation: cancelledIncarnation,
    });
  await appendRuntimeJobStatus(c.get("store"), eventBus, changed);
  return c.json(publicRuntimeJob(changed));
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
  let retryCredentialKey: RuntimeJobCredentialKey | undefined;
  const created = await c
    .get("sessionLock")
    .withLock(sessionId, async () => {
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
      const jobId = crypto.randomUUID();
      const payload = retryPayload(source.payload, jobId, {
        expectedSessionIncarnation: sessionIncarnationIdentity(live),
        expectedApprovalScope: sessionApprovalScope(live, source.pluginId),
        locale: live.locale,
        ...(live.runtimeModelOverrides
          ? { runtimeModelOverrides: live.runtimeModelOverrides }
          : {}),
      });
      if (!payload) return undefined;
      let queuedStatus:
        ReturnType<typeof makeRuntimeJobStatusRecord> | undefined;
      const job = await c.get("store").withTransaction(async (tx) => {
        const queued = await createRuntimeJob(tx, {
          jobId,
          sessionId,
          pluginId: source.pluginId,
          runtimeId: source.runtimeId,
          origin: source.origin,
          payload,
          ...(source.settle
            ? {
                settle: source.settle,
                maxSettleWaitMs: source.maxSettleWaitMs,
                retryOfJobId: source.jobId,
              }
            : {}),
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
        retryCredentialKey = {
          jobId,
          sessionId,
          expectedSessionIncarnation: payload.expectedSessionIncarnation,
        };
        const services = requestJobServices(c);
        if (services)
          c.get("runtimeJobCredentials")?.register(
            retryCredentialKey,
            services,
            source.maxQueueMs,
          );
        return queued;
      });
      return { job, status: queuedStatus! };
    })
    .catch((error: unknown) => {
      if (retryCredentialKey)
        c.get("runtimeJobCredentials")?.discard(retryCredentialKey);
      if (error instanceof RuntimeJobSupersededError) return undefined;
      throw error;
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
  return c.json(publicRuntimeJob(created.job), 202);
});
