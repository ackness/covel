import {
  finalizePresentationJobs,
  unavailablePresentationJob,
} from "@covel/runtime";
import type { JobStatusRecord } from "@covel/shared";
import {
  assertJsonValue,
  DEFAULT_LOCALE,
  getRuntimeSpec,
  type DeferredRuntimeJob,
  type RuntimeManifest,
} from "@covel/shared";
import type { SessionRecord, StoreTransaction } from "@covel/store";
import {
  createRuntimeJob,
  RuntimeJobQueueFullError,
  type RuntimeJobRecord,
} from "./jobs.js";
import {
  makeRuntimeJobStatusRecord,
  type ActivatedRuntimeJobPayload,
  type RuntimeJobTriggerEvent,
  type StagedRuntimeJobPayload,
} from "./runtime-job-worker.js";
import type {
  JobCredentialHandoff,
  RuntimeJobCredentialKey,
} from "./runtime-job-credentials.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";

/** A job queued in the caller's transaction, announced once it commits. */
export interface QueuedRuntimeJob {
  readonly job: RuntimeJobRecord;
  readonly status: JobStatusRecord;
  /** Names the job's request-scoped provider services in the hand-off. */
  readonly credentialKey: RuntimeJobCredentialKey;
}

/** How a response or job result names the jobs a commit queued. */
export function deferredJobRefs(
  queued: readonly QueuedRuntimeJob[],
): { readonly jobId: string; readonly runtimeId: string }[] {
  return queued.map(({ job }) => ({
    jobId: job.jobId,
    runtimeId: job.runtimeId,
  }));
}

async function appendQueuedStatus(
  tx: StoreTransaction,
  job: RuntimeJobRecord,
  expectedSessionIncarnation: string,
  label: string,
): Promise<QueuedRuntimeJob> {
  const status = makeRuntimeJobStatusRecord(job, 0);
  if (!(await tx.appendJobStatus(status))) {
    throw new Error(`could not append queued status for ${label} ${job.jobId}`);
  }
  return {
    job,
    status,
    credentialKey: {
      jobId: job.jobId,
      sessionId: job.sessionId,
      expectedSessionIncarnation,
    },
  };
}

/**
 * Persist staged detached jobs inside the caller's commit transaction. Commit
 * paths reach it through `commit-envelope.ts`: for the jobs an execution
 * deferred, and for the jobs a suspended turn withheld once that turn ends.
 * Job ids come from the source execution.
 */
export async function enqueueDeferredRuntimeJobs(
  tx: StoreTransaction,
  args: {
    readonly sessionId: string;
    readonly session: SessionRecord;
    readonly activeRuntimes: readonly RuntimeManifest[];
    readonly descriptors: readonly DeferredRuntimeJob[];
    readonly locale: string;
    readonly modelOverride?: string;
    readonly userSettings?: StagedRuntimeJobPayload["userSettings"];
    /**
     * Skip descriptors whose runtime is no longer active instead of failing
     * the commit — for jobs released after the turn that scheduled them.
     */
    readonly skipInactive?: boolean;
    /** Hands request-scoped provider services to each job as it is queued. */
    readonly credentials?: Pick<JobCredentialHandoff, "register">;
  },
): Promise<readonly QueuedRuntimeJob[]> {
  const queued: QueuedRuntimeJob[] = [];
  for (const descriptor of await finalizePresentationJobs(
    tx,
    args.sessionId,
    args.descriptors,
    args.activeRuntimes,
    true,
  )) {
    const target = args.activeRuntimes.find(
      (runtime) => runtime.name === descriptor.runtimeId,
    );
    if (!target || target.pluginId !== descriptor.pluginId) {
      if (args.skipInactive) continue;
      throw new Error(
        `detached runtime ${descriptor.runtimeId} left the active graph before enqueue`,
      );
    }
    if (target.presentation && !descriptor.presentation?.committed) continue;
    const policy = getRuntimeSpec(target).turnCompletionPolicy;
    const jobPayload: StagedRuntimeJobPayload = {
      schemaVersion: 1,
      descriptor,
      expectedSessionIncarnation: sessionIncarnationIdentity(args.session),
      expectedApprovalScope: sessionApprovalScope(
        args.session,
        descriptor.pluginId,
      ),
      locale: args.locale,
      ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
      ...(args.session.runtimeModelOverrides
        ? { runtimeModelOverrides: args.session.runtimeModelOverrides }
        : {}),
      ...(args.userSettings ? { userSettings: args.userSettings } : {}),
    };
    assertJsonValue(jobPayload, `detached runtime job ${descriptor.jobId}`);
    let job: RuntimeJobRecord;
    try {
      job = await createRuntimeJob(tx, {
        jobId: descriptor.jobId,
        sessionId: args.sessionId,
        pluginId: descriptor.pluginId,
        runtimeId: descriptor.runtimeId,
        origin: {
          activation: "stage",
          sourceTurnId: descriptor.sourceTurnId,
          sourceExecutionId: descriptor.sourceExecutionId,
          sourceRuntimeId: descriptor.runtimeId,
        },
        payload: jobPayload,
        // The job record names the barrier it holds.
        ...(policy.settle
          ? {
              settle: "before-next-execution" as const,
              maxSettleWaitMs: policy.maxSettleWaitMs,
            }
          : {}),
        ...(policy.maxQueueMs !== undefined
          ? { maxQueueMs: policy.maxQueueMs }
          : {}),
        ...(policy.maxExecutionMs !== undefined
          ? { maxExecutionMs: policy.maxExecutionMs }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof RuntimeJobQueueFullError) || !target.presentation)
        throw error;
      await unavailablePresentationJob(tx, args.sessionId, descriptor);
      continue;
    }
    const queuedJob = await appendQueuedStatus(
      tx,
      job,
      jobPayload.expectedSessionIncarnation,
      "detached runtime job",
    );
    queued.push(queuedJob);
    args.credentials?.register(queuedJob);
  }
  return queued;
}

/**
 * Queue a background manual or event activation inside the caller's
 * transaction. Status publication and the worker wake belong to the caller,
 * after the transaction commits.
 */
export async function enqueueActivatedRuntimeJob(
  tx: StoreTransaction,
  args: {
    readonly sessionId: string;
    readonly session: SessionRecord;
    readonly pluginId: string;
    readonly runtimeId: string;
    readonly activation: ActivatedRuntimeJobPayload["activation"];
    /** The execution that requested or emitted this activation. */
    readonly sourceTurnId: string;
    readonly sourceRuntimeId?: string;
    readonly locale: string | undefined;
    readonly userSettings?: ActivatedRuntimeJobPayload["userSettings"];
    readonly input?: unknown;
    readonly retryFromTurnId?: string;
    readonly triggerEvent?: RuntimeJobTriggerEvent;
    readonly expectFollower?: boolean;
    readonly jobId?: string;
    readonly turnId?: string;
  },
): Promise<QueuedRuntimeJob> {
  const jobId = args.jobId ?? crypto.randomUUID();
  const jobPayload: ActivatedRuntimeJobPayload = {
    schemaVersion: 1,
    activation: args.activation,
    turnId: args.turnId ?? crypto.randomUUID(),
    expectedSessionIncarnation: sessionIncarnationIdentity(args.session),
    expectedApprovalScope: sessionApprovalScope(args.session, args.pluginId),
    locale: args.locale ?? DEFAULT_LOCALE,
    ...(args.session.runtimeModelOverrides
      ? { runtimeModelOverrides: args.session.runtimeModelOverrides }
      : {}),
    ...(args.userSettings ? { userSettings: args.userSettings } : {}),
    ...(args.input !== undefined ? { input: args.input } : {}),
    ...(args.retryFromTurnId ? { retryFromTurnId: args.retryFromTurnId } : {}),
    ...(args.triggerEvent ? { triggerEvent: args.triggerEvent } : {}),
    ...(args.expectFollower ? { expectFollower: true } : {}),
  };
  assertJsonValue(jobPayload, `${args.activation} runtime job ${jobId}`);
  const job = await createRuntimeJob(tx, {
    jobId,
    sessionId: args.sessionId,
    pluginId: args.pluginId,
    runtimeId: args.runtimeId,
    origin: {
      activation: args.activation,
      sourceTurnId: args.sourceTurnId,
      ...(args.sourceRuntimeId
        ? { sourceRuntimeId: args.sourceRuntimeId }
        : {}),
    },
    payload: jobPayload,
  });
  return appendQueuedStatus(
    tx,
    job,
    jobPayload.expectedSessionIncarnation,
    "runtime job",
  );
}

/**
 * Queue the background followers an execution emitted, inside its commit
 * transaction, so they exist exactly when the writes they react to do.
 * Followers whose runtime left the active set are dropped.
 */
export async function enqueueEventFollowers(
  tx: StoreTransaction,
  args: {
    readonly sessionId: string;
    readonly activeRuntimes: readonly RuntimeManifest[];
    readonly followers: readonly {
      readonly runtimeId: string;
      readonly pluginId: string;
      readonly triggerEvent: RuntimeJobTriggerEvent;
    }[];
    readonly sourceTurnId: string;
    readonly sourceRuntimeId?: string;
    readonly locale: string | undefined;
    readonly userSettings?: ActivatedRuntimeJobPayload["userSettings"];
  },
): Promise<QueuedRuntimeJob[]> {
  if (args.followers.length === 0) return [];
  const session = await tx.getSession(args.sessionId);
  if (!session) throw new Error(`Session not found: ${args.sessionId}`);
  const queued: QueuedRuntimeJob[] = [];
  for (const follower of args.followers) {
    if (
      !args.activeRuntimes.some(
        (runtime) =>
          runtime.name === follower.runtimeId &&
          runtime.pluginId === follower.pluginId,
      )
    )
      continue;
    queued.push(
      await enqueueActivatedRuntimeJob(tx, {
        sessionId: args.sessionId,
        session,
        pluginId: follower.pluginId,
        runtimeId: follower.runtimeId,
        activation: "event",
        sourceTurnId: args.sourceTurnId,
        ...(args.sourceRuntimeId
          ? { sourceRuntimeId: args.sourceRuntimeId }
          : {}),
        locale: args.locale,
        ...(args.userSettings ? { userSettings: args.userSettings } : {}),
        triggerEvent: follower.triggerEvent,
      }),
    );
  }
  return queued;
}
