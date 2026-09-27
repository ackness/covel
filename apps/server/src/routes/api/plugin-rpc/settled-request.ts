import type { Context } from "hono";
import type { RuntimeJobServices } from "./runtime-job-credentials.js";
import { hasResolvedRuntimeJobCredentials } from "../../../runtime-job-readiness.js";
import { listRuntimeJobs } from "./jobs.js";
import { parseStagedRuntimeJobPayload } from "./runtime-job-worker.js";
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
  };
}

/** Application entry only; worker commits and recovery use the raw lock. */
export async function withSettledSessionLock<T>(
  c: Context,
  sessionId: string,
  fn: () => Promise<T>,
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
      const payload = parseStagedRuntimeJobPayload(job.payload);
      if (payload?.expectedSessionIncarnation !== incarnation) continue;
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
): Promise<T> {
  return withSettledSessionLock(c, sessionId, async () => {
    const session = await c.get("store").getSession(sessionId);
    if (session)
      c.get("pluginRegistry")?.syncSessionActivations(
        sessionId,
        session.activePlugins,
      );
    const snapshot = c.get("withPluginSnapshot");
    return snapshot ? snapshot(sessionId, fn) : fn();
  });
}
