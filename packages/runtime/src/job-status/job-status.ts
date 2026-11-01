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

import {
  jobOwnership,
  jobOwnershipData,
  type JobOwnership,
} from "./job-ownership.js";
import type { DataStore } from "@covel/store";
import type { EventBus } from "@covel/events";
import type { JobStatusRecord, JobStatusState, JsonValue } from "@covel/shared";
import { assertJsonValue } from "@covel/shared";
import type {
  ProgressEffect,
  ProgressReporter,
} from "@covel/shared/plugin-runtime";
import { emitSubEvent } from "../turn-executor/turn-runtime-helpers.js";
import {
  canonicalizeMediaRefs,
  type MediaOwnershipStore,
} from "../media/canonicalize-media-refs.js";

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
  /** The invocation that owns these tasks, retained across resumed attempts. */
  readonly ownership?: Omit<JobOwnership, "settled">;
  /**
   * Kernel-owned correlation fields merged into every emitted `data` value.
   * Detached stage workers use this to associate plugin-defined sub-jobs with
   * their durable parent job and source turn without letting handlers forge
   * that identity.
   */
  readonly contextData?: Readonly<Record<string, JsonValue>>;
  /**
   * MediaStore read surface: when present, `report` canonicalizes + ownership-
   * checks any MediaRef in the job `data` (docs 02 §2.1). A rejection throws
   * back to the handler. Absent (finalizer terminal writes, tests) ⇒ no media
   * processing — terminal job records carry no data anyway.
   */
  readonly mediaStore?: MediaOwnershipStore;
}

function buildRecord(
  deps: ProgressReporterDeps,
  effect: ProgressEffect,
): JobStatusRecord {
  const { sessionId, progressScopeId, pluginId, runtimeId } = deps;
  const data = deps.contextData
    ? effect.data &&
      typeof effect.data === "object" &&
      !Array.isArray(effect.data)
      ? { ...effect.data, ...deps.contextData }
      : {
          ...(effect.data !== undefined ? { payload: effect.data } : {}),
          ...deps.contextData,
        }
    : effect.data;
  return {
    sessionId,
    progressScopeId,
    pluginId,
    runtimeId,
    jobId: effect.jobId,
    state: effect.state,
    ...(effect.progress !== undefined ? { progress: effect.progress } : {}),
    ...(effect.message !== undefined ? { message: effect.message } : {}),
    ...(data !== undefined ? { data } : {}),
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
      let reportEffect = effect;
      if (effect.data !== undefined) {
        assertJsonValue(effect.data, "job data at data");
        if (deps.mediaStore) {
          const canon = await canonicalizeMediaRefs(effect.data as JsonValue, {
            store: deps.mediaStore,
            sessionId: deps.sessionId,
          });
          if (canon.rejections.length > 0) {
            throw new Error(
              `job data media rejected: ${canon.rejections
                .map((r) => `${r.id}:${r.reason}`)
                .join("; ")}`,
            );
          }
          reportEffect = { ...effect, data: canon.value };
        }
      }
      // Plugin data cannot forge the kernel owner or settlement provenance.
      if (
        reportEffect.data &&
        typeof reportEffect.data === "object" &&
        !Array.isArray(reportEffect.data)
      ) {
        const { _covel: _untrusted, ...data } = reportEffect.data as Record<
          string,
          JsonValue
        >;
        reportEffect = { ...reportEffect, data };
      }
      const record = buildRecord(
        {
          ...deps,
          ...(deps.ownership
            ? {
                contextData: {
                  ...deps.contextData,
                  ...jobOwnershipData({ ...deps.ownership, settled: false }),
                },
              }
            : {}),
        },
        reportEffect,
      );
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

/**
 * States that already represent a settled job. The finalizer leaves them alone,
 * except a claimed success whose writes did not commit, or a framework-owned
 * correction that a later attempt can settle again.
 */
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
 * itself completed is not overwritten, unless it reported `succeeded` and its
 * writes have not landed: the outcome is `failed`, the outcome is `suspended`
 * (a suspended runtime's writes are held until its suspension is resumed, and
 * an abandon discards them), or `rolledBack` says the commit was undone. Such
 * a job takes the mapped state instead, so a suspension chain's final resume
 * settles it once and an abandon cancels it. Framework-owned terminal
 * corrections can be replaced by a later attempt; plugin terminals cannot.
 *
 * Kernel-facing: called with the raw (un-revoked) store, unlike the plugin's
 * `ctx.progress`. `finalizeExecution` calls it once the domain outcome is known.
 */
export async function finalizeJobStatuses(
  deps: ProgressReporterDeps,
  {
    outcome,
    reportedJobs,
    rolledBack = false,
  }: {
    readonly outcome: ExecutionJobOutcome;
    readonly reportedJobs: readonly string[];
    /** The execution's writes were rolled back, whatever `outcome` maps to. */
    readonly rolledBack?: boolean;
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
    // Ordered by sequence ascending, so the tail is the latest.
    const latest = own.at(-1);
    if (!latest) continue;
    // A handler can report success before its writes reach commit. When they
    // did not land, or are held by a suspension, the state follows the save
    // result, not the claim.
    const claimedSuccessLost =
      latest.state === "succeeded" &&
      (target === "failed" || target === "waiting-input" || rolledBack);
    const owner = jobOwnership(latest);
    const frameworkOwned = owner?.settled === true;
    if (
      (TERMINAL_STATES.has(latest.state) &&
        !claimedSuccessLost &&
        !frameworkOwned) ||
      latest.state === target
    )
      continue;
    await appendAndEmit(
      deps,
      buildRecord(
        {
          ...deps,
          ...(owner
            ? { contextData: jobOwnershipData({ ...owner, settled: true }) }
            : {}),
        },
        {
          jobId,
          state: target,
          sequence: latest.sequence + 1,
        },
      ),
    );
  }
}
