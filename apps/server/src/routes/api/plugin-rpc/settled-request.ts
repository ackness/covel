import { createHash } from "node:crypto";
import type { Context } from "hono";
import type { RuntimeJobServices } from "./runtime-job-credentials.js";
import {
  withAbortableLock,
  type SettleWaitBudget,
} from "./settled-session-lock.js";
import { getRequestLlmOptions } from "../../../request-llm-context.js";
import { listRuntimeJobs } from "./jobs.js";
import type { EventBus } from "@covel/events";
import {
  publishRuntimeJobStatusEvent,
  runtimeJobIncarnation,
  type RuntimeJobWorker,
} from "./runtime-job-worker.js";
import type {
  QueuedActivatedRuntimeJob,
  QueuedRuntimeJob,
} from "./runtime-job-enqueue.js";
import {
  checkSessionOwner,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";

export function requestJobServices(c: Context): RuntimeJobServices | undefined {
  // An ordinary HTTP request does not establish usable model credentials.
  // Default adapters are admitted separately by the server readiness callback.
  const canRun = c.get("requestRuntimeJobReady");
  if (!c.get("requestLlmOverridden") || !canRun) return undefined;
  return {
    canRun,
    llmOptions: getRequestLlmOptions(),
    llm: c.get("llmAdapter"),
    gateway: c.get("pluginGateway"),
    compactor: c.get("compactorRunner"),
  };
}

/**
 * Hand this request's provider credentials to the session's queued jobs. A job
 * queued by a request whose credentials did not survive a restart runs only
 * once a later request of the session's owner brings them. Returns how many
 * jobs received them.
 */
export async function provideRequestJobCredentials(
  c: Context,
  sessionId: string,
): Promise<number> {
  const services = requestJobServices(c);
  if (!services) return 0;
  const session = await c.get("store").getSession(sessionId);
  if (!session || checkSessionOwner(c, session)) return 0;
  const incarnation = sessionIncarnationIdentity(session);
  const queued = await listRuntimeJobs(c.get("store"), { sessionId });
  let provided = 0;
  for (const job of queued) {
    if (job.status !== "queued") continue;
    if (runtimeJobIncarnation(job.payload) !== incarnation) continue;
    c.get("runtimeJobCredentials")?.register(
      {
        jobId: job.jobId,
        sessionId,
        expectedSessionIncarnation: incarnation,
      },
      services,
      job.maxQueueMs,
    );
    provided += 1;
  }
  return provided;
}

/** Application entry only; worker commits and recovery use the raw lock. */
export async function withSettledSessionLock<T>(
  c: Context,
  sessionId: string,
  fn: () => Promise<T>,
  waitBudget?: SettleWaitBudget,
  /** Also ends the wait, e.g. the player stopping the action. */
  stopSignal?: AbortSignal,
): Promise<T> {
  const provideCredentials = async () => {
    await provideRequestJobCredentials(c, sessionId);
  };
  const recordSettleTrace = async (type: string, payload: object) => {
    await c.get("store").addTraceEvent({
      id: crypto.randomUUID(),
      sessionId,
      traceId: crypto.randomUUID(),
      turnId: "",
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  };
  const hostSignal = c.get("requestWork")?.signal ?? c.req.raw.signal;
  // Non-settling jobs also need request-only credentials after a restart.
  await provideCredentials();
  const settled = c.get("settledSessionLock");
  if (!settled)
    return withAbortableLock(c.get("sessionLock"), sessionId, stopSignal, fn);
  return settled.withLock(
    sessionId,
    {
      waitBudget,
      signal: stopSignal
        ? AbortSignal.any([hostSignal, stopSignal])
        : hostSignal,
      provideCredentials,
      onTimeout: (info) => recordSettleTrace("execution.settle-timeout", info),
      // A job no usable model can serve is not waited for; say why in the trace.
      onSkipped: (info) =>
        recordSettleTrace("execution.settle-skipped", {
          ...info,
          reason: "not-runnable",
        }),
    },
    fn,
  );
}

/** Freeze entry registrations and runtime artifacts only after the settle barrier. */
export async function withSettledExecutionLock<T>(
  c: Context,
  sessionId: string,
  fn: () => Promise<T>,
  waitBudget?: SettleWaitBudget,
  stopSignal?: AbortSignal,
): Promise<T> {
  return withSettledSessionLock(
    c,
    sessionId,
    async () => {
      const session = await c.get("store").getSession(sessionId);
      if (session)
        c.get("pluginRegistry")?.syncSessionActivations(
          sessionId,
          session.activePlugins,
        );
      const snapshot = c.get("withPluginSnapshot");
      return snapshot ? snapshot(sessionId, fn) : fn();
    },
    waitBudget,
    stopSignal,
  );
}

/**
 * After the transaction that queued them commits: hand this request's provider
 * credentials to the worker, publish the queued status, and wake the worker.
 */
export function announceQueuedRuntimeJobs(
  c: Context,
  queued: readonly QueuedActivatedRuntimeJob[],
): void {
  if (queued.length === 0) return;
  const services = requestJobServices(c);
  for (const { credentialKey, status, job } of queued) {
    if (services)
      c.get("runtimeJobCredentials")?.register(credentialKey, services);
    publishRuntimeJobStatusEvent(
      c.get("eventBus"),
      status,
      runtimeJobIncarnation(job.payload),
    );
  }
  for (const sessionId of new Set(queued.map(({ job }) => job.sessionId)))
    c.get("runtimeJobWorker")?.wake(sessionId);
}

/** Announce detached stage jobs only after the transaction that queued them. */
export async function announceDeferredRuntimeJobs(
  c: Context,
  queued: readonly QueuedRuntimeJob[],
  writeEvent?: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  await publishDeferredRuntimeJobs(
    { eventBus: c.get("eventBus"), worker: c.get("runtimeJobWorker") },
    queued,
    writeEvent,
  );
}

/**
 * The request-free half of {@link announceDeferredRuntimeJobs}, also used by
 * the suspension expiry sweep, which runs outside any request.
 */
export async function publishDeferredRuntimeJobs(
  deps: {
    readonly eventBus: EventBus | undefined;
    readonly worker: Pick<RuntimeJobWorker, "wake"> | undefined;
  },
  queued: readonly QueuedRuntimeJob[],
  writeEvent?: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { eventBus } = deps;
  for (const { job, status } of queued) {
    const incarnation = runtimeJobIncarnation(job.payload);
    if (!incarnation)
      throw new Error("Deferred job is missing its session incarnation");
    if (eventBus) publishRuntimeJobStatusEvent(eventBus, status, incarnation);
    const payload = {
      runtimeId: job.runtimeId,
      pluginId: job.pluginId,
      jobId: job.jobId,
      sourceTurnId: job.origin.sourceTurnId,
    };
    await writeEvent?.(payload);
    eventBus?.emit({
      id: crypto.randomUUID(),
      type: "event",
      topic: "runtime",
      sessionId: job.sessionId,
      sessionIncarnation: createHash("sha256")
        .update(incarnation)
        .digest("hex"),
      timestamp: new Date().toISOString(),
      payload: {
        ...payload,
        _subTopic: "runtime",
        _subType: "runtime.deferred",
      },
    });
  }
  for (const sessionId of new Set(queued.map(({ job }) => job.sessionId)))
    deps.worker?.wake(sessionId);
}
