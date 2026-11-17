import type { EventBus } from "@covel/events";
import type { DataStore, SuspensionRecord } from "@covel/store";
import type { RuntimeResult } from "@covel/shared";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import {
  finalizeJobStatuses,
  type ExecutionJobOutcome,
} from "../job-status/job-status.js";
import { jobOwnership } from "../job-status/job-ownership.js";
import { suspensionProgressScopeId } from "./suspension-progress-scope.js";

export type LifecycleCorrectionType =
  "runtime.completed" | "runtime.failed" | "runtime.skipped";
export interface SavedLifecycleDeps {
  readonly store: Pick<
    DataStore,
    "appendJobStatus" | "listJobStatus" | "queryTraceEvents" | "addTraceEvent"
  >;
  readonly eventBus?: EventBus;
  /** Action streams own lifecycle forwarding; this callback never records again. */
  readonly onRuntimeCorrection?: (
    type: LifecycleCorrectionType,
    payload: Record<string, unknown>,
  ) => void | Promise<void>;
}

/** The original invocation a suspension continues. */
export function savedMember(suspension: SuspensionRecord) {
  return {
    pluginId: suspension.pluginId,
    runtimeId: suspension.runtimeId,
    turnId: suspension.turnId,
    runId: suspension.pendingContinuation.lifecycle.runId,
    progressRunId: suspension.pendingContinuation.lifecycle.progressRunId,
    durationMs: 0,
  };
}

/** Persist the new effective status, then deliver it once to each transport. */
export function correctSavedLifecycle(
  deps: SavedLifecycleDeps,
  suspension: SuspensionRecord,
  status: ExecutionJobOutcome,
): Promise<void> {
  return correctRuntimeLifecycle(
    deps,
    suspension.sessionId,
    savedMember(suspension),
    status,
  );
}

/** Correct one original invocation without replaying its computation or hooks. */
export async function correctRuntimeLifecycle(
  deps: SavedLifecycleDeps,
  sessionId: string,
  member: Pick<RuntimeResult, "pluginId" | "runtimeId" | "turnId" | "runId"> & {
    readonly durationMs?: number;
  },
  status: ExecutionJobOutcome,
): Promise<void> {
  const type =
    status === "failed"
      ? "runtime.failed"
      : status === "skipped"
        ? "runtime.skipped"
        : "runtime.completed";
  const history = await deps.store.queryTraceEvents(sessionId, {
    turnId: member.turnId,
    types: ["runtime.completed", "runtime.failed", "runtime.skipped"],
    newestFirst: true,
  });
  const latest = history.find((row) => {
    const payload = row.payload as Partial<RuntimeResult>;
    return (
      payload.pluginId === member.pluginId &&
      payload.runtimeId === member.runtimeId &&
      payload.runId === member.runId
    );
  });
  if ((latest?.payload as { status?: string } | undefined)?.status === status)
    return;
  const payload = {
    pluginId: member.pluginId,
    runtimeId: member.runtimeId,
    turnId: member.turnId,
    runId: member.runId,
    durationMs: member.durationMs ?? 0,
    status,
    // Fixed text is safe even when the original runtime was concealed or removed.
    ...(status === "failed"
      ? { error: "The enclosing execution could not commit saved work" }
      : {}),
    ...(status === "skipped" ? { reason: "suspension-abandoned" } : {}),
  };
  await deps.store.addTraceEvent({
    id: crypto.randomUUID(),
    sessionId,
    turnId: member.turnId,
    traceId: member.turnId,
    type,
    payload,
    createdAt: new Date(
      Math.max(Date.now(), latest ? Date.parse(latest.createdAt) + 1 : 0),
    ).toISOString(),
  });
  const deliveries = await Promise.allSettled([
    Promise.resolve().then(() =>
      emitSubEvent(deps.eventBus, "runtime", type, sessionId, payload),
    ),
    Promise.resolve().then(() => deps.onRuntimeCorrection?.(type, payload)),
  ]);
  const failures = deliveries.flatMap((delivery) =>
    delivery.status === "rejected" ? [delivery.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Lifecycle delivery failed");
}

/** Select exact invocation owners, never every task sharing a runtime ID. */
export async function settleSavedJobs(
  deps: SavedLifecycleDeps,
  suspension: SuspensionRecord,
  outcome: ExecutionJobOutcome,
  attemptId?: string,
): Promise<void> {
  const progressScopeId = suspensionProgressScopeId(
    suspension.pendingContinuation,
  );
  const member = savedMember(suspension);
  const reported = await deps.store.listJobStatus(suspension.sessionId, {
    progressScopeId,
  });
  const latest = new Map<string, (typeof reported)[number]>();
  for (const row of reported)
    latest.set(JSON.stringify([row.pluginId, row.runtimeId, row.jobId]), row);
  for (const row of latest.values()) {
    const owner = jobOwnership(row);
    if (
      !owner ||
      ((member.pluginId !== row.pluginId ||
        member.runtimeId !== row.runtimeId ||
        member.progressRunId !== owner.runId) &&
        owner.attemptId !== attemptId)
    )
      continue;
    await finalizeJobStatuses(
      {
        store: deps.store,
        eventBus: deps.eventBus,
        sessionId: suspension.sessionId,
        progressScopeId,
        pluginId: row.pluginId,
        runtimeId: row.runtimeId,
      },
      {
        outcome,
        reportedJobs: [row.jobId],
        rolledBack: outcome === "failed" || outcome === "skipped",
      },
    );
  }
}

export async function settleSavedWork(
  deps: SavedLifecycleDeps,
  suspension: SuspensionRecord,
  outcome: ExecutionJobOutcome,
  attemptId?: string,
): Promise<void> {
  // Reporting never changes domain commit/claim semantics.
  try {
    await settleSavedJobs(deps, suspension, outcome, attemptId);
  } catch (error) {
    console.warn("[suspension] progress settlement failed:", error);
  }
  try {
    await correctSavedLifecycle(deps, suspension, outcome);
  } catch (error) {
    console.warn("[suspension] lifecycle settlement failed:", error);
  }
}
