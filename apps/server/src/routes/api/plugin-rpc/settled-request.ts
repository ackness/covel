import type { Context } from "hono";
import type { RuntimeJobServices } from "./runtime-job-credentials.js";
import type { SettleWaitBudget } from "./settled-session-lock.js";
import { hasResolvedRuntimeJobCredentials } from "../../../runtime-job-readiness.js";
import { getRequestLlmOptions } from "../../../request-llm-context.js";
import { listRuntimeJobs } from "./jobs.js";
import {
  publishRuntimeJobStatusEvent,
  runtimeJobIncarnation,
} from "./runtime-job-worker.js";
import type { QueuedActivatedRuntimeJob } from "./runtime-job-enqueue.js";
import {
  checkSessionOwner,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";

export function requestJobServices(c: Context): RuntimeJobServices | undefined {
  // An ordinary HTTP request does not establish usable model credentials.
  // Default adapters are admitted separately by the server readiness callback.
  if (!c.get("requestLlmOverridden")) return undefined;
  const gateway = c.get("pluginGateway");
  return {
    canRun: (model) => {
      try {
        return hasResolvedRuntimeJobCredentials(
          gateway?.resolveSlot({ presetId: model }),
        );
      } catch {
        return false;
      }
    },
    llm: c.get("llmAdapter"),
    gateway: c.get("pluginGateway"),
    compactor: c.get("compactorRunner"),
    llmOptions: getRequestLlmOptions(),
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
  locale?: string,
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
      return snapshot ? snapshot(sessionId, fn, undefined, locale) : fn();
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
  c.get("runtimeJobWorker")?.wake();
}
