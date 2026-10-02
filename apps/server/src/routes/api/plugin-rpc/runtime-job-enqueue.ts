import type { JobStatusRecord } from "@covel/shared";
import {
  assertJsonValue,
  DEFAULT_LOCALE,
  getRuntimeSpec,
  type DeferredRuntimeJob,
  type RuntimeManifest,
} from "@covel/shared";
import type { SessionRecord, StoreTransaction } from "@covel/store";
import { createRuntimeJob, type RuntimeJobRecord } from "./jobs.js";
import {
  makeRuntimeJobStatusRecord,
  type ActivatedRuntimeJobPayload,
  type RuntimeJobTriggerEvent,
  type StagedRuntimeJobPayload,
} from "./runtime-job-worker.js";
import type { RuntimeJobCredentialKey } from "./runtime-job-credentials.js";
import {
  sessionApprovalScope,
  sessionIncarnationIdentity,
} from "../session/session-guard.js";

export interface QueuedRuntimeJob {
  readonly job: RuntimeJobRecord;
  readonly status: JobStatusRecord;
}

/**
 * Persist staged detached jobs inside the caller's commit transaction. Used by
 * the action that scheduled them and by the final resume of a suspended turn,
 * which releases the jobs that turn withheld. Job ids come from the source
 * execution.
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
    /** Hand request-scoped provider services to the worker for this job. */
    readonly registerCredentials?: (
      key: {
        readonly jobId: string;
        readonly sessionId: string;
        readonly expectedSessionIncarnation: string;
      },
      maxQueueMs: number | undefined,
    ) => void;
  },
): Promise<readonly QueuedRuntimeJob[]> {
  const queued: QueuedRuntimeJob[] = [];
  for (const descriptor of args.descriptors) {
    const target = args.activeRuntimes.find(
      (runtime) => runtime.name === descriptor.runtimeId,
    );
    if (!target || target.pluginId !== descriptor.pluginId) {
      if (args.skipInactive) continue;
      throw new Error(
        `detached runtime ${descriptor.runtimeId} left the active graph before enqueue`,
      );
    }
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
    const job = await createRuntimeJob(tx, {
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
      ...(policy.settle
        ? {
            settle: policy.settle,
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
    const status = makeRuntimeJobStatusRecord(job, 0);
    if (!(await tx.appendJobStatus(status))) {
      throw new Error(
        `could not append queued status for detached runtime job ${job.jobId}`,
      );
    }
    queued.push({ job, status });
    args.registerCredentials?.(
      {
        jobId: job.jobId,
        sessionId: args.sessionId,
        expectedSessionIncarnation: jobPayload.expectedSessionIncarnation,
      },
      policy.maxQueueMs,
    );
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
): Promise<
  QueuedRuntimeJob & { readonly credentialKey: RuntimeJobCredentialKey }
> {
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
  const status = makeRuntimeJobStatusRecord(job, 0);
  if (!(await tx.appendJobStatus(status))) {
    throw new Error(`could not append queued status for runtime job ${jobId}`);
  }
  return {
    job,
    status,
    credentialKey: {
      jobId,
      sessionId: args.sessionId,
      expectedSessionIncarnation: jobPayload.expectedSessionIncarnation,
    },
  };
}

export type QueuedActivatedRuntimeJob = Awaited<
  ReturnType<typeof enqueueActivatedRuntimeJob>
>;

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
): Promise<QueuedActivatedRuntimeJob[]> {
  if (args.followers.length === 0) return [];
  const session = await tx.getSession(args.sessionId);
  if (!session) throw new Error(`Session not found: ${args.sessionId}`);
  const queued: QueuedActivatedRuntimeJob[] = [];
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
