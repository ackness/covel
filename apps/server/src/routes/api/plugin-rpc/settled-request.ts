import type { Context } from "hono";
import type { RuntimeJobServices } from "./runtime-job-credentials.js";
import type { SettleWaitBudget } from "./settled-session-lock.js";
import { getRequestLlmOptions } from "../../../request-llm-context.js";
import { listRuntimeJobs } from "./jobs.js";
import {
  publishRuntimeJobStatusEvent,
  runtimeJobIncarnation,
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

/** Application entry only; worker commits and recovery use the raw lock. */
export async function withSettledSessionLock<T>(
  c: Context,
  sessionId: string,
  fn: () => Promise<T>,
  waitBudget?: SettleWaitBudget,
): Promise<T> {
  const provideCredentials = async () => {
    const services = requestJobServices(c);
    if (!services) return;
    const session = await c.get("store").getSession(sessionId);
    if (!session || checkSessionOwner(c, session)) return;
    const incarnation = sessionIncarnationIdentity(session);
    const queued = await listRuntimeJobs(c.get("store"), { sessionId });
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
    }
  };
  // Non-settling jobs also need request-only credentials after a restart.
  await provideCredentials();
  const settled = c.get("settledSessionLock");
  if (!settled) return c.get("sessionLock").withLock(sessionId, fn);
  return settled.withLock(
    sessionId,
    {
      waitBudget,
      signal: c.get("requestWork")?.signal ?? c.req.raw.signal,
      provideCredentials,
      onTimeout: async (info) => {
        await c.get("store").addTraceEvent({
          id: crypto.randomUUID(),
          sessionId,
          traceId: crypto.randomUUID(),
          turnId: "",
          type: "execution.settle-timeout",
          payload: info,
          createdAt: new Date().toISOString(),
        });
      },
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
  for (const { credentialKey, status } of queued) {
    if (services)
      c.get("runtimeJobCredentials")?.register(credentialKey, services);
    publishRuntimeJobStatusEvent(c.get("eventBus"), status);
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
  const eventBus = c.get("eventBus");
  for (const { job, status } of queued) {
    if (eventBus) publishRuntimeJobStatusEvent(eventBus, status);
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
      timestamp: new Date().toISOString(),
      payload: {
        ...payload,
        _subTopic: "runtime",
        _subType: "runtime.deferred",
      },
    });
  }
  for (const sessionId of new Set(queued.map(({ job }) => job.sessionId)))
    c.get("runtimeJobWorker")?.wake(sessionId);
}
