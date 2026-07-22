/**
 * Kernel-owned, append-only job-status channel.
 *
 * This is the SOLE real-time exception to effects isolation: a long-running
 * function runtime (media generation, etc.) reports progress BEFORE its
 * finalizer runs. A progress report writes into the kernel job-status store and
 * immediately emits an SSE event — it never touches gameplay state, never
 * satisfies a binding/gate, and never rolls back with the domain transaction.
 * Domain writes still flow through the handler's return value / proposals.
 *
 * Identity binding: session / scope / plugin / runtime are injected by the
 * kernel at construction. A handler only supplies the job business fields
 * (jobId, state, progress, message, data, sequence), so it cannot forge another
 * plugin's — or another runtime's — job.
 */

import type { DataStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { JobStatusRecord, JobStatusState } from "@covel/shared";
import type { ProgressEffect, ProgressReporter } from "@covel/plugin-loader";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";

/** The out-of-band SSE event this channel emits (see COVEL_EVENT_META). */
const JOB_STATUS_EVENT = "job-status.updated";
const JOB_STATUS_TOPIC = "job";

export interface ProgressReporterDeps {
  readonly store: Pick<DataStore, "appendJobStatus" | "listJobStatus">;
  readonly eventBus?: EventBus;
  readonly sessionId: string;
  /** Progress scope this reporter writes under. Defaults to the executionId at the call site. */
  readonly progressScopeId: string;
  readonly pluginId: string;
  readonly runtimeId: string;
}

/**
 * Walk a value and throw if any node is not a JSON wire value. Cycle detection
 * is path-scoped (add on descent, remove on ascent), so a value shared by two
 * siblings is allowed — only a true back-reference is rejected.
 */
function assertJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`job data at ${path} is a non-finite number`);
    }
    return;
  }
  if (kind !== "object") {
    // undefined, function, symbol, bigint
    throw new Error(`job data at ${path} is not JSON-serialisable (${kind})`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new Error(`job data at ${path} is circular`);
  seen.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertJsonValue(v, `${path}[${i}]`, seen));
  } else {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      assertJsonValue(v, `${path}.${k}`, seen);
    }
  }
  seen.delete(obj);
}

function buildRecord(
  deps: ProgressReporterDeps,
  effect: ProgressEffect,
): JobStatusRecord {
  const { sessionId, progressScopeId, pluginId, runtimeId } = deps;
  return {
    sessionId,
    progressScopeId,
    pluginId,
    runtimeId,
    jobId: effect.jobId,
    state: effect.state,
    ...(effect.progress !== undefined ? { progress: effect.progress } : {}),
    ...(effect.message !== undefined ? { message: effect.message } : {}),
    ...(effect.data !== undefined ? { data: effect.data } : {}),
    sequence: effect.sequence,
    createdAt: new Date().toISOString(),
  };
}

async function appendAndEmit(
  deps: ProgressReporterDeps,
  record: JobStatusRecord,
): Promise<boolean> {
  const inserted = await deps.store.appendJobStatus(record);
  if (!inserted) return false;
  emitSubEvent(
    deps.eventBus,
    JOB_STATUS_TOPIC,
    JOB_STATUS_EVENT,
    deps.sessionId,
    {
      ...record,
    },
  );
  return true;
}

export function createProgressReporter(
  deps: ProgressReporterDeps,
): ProgressReporter {
  return {
    async report(effect: ProgressEffect): Promise<void> {
      if (effect.data !== undefined) {
        assertJsonValue(effect.data, "data", new Set());
      }
      const record = buildRecord(deps, effect);
      const inserted = await appendAndEmit(deps, record);
      if (!inserted) {
        console.debug(
          `[job-status] dropped duplicate/older sequence ${effect.sequence} for job ${effect.jobId}`,
        );
      }
    },
  };
}

/** Outcome of one execution, as the finalizer sees it. */
export type ExecutionJobOutcome =
  "success" | "failed" | "skipped" | "suspended";

const OUTCOME_TO_STATE: Readonly<Record<ExecutionJobOutcome, JobStatusState>> =
  {
    success: "succeeded",
    failed: "failed",
    skipped: "cancelled",
    suspended: "waiting-input",
  };

/** States that already represent a settled job; the finalizer leaves them alone. */
const TERMINAL_STATES: ReadonlySet<JobStatusState> = new Set([
  "succeeded",
  "failed",
  "cancelled",
]);

/**
 * Terminalise every job this execution reported that is still un-settled,
 * mapping the execution `outcome` onto a final job state. For each job the new
 * event's `sequence` is the highest already-committed sequence plus one, so it
 * appends cleanly onto the existing stream. Jobs already in a terminal state
 * (or already in the mapped target state) are skipped — a job the handler
 * itself completed is not overwritten.
 *
 * Kernel-facing: called with the raw (un-revoked) store, unlike the plugin's
 * `ctx.progress`. Only export-only for now — the finalizer wiring lands later.
 */
export async function finalizeJobStatuses(
  deps: ProgressReporterDeps,
  {
    outcome,
    reportedJobs,
  }: {
    readonly outcome: ExecutionJobOutcome;
    readonly reportedJobs: readonly string[];
  },
): Promise<void> {
  const target = OUTCOME_TO_STATE[outcome];
  for (const jobId of new Set(reportedJobs)) {
    const events = await deps.store.listJobStatus(deps.sessionId, {
      progressScopeId: deps.progressScopeId,
      jobId,
    });
    // listJobStatus filters by (scope, job) but not plugin/runtime; a shared
    // scope could carry a sibling runtime's job under the same id, so narrow to
    // this reporter's own identity before deciding.
    const own = events.filter(
      (e) => e.pluginId === deps.pluginId && e.runtimeId === deps.runtimeId,
    );
    if (own.length === 0) continue;
    // Ordered by sequence ascending, so the tail is the latest.
    const latest = own[own.length - 1];
    if (TERMINAL_STATES.has(latest.state) || latest.state === target) continue;
    await appendAndEmit(
      deps,
      buildRecord(deps, {
        jobId,
        state: target,
        sequence: latest.sequence + 1,
      }),
    );
  }
}
