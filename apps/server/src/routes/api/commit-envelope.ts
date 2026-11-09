/**
 * Follow-up work queued inside an execution's commit transaction.
 *
 * Every host path that commits an execution's result settles the work it
 * derived (the detached stage jobs it deferred and the background event
 * followers it emitted) in the same transaction as its writes, so a
 * rolled-back commit queues nothing. A path queues that work, or, when its
 * runs cannot derive any, refuses it, so a commit that unexpectedly derived
 * some rolls back instead of losing it. Work derived from a runtime whose
 * writes were dropped at commit builds on output that never landed, so none
 * of it is queued. Those rules live here, for every path, instead of in each
 * route.
 *
 * Route-specific writes in the same transaction (the player's input message,
 * interjections) stay with their route.
 */

import {
  droppedEmitter,
  droppedUpstream,
  settleDroppedInputs,
  type CommitIsolation,
} from "@covel/runtime";
import type {
  DeferredRuntimeJob,
  RuntimeManifest,
  TurnResult,
} from "@covel/shared";
import type { SessionRecord, StoreTransaction } from "@covel/store";
import type { JobCredentialHandoff } from "./plugin-rpc/runtime-job-credentials.js";
import {
  enqueueDeferredRuntimeJobs,
  enqueueEventFollowers,
  type QueuedRuntimeJob,
} from "./plugin-rpc/runtime-job-enqueue.js";

type DeferredEnqueueArgs = Parameters<typeof enqueueDeferredRuntimeJobs>[1];
type FollowerEnqueueArgs = Parameters<typeof enqueueEventFollowers>[1];

/** What the jobs a commit queues inherit from the execution that queued them. */
export interface CommitEnqueueContext {
  readonly sessionId: string;
  /** The runtimes active for the execution, under the session lock. */
  readonly activeRuntimes: readonly RuntimeManifest[];
  /** The session's content locale. */
  readonly locale: string;
  readonly userSettings?: DeferredEnqueueArgs["userSettings"] &
    FollowerEnqueueArgs["userSettings"];
  /** The request's story model override, carried by deferred stage jobs. */
  readonly modelOverride?: string;
  /**
   * Hands the queuing owner's provider services to each stage job inside the
   * transaction; event followers are handed theirs once the commit landed.
   */
  readonly credentials?: Pick<JobCredentialHandoff, "register">;
  /** The runtime a manual or event activation ran, named by its followers. */
  readonly sourceRuntimeId?: string;
}

export type EventFollower = FollowerEnqueueArgs["followers"][number];

/** The parts of an execution's result its follow-up work comes from. */
export interface FollowUpSource {
  /** The execution's turn, named by its followers as their source. */
  readonly turnId: string;
  /** The execution's runtime results, as executed. */
  readonly runtimeResults: Parameters<typeof droppedEmitter>[1]["results"];
  /**
   * Detached stage jobs the execution deferred. They are admitted under the
   * session as the commit transaction reads it.
   */
  readonly deferredRuntimeJobs?: readonly DeferredRuntimeJob[];
  /** Background event followers the execution emitted. */
  readonly deferredFollowers?: readonly EventFollower[];
}

export interface CommitFollowUps extends CommitEnqueueContext {
  /** Which runtimes' writes the commit dropped. */
  readonly isolation: CommitIsolation;
  /** The committed execution's result. */
  readonly turnResult: FollowUpSource;
  /**
   * The followers to queue when not all the result emitted: none after an
   * activation that failed, which chains no followers.
   */
  readonly followers?: readonly EventFollower[];
}

export interface QueuedCommitFollowUps {
  readonly runtimeJobs: readonly QueuedRuntimeJob[];
  readonly followerJobs: readonly QueuedRuntimeJob[];
}

/** What a commit that queued nothing queued. */
export const NO_FOLLOW_UPS: QueuedCommitFollowUps = Object.freeze({
  runtimeJobs: [],
  followerJobs: [],
});

/**
 * Settles, inside a commit transaction, the follow-up work the committed
 * execution's result derived, and returns what it queued for announcement
 * after the commit. Every commit of an execution's result takes one: a host
 * queues the work ({@link queueFollowUpsWith}), or, where its runs derive
 * none, refuses it ({@link refuseFollowUps}).
 */
export type CommitFollowUpQueue = (
  tx: StoreTransaction,
  turnResult: TurnResult,
  isolation: CommitIsolation,
) => Promise<QueuedCommitFollowUps>;

/**
 * The follow-up queue of a host whose runs derive no follow-up work. A commit
 * whose result derived some rolls back instead of losing it.
 */
export const refuseFollowUps: CommitFollowUpQueue = async (_tx, turnResult) => {
  if (
    (turnResult.deferredRuntimeJobs?.length ?? 0) > 0 ||
    (turnResult.deferredFollowers?.length ?? 0) > 0
  ) {
    throw new Error(
      "cannot queue the detached jobs or event followers this commit derived: the host has no follow-up queue",
    );
  }
  return NO_FOLLOW_UPS;
};

/**
 * The follow-up queue of a host that queues, under `context`, the work every
 * committed result derived. `followers` narrows the followers to queue.
 */
export function queueFollowUpsWith(
  context: CommitEnqueueContext,
  followers?: (turnResult: TurnResult) => readonly EventFollower[],
): CommitFollowUpQueue {
  return (tx, turnResult, isolation) =>
    queueCommitFollowUps(tx, {
      ...context,
      isolation,
      turnResult,
      ...(followers ? { followers: followers(turnResult) } : {}),
    });
}

/** The session a commit queues detached jobs under is gone. */
export class CommitSessionGoneError extends Error {
  constructor(sessionId: string) {
    super(
      `Session ${sessionId} is gone; its commit cannot queue detached jobs`,
    );
    this.name = "CommitSessionGoneError";
  }
}

/**
 * Queue an execution's deferred stage jobs and event followers inside its
 * commit transaction, leaving out work derived from a dropped runtime. A
 * deferred job whose target hard-depends on a dropped runtime is not queued;
 * the others see dropped runtimes as failed in their frozen inputs. A
 * follower whose trigger event only dropped runtimes emitted is not queued.
 * Returns what was queued, for the caller to announce after the commit.
 * Throws {@link CommitSessionGoneError}, failing the commit, when there are
 * detached jobs to queue and the session is gone.
 */
export async function queueCommitFollowUps(
  tx: StoreTransaction,
  args: CommitFollowUps,
): Promise<QueuedCommitFollowUps> {
  // Jobs carry the incarnation, approval scope and runtime model overrides
  // of the session the commit lands in. Read before filtering, so whether a
  // commit with detached jobs fails does not depend on which were dropped.
  const deferredJobs = args.turnResult.deferredRuntimeJobs ?? [];
  let session: SessionRecord | undefined;
  if (deferredJobs.length > 0) {
    session = (await tx.getSession(args.sessionId)) ?? undefined;
    if (!session) throw new CommitSessionGoneError(args.sessionId);
  }
  const dropped = args.isolation.droppedRuntimeIds;
  const committedView = {
    runtimes: args.activeRuntimes,
    results: args.turnResult.runtimeResults,
    dropped,
  };
  const descriptors = deferredJobs
    .filter((descriptor) => {
      const target = args.activeRuntimes.find(
        (runtime) => runtime.name === descriptor.runtimeId,
      );
      return !target || !droppedUpstream(target, committedView);
    })
    .map((descriptor) => settleDroppedInputs(descriptor, dropped));
  const followers = (
    args.followers ??
    args.turnResult.deferredFollowers ??
    []
  ).filter(
    (follower) => !droppedEmitter(follower.triggerEvent.topic, committedView),
  );
  const runtimeJobs = session
    ? await enqueueDeferredRuntimeJobs(tx, {
        sessionId: args.sessionId,
        session,
        activeRuntimes: args.activeRuntimes,
        descriptors,
        locale: args.locale,
        ...(args.modelOverride ? { modelOverride: args.modelOverride } : {}),
        ...(args.userSettings ? { userSettings: args.userSettings } : {}),
        ...(args.credentials ? { credentials: args.credentials } : {}),
      })
    : [];
  const followerJobs = await enqueueEventFollowers(tx, {
    sessionId: args.sessionId,
    activeRuntimes: args.activeRuntimes,
    followers,
    sourceTurnId: args.turnResult.turnId,
    ...(args.sourceRuntimeId ? { sourceRuntimeId: args.sourceRuntimeId } : {}),
    locale: args.locale,
    ...(args.userSettings ? { userSettings: args.userSettings } : {}),
  });
  return { runtimeJobs, followerJobs };
}

/**
 * Queue the detached jobs a suspended turn held back, released when that turn
 * ends, inside the transaction that ends it. A runtime switched off since the
 * turn has no job to run, so its jobs are skipped instead of failing the
 * commit. Released jobs carry no request model override.
 */
export async function queueReleasedRuntimeJobs(
  tx: StoreTransaction,
  context: Omit<CommitEnqueueContext, "modelOverride" | "sourceRuntimeId"> & {
    readonly session: SessionRecord;
  },
  jobs: readonly DeferredRuntimeJob[],
): Promise<readonly QueuedRuntimeJob[]> {
  return enqueueDeferredRuntimeJobs(tx, {
    sessionId: context.sessionId,
    session: context.session,
    activeRuntimes: context.activeRuntimes,
    descriptors: jobs,
    locale: context.locale,
    ...(context.userSettings ? { userSettings: context.userSettings } : {}),
    skipInactive: true,
    ...(context.credentials ? { credentials: context.credentials } : {}),
  });
}
